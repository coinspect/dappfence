#!/usr/bin/env node
/**
 * Precompute SHA-256 digests for the (seed, sizeMB) pairs used by the OOM
 * tests. Streams the deterministic PRNG payload through SHA-256 without
 * allocating the body, so this is bounded by CPU, not RAM.
 *
 * Usage:
 *   node scripts/gen-huge-hashes.js
 *
 * Output goes to stdout as JSON. Redirect into test/fixtures/huge-hashes.json
 * if you want to commit the table; otherwise the dev-server computes on
 * demand and caches in-process.
 */

import { computeHash } from '../src/huge-payload.js';

const PAIRS = [
    { seed: 1, mb: 100 },
    { seed: 1, mb: 250 },
    { seed: 1, mb: 500 },
    { seed: 1, mb: 2100 },
    { seed: 1, mb: 3072 },
    { seed: 2, mb: 2500 },
];

const out = {};
for (const { seed, mb } of PAIRS) {
    const totalBytes = mb * 1024 * 1024;
    const t0 = Date.now();
    const digest = computeHash(seed, totalBytes);
    const elapsed = Date.now() - t0;
    out[`${seed}:${totalBytes}`] = digest;
    console.error(`[gen-huge-hashes] seed=${seed} mb=${mb} → ${digest} (${elapsed} ms)`);
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
