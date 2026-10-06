# Test App (`packages/test-app`)

## What this is

`test-app` is a small playground and integration test environment for **DappFence**. It exists to
make browser behavior repeatable and testable, especially around **Service Worker** flows.

Use it to:

-   serve predictable HTML/JS fixtures over HTTP
-   exercise different DappFence loading scenarios
-   run end-to-end checks in real browsers with **Playwright**

If you're working on DappFence behavior in the browser (and anything SW-related), this package is
the fastest way to reproduce and validate changes.

---

## Project layout (high level)

-   `test/` - Playwright tests and scenario-specific projects
-   `template/` - HTML templates used to build scenario pages
-   `assets/` - shared JS/assets copied into the served output
-   `src/` - build scripts and dev server that serves the generated output
-   `dist/` - generated "served site tree" (build output), one folder per scenario:
    `dist/<scenario>/...`

---

## Test scenarios / configurations

The test app supports multiple scenarios. Each scenario is represented by:

1. a Playwright **project** (in `playwright.config.ts`)
2. a built output directory: `dist/<scenario>/`

-   **simple-app**  
    Baseline scenario: loads DappFence and runs basic checks.

-   **simple-app-sw-fixed**  
    Scenario where an `appSW` argument is provided so a _child_ Service Worker is loaded.

-   **simple-app-sw-capture**  
    Scenario where DappFence captures an attempt to register the child Service Worker (instead of
    relying on `appSW`). In this specific scenario, we rely on the Service Worker being reloaded
    with the `appSW` argument. This approach has subtle limitations and can be problematic: we
    disable the `app.js` script that polls the Service Worker status because the version _without_
    the `appSW` argument remains active throughout the lifecycle.

Each scenario is built from:

1. templates in `template/`
2. shared files in `assets/`
3. the build script `src/build.js` (run via `npm run build:manifest`)

Build output is written to `dist/` as a complete directory tree per scenario.

## How scenario selection works (important)

-   Each Playwright "project" corresponds to one scenario.
-   The dev server chooses which `dist/<scenario>` directory to serve based on the configuration
    sent via api by the Playwright project.
-   This keeps the server simple while letting the test suite run multiple independent site variants
    against the same server.

## DappFence build variants (dev vs prod)

Every test scenario is built twice — once with the **dev** bundle (`dappfence.dev.js`) and once with
the **prod** bundle (`dappfence.js`). The build config generates a `BUILD_TARGET` for each
combination:

| Build target              | Bundle used           | Output directory                |
| ------------------------- | --------------------- | ------------------------------- |
| `simple-app-dev`          | `@dappfence/core/dev` | `dist/simple-app-dev/`          |
| `simple-app-prod`         | `@dappfence/core`     | `dist/simple-app-prod/`         |
| `simple-app-sw-fixed-dev` | `@dappfence/core/dev` | `dist/simple-app-sw-fixed-dev/` |
| …                         | …                     | …                               |

Playwright mirrors this with a `projectsPerEnv(env)` helper that stamps the env suffix onto every
project name and its `testMatch` globs, so `simple-app-dev` maps to `dist/simple-app-dev/` and
`simple-app-prod` maps to `dist/simple-app-prod/` with no extra configuration.

### Which projects run by default

| Env vars set                        | Projects that run                            |
| ----------------------------------- | -------------------------------------------- |
| _(none)_                            | `dev` only                                   |
| `PW_TEST_PROD=1`                    | `dev` + `prod`                               |
| `PW_TEST_SKIP_DEV=1`                | _(none — useful combined with the next one)_ |
| `PW_TEST_PROD=1 PW_TEST_SKIP_DEV=1` | `prod` only                                  |

The default is **dev-only** because the dev bundle is what changes during active development. Add
`PW_TEST_PROD=1` when you want to confirm the production bundle behaves the same, e.g. before a
release or after a build-config change.

```bash
# Run only dev projects (default)
npm test

# Run both variants
PW_TEST_PROD=1 npm test

# Run only prod
PW_TEST_PROD=1 PW_TEST_SKIP_DEV=1 npm test

# Target a single variant + specific project
PW_TEST_PROD=1 PW_TEST_SKIP_DEV=1 npx playwright test --project=simple-app-prod
```

---

## Time mocking with libfaketime

### Why we need it

