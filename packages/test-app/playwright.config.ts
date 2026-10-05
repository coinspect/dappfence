import { defineConfig, devices } from '@playwright/test';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import * as fs from 'node:fs';
const LIB_FAKE_TIME_PATH = 'libfaketimeMT.so.1'; // 'libfaketime.so.1' is not thread-safe; Chromium hangs during browser launch
function findLibFakeTime(searchDir: string): string | undefined {
    try {
        const entries = fs.readdirSync(searchDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const dirPath = path.join(searchDir, entry.name);
                const libPath = path.join(dirPath, LIB_FAKE_TIME_PATH);
                if (fs.existsSync(libPath)) {
                    return libPath;
                }
                const foundPath = findLibFakeTime(dirPath);
                if (foundPath) {
                    return foundPath;
                }
            }
        }
    } catch (_error) {
        // Silently handle errors during directory traversal
    }
}

const projectsPerEnv = (env: string) => [
    ...// to slow to run them all the time, they are used to measure automatic cache invalidation.
    (process.env.RUN_FAKETIME_TESTS
        ? [
              {
                  name: 'fake-time-' + env,
                  testMatch: [`**/*.faketime.ts`],
                  use: {
                      ...devices['Desktop Chrome'],
                      launchOptions: {
                          env: {
                              ...process.env,
                              LD_PRELOAD: findLibFakeTime('/usr/lib'),
                              // FAKETIME_UPDATE_TIMESTAMP_FILE: '1',
                              // FAKETIME_CACHE_DURATION: '1',
                              FAKETIME_DONT_RESET: '1',
                              // NO_CACHE is required despite the ~400x slowdown per navigation:
                              // Chromium's SW 24h-update check runs in a non-renderer process
                              // (browser/storage-partition). FAKETIME_CACHE_DURATION means each
                              // process has its own cache window, so setFakeTime can appear to
                              // land in the renderer (Date.now() shows the jump) while the
                              // SW-update process still sees stale time, silently false-passing
                              // or false-failing timing tests. NO_CACHE is the only mode where
                              // every process sees the jump at the same moment.
                              FAKETIME_NO_CACHE: '1',
                              FAKETIME_DONT_FAKE_MONOTONIC: '1',
                              FAKETIME_TIMESTAMP_FILE: path.join(
                                  os.tmpdir(),
                                  `faketime-${crypto.randomBytes(4).toString('hex')}.txt`
                              ),
                          },
                      },
                  },
              },
          ]
        : []),
    ...['reporting-test-' + env].map((name) => ({
        name,
        testMatch: [`${name}/**/*.spec.ts`],
        use: {
            ...devices['Desktop Chrome'],
        },
    })),
    ...['simple-app-' + env, 'simple-app-sw-fixed-' + env, 'simple-app-sw-capture-' + env].map(
        (name) => ({
            name,
            testMatch: [`${name}/**/*.spec.ts`, 'common/**/*.spec.ts'],
            use: {
                ...devices['Desktop Chrome'],
            },
        })
    ),
];

/**
 * Read environment variables from a file.
 * https://github.com/motdotla/dotenv
 */
// import dotenv from 'dotenv';
// import a path from 'path';
// dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
    testDir: './test',
    /* Run e2e in files in parallel */
    fullyParallel: true,
    /* Fail the build on CI if you accidentally left test.only in the source code. */
    forbidOnly: !!process.env.CI,
    /* Retry on CI only */
    retries: process.env.CI ? 2 : 0,
    /* Opt out of parallel e2e on CI. */
    workers: process.env.CI ? 1 : undefined,
    /* Reporter to use. See https://playwright.dev/docs/test-reporters */
    reporter: process.env.CI ? 'html' : 'list',
    /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
    use: {
        /* Base URL to use in actions like `await page.goto('')`. */
        baseURL: 'http://localhost:3333',
        // This can be used to deal with external addresses like: http://code.jquery.com/jquery-3.7.1.min.js
        proxy: {
            server: 'http://localhost:3333',
        },
        /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
        trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure', // Records trace for tests that fail
    },
    ...(!isNaN(parseInt(process.env.TEST_TIMEOUT_SECONDS))
        ? { timeout: parseInt(process.env.TEST_TIMEOUT_SECONDS) * 1000 }
        : {}),
    /* Configure projects for major browsers, use fake-time project when executed via run-playwright-faketime.js script */
    projects: [
        ...(process.env.PW_TEST_SKIP_DEV ? [] : projectsPerEnv('dev')),
        ...(process.env.PW_TEST_PROD ? projectsPerEnv('prod') : []),
    ],
    /* Run your local dev server before starting the e2e */
    webServer: process.env.SKIP_WEBSERVER
        ? []
        : [
              {
                  name: 'simple-app-server',
                  command: 'npm run dev:http -- -p 3333',
                  port: 3333, // we cannot use url because now our dev server return not-found for /
                  reuseExistingServer: !process.env.CI,
              },
          ],
});
