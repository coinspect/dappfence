#!/usr/bin/env node
/**
 * Monitor orchestrator. Runs every registered monitor, threads observations
 * through registered analyzers, then dispatches via the alerter.
 *
 * Extension points (all edits happen here):
 *   - MONITORS: add a new source of Observations
 *   - ANALYZERS: add a new annotator (LLM adapters plug in here — see analyzers/)
 *   - ALERTERS: swap the default alerter or add channels
 *
 * Exit code 0 unless the orchestrator itself failed. Alarm observations do NOT
 * cause a non-zero exit — the alerter is what escalates them (issue, page, etc.).
 */

import * as verifyRegistry from './verify-registry.js';
import { runAnalyzers } from './lib/analyzer.js';
import { githubIssueAlerter, stdoutAlerter } from './lib/alerter.js';

const MONITORS = [verifyRegistry];

/**
 * Analyzers run in order on every observation. Add LLM analyzers here once
 * ready — implement the (obs) => Promise<obs> shape, register it, done.
 */
const ANALYZERS = [];

const ALERTERS = [stdoutAlerter, githubIssueAlerter];

async function main() {
    const observations = [];
    for (const monitor of MONITORS) {
        try {
            const results = await monitor.run();
            for (const obs of results) {
                await runAnalyzers(obs, ANALYZERS);
                observations.push(obs);
            }
        } catch (err) {
            console.error(`monitor ${monitor.name ?? '?'} threw: ${err.message}`);
        }
    }
    for (const alerter of ALERTERS) {
        try {
            await alerter(observations);
        } catch (err) {
            console.error(`alerter ${alerter.name ?? '?'} threw: ${err.message}`);
        }
    }
}

main().catch((err) => {
    console.error(`orchestrator failed: ${err.message}`);
    process.exit(2);
});