Chromium's Service Worker implementation has a built-in **24-hour update check**: the browser will
re-fetch the Service Worker script (byte-for-byte comparison) roughly every 24 hours, regardless of
`Cache-Control` headers. Testing this behavior in real time is impractical, so we use
[libfaketime](https://github.com/wolfcw/libfaketime) to speed up or shift the clock inside the
browser process itself.

### How it works

libfaketime is a shared library that intercepts libc time functions (`time()`, `gettimeofday()`,
`clock_gettime()`, etc.) via `LD_PRELOAD`. When Playwright launches Chromium with `LD_PRELOAD`
pointing to `libfaketime.so.1`, **every** time call the browser makes — including the ones that
drive HTTP cache expiration and the SW update schedule — sees the manipulated time.

Time is controlled through a **timestamp file** on disk. Tests write libfaketime offset strings
(e.g. `+9h`, `+25h`, `+0 x240`) to this file, and Chromium picks up the new time on its next
syscall. The `swHelper.setFakeTime()` fixture wraps this:

```ts
await swHelper.setFakeTime('+9h'); // shift browser clock 9 hours forward
await swHelper.setFakeTime('+0 x240'); // real-time, but 240× faster
await swHelper.setFakeTime('-20d'); // 20 days in the past
```

### Configuration

The `fake-time` Playwright project (defined in `playwright.config.ts`) sets these environment
variables on the Chromium launch:

| Variable                       | Value                              | Purpose                                                                      |
| ------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------- |
| `LD_PRELOAD`                   | path to `libfaketime.so.1`         | Injects the library into the browser process                                 |
| `FAKETIME_TIMESTAMP_FILE`      | temp file in `/tmp/faketime-*.txt` | File where tests write the desired offset                                    |
| `FAKETIME_DONT_RESET`          | `1`                                | Keep the offset across `fork()`/`exec()` — needed for multi-process Chromium |
| `FAKETIME_NO_CACHE`            | `1`                                | Re-read the timestamp file on every time call (no caching)                   |
| `FAKETIME_DONT_FAKE_MONOTONIC` | `1`                                | Leave monotonic clocks alone so Chromium's internal scheduling doesn't break |

The library is auto-discovered by searching `/usr/lib` recursively for `libfaketime.so.1`. If it is
not found, all `fake-time` tests are skipped automatically.

### Running the fake-time tests

These tests are **opt-in** because they require libfaketime installed on the host, and they are slow
(they simulate hours/days of browser time):

```bash
# Install libfaketime (Debian/Ubuntu)
sudo apt-get install faketime

# Run only the fake-time project (dev bundle; matches the default-env convention above)
RUN_FAKETIME_TESTS=1 npx playwright test --config packages/test-app/playwright.config.ts --project=fake-time-dev

# Prod variant (requires PW_TEST_PROD=1 so the prod projects are generated)
RUN_FAKETIME_TESTS=1 PW_TEST_PROD=1 npx playwright test --config packages/test-app/playwright.config.ts --project=fake-time-prod
```

The project name is `fake-time-${env}` (see `projectsPerEnv` in `playwright.config.ts`), so bare
`--project=fake-time` matches nothing.

Without `RUN_FAKETIME_TESTS=1`, the `fake-time-*` projects are excluded from the Playwright config
entirely, so regular `npm run test` is unaffected.

### Measurements and results

The fake-time tests exist to **measure and verify** how Chromium handles Service Worker and HTTP
cache lifetimes. Key findings:

#### Chromium's 24-hour SW update cycle

Chromium re-fetches the Service Worker script approximately every **24 hours** of perceived browser
time, as mandated by the spec. Our `24hs limit` test suite validates this:

-   **Within the 24h window** — even if the HTTP cache for `dappfence.js` has a very long `max-age`
    (e.g., 1000 hours), DappFence stays loaded from cache and continues protecting the page. If an
    attacker replaces `dappfence.js` on the server during this window, the compromised file is
    **not** loaded.
-   **After the 24h threshold** — Chromium performs a byte-for-byte check and re-fetches the Service
    Worker script. If the server now serves a compromised replacement, the browser loads it, and
    protection is lost.
-   **Page refresh resets the timer** — The 24-hour limit is measured from the last Service Worker
    update check. Each time the page is refreshed, Chromium may perform a new update check, which
    resets the 24-hour window. This means that if users regularly refresh the page (at least once
    every 24 hours), the protection window effectively extends indefinitely, as the timer
    continuously resets with each refresh.
-   **Practical implication**: DappFence can guarantee protection for at most ~24 hours after the
    last SW update check, regardless of cache headers. This is a browser-enforced ceiling.

#### Cache expiration measurement

The `measure cache expiration time` test uses time acceleration (`+0 x240`) to find the exact point
where the browser re-fetches `dappfence.js` after an initial load with aggressive caching
(`Cache-Control: max-age=3600000`). Observations:

-   **With page reloads** — the browser re-fetches the SW script at the ~24h mark (the spec-mandated
    update check).
-   **Without page reloads** (browser sits idle, only in-page JS activity) — the re-fetch happens
    around **~43 hours**. In-page `fetch()` calls alone do not trigger the SW update cycle; a
    navigation or reload is needed to hit the 24h check reliably.

### Known quirks

-   **`page.waitForTimeout()` is affected** — because libfaketime intercepts the browser's clock,
    Playwright's `page.waitForTimeout(ms)` may return much sooner or later than expected. Use
    Node.js-side `setTimeout` (via `new Promise(resolve => setTimeout(resolve, ms))`) for real-time
    waits.

---

## Running E2E tests

Run the full test suite: `npm run test`

What this does:

1. Rebuilds the served HTTP tree
2. Starts the dev server (configured via the `webServer` section in `playwright.config.ts`)
3. Runs Playwright tests against that server

Each test-app uses a different project inside `playwright.config.ts`. The dev server determines
which directory inside `dist` to serve based on an api call sent by each project/test.

If you want to run a specific project add the `--project` flag to the command. If you want to run a
specific file, add the file path to the command. You can also target a single test by providing the
file and line number supported by Playwright.

## Troubleshooting

-   **Changed templates/assets but don't see updates**  
    Re-run the build and restart the dev server:

    -   `npm run build:manifest`

-   **A scenario loads, but tests fail unexpectedly**  
    Confirm you're running the intended Playwright project (`--project ...`) and that
    `dist/<scenario>` was rebuilt.

-   **Port already in use**  
    Stop any previous dev server processes and re-run the test command.
