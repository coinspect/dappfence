# Monitor

Continuous supply-chain and release-integrity monitoring for `@dappfence/core`. Intended to run on a
schedule in CI. Every run produces zero or more **Observations**; analyzers may attach
**annotations** to them; the alerter decides what to escalate.

## Why this exists

Prevention layers (Trusted Publishing, signed tags, provenance attestations, reviewed lockfile
bumps) reduce the probability of a supply-chain incident. Monitoring reduces the **time to detect**
one when a prevention layer is bypassed — which, for the residual attack surface (dependency
compromise, post-publish tampering, selective serving), is the only handle left.

Every observation this monitor produces is also an artifact of "we looked." Publishing that trail is
part of the value.

## Architecture

```
monitors/*        analyzers/*          alerters/*
  │                 │                    │
  │  Observation    │  annotations       │  dispatch
  ▼                 ▼                    ▼
[ verify-registry ] → [ rules ]        → [ stdout       ]
[ (future)       ] → [ llm-haiku ]     → [ github-issue ]
                     [ llm-opus  ]       [ (future)     ]
```

-   **Monitor** — periodic source of Observations. Stateless where possible.
-   **Analyzer** — reads an Observation, may attach annotations. Never blocks, never decides
    severity. LLM analyzers plug in here (see below).
-   **Alerter** — dispatches Observations based on severity + annotations.
-   **Observation** — `{ monitor, subject, severity, title, details, annotations[] }`. See
    `lib/observation.js` for the shape.

Extension points all live in `run.js`. Add a monitor, analyzer, or alerter by importing and
registering it — no other file needs to change.

## Severities

-   `info` — normal state, logged only. Used for "check ran, everything fine."
-   `warn` — non-urgent anomaly. Weekly digest, not paged.
-   `alarm` — urgent, human must look now. Files a GitHub issue by default.

Monitors set the initial severity. Analyzers may `suggest` a re-severity but never override — the
alerter is the only place severity translates into action.

## Adding a monitor

1. Create `scripts/monitor/<name>.js` exporting `run(): Promise<Observation[]>` and a `name` string.
2. Import + push into `MONITORS` in `run.js`.
3. Monitor should:
    - handle its own errors (return an ALARM observation, don't throw)
    - be idempotent — the orchestrator may re-run on retry
    - avoid persistent state for the first cut (add a state store later)

## Adding an analyzer (including LLM)

An analyzer is `(observation) => Promise<observation>` — mutate in place by calling
`annotate(obs, {...})` from `lib/observation.js`.

For an LLM analyzer, register it under `analyzers/llm-<model>.js`:

```js
import { annotate } from '../lib/observation.js';

export default async function llmHaiku(obs) {
    if (obs.monitor !== 'verify-registry') return obs; // scope to what you understand
    if (obs.severity === 'info') return obs; // don't spend tokens on healthy state

    const prompt = buildPrompt(obs);
    const response = await callClaude(prompt); // your API wrapper

    annotate(obs, {
        source: 'llm-haiku',
        model: 'claude-haiku-4-5-20251001',
        note: response.summary,
        confidence: response.confidence,
        suggest: response.suggestSeverity,
    });
    return obs;
}
```

Then add to `ANALYZERS` in `run.js`. That's it — monitors and alerters are unaware. To scope cost,
gate the LLM call inside the analyzer (skip INFO, skip subjects you don't understand, cache by
observation.id).

**Do not** let the analyzer's output change severity directly. The alerter is the single place that
reasons about "what to do about this." Analyzers only add context.

## Adding an alerter

Same pattern — `(observations) => Promise<void>` — register in `ALERTERS`. Typical additions: Slack
webhook, PagerDuty, or a signed public ledger for customer-visible transparency.

## Running

Locally (stdout only, no side effects):

```bash
node scripts/monitor/run.js
```

In CI (files issues on ALARM):

```yaml
- run: node scripts/monitor/run.js
    env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        GITHUB_REPOSITORY: ${{ github.repository }}
```

See `.github/workflows/monitor.yml` for the scheduled runner.

## What's implemented, what's next

Implemented:

-   `verify-registry.js` — checks registry signature presence, attestation presence, and
    tarball-vs-integrity match on the latest published version. Handles the not-yet-published case
    cleanly.

Planned:

-   `rekor-watch.js` — polls Sigstore Rekor for entries under our workflow identity; alerts on
    unexpected entries.
-   `packument-watch.js` — detects unexpected new versions / dist-tag changes / deprecations.
-   `observer-node.js` — designed to run on external VMs (Hetzner / Fly / DO); submits signed sha256
    observations to a shared ledger. Enables multi-egress detection of selective serving.
-   `release-watch.js` — 72h post-release monitor: aggregates verify-registry, Rekor,
    community-issue firehose. Prime target for the first LLM analyzer.
-   LLM analyzers — see "Adding an analyzer" above.
-   Shared alert sink (Slack / PagerDuty) + a public signed ledger.
