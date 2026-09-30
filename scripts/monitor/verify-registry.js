/**
 * Fetch the current @dappfence/core packument from npm and check what the
 * registry claims about the latest published version:
 *   - registry signature present (npm ECDSA)
 *   - provenance attestation present (Sigstore, optional but expected)
 *   - tarball hash matches packument integrity
 *
 * This is the "what does the world see when they npm install" check. It does
 * not verify the Sigstore attestation cryptographically yet — a full check
 * belongs in a follow-up that shells out to `npm audit signatures` in a temp
 * install, or uses @sigstore/verify directly.
 *
 * Emits at least one Observation per invocation. Handles the not-yet-published
 * case cleanly so this monitor can run today, before the first release.
 */

import { createHash } from 'crypto';
import { makeObservation, SEVERITY } from './lib/observation.js';

const PKG = '@dappfence/core';
const REGISTRY = 'https://registry.npmjs.org';

export const name = 'verify-registry';

export async function run() {
    const observations = [];
    let meta;
    try {
        const res = await fetch(`${REGISTRY}/${encodeURIComponent(PKG)}`);
        if (res.status === 404) {
            observations.push(
                makeObservation({
                    monitor: name,
                    subject: PKG,
                    severity: SEVERITY.INFO,
                    title: 'package not yet published to npm — skipping registry checks',
                    details: { registry: REGISTRY },
                })
            );
            return observations;
        }
        if (!res.ok) {
            throw new Error(`packument fetch HTTP ${res.status}`);
        }
        meta = await res.json();
    } catch (err) {
        observations.push(
            makeObservation({
                monitor: name,
                subject: PKG,
                severity: SEVERITY.ALARM,
                title: 'could not reach npm registry',
                details: { error: err.message },
            })
        );
        return observations;
    }

    const latest = meta['dist-tags']?.latest;
    if (!latest) {
        observations.push(
            makeObservation({
                monitor: name,
                subject: PKG,
                severity: SEVERITY.WARN,
                title: 'packument has no dist-tags.latest',
                details: { distTags: meta['dist-tags'] ?? null },
            })
        );
        return observations;
    }

    const version = meta.versions[latest];
    const dist = version?.dist ?? {};
    const subject = `${PKG}@${latest}`;

    const sigs = dist.signatures ?? [];
    if (sigs.length === 0) {
        observations.push(
            makeObservation({
                monitor: name,
                subject,
                severity: SEVERITY.ALARM,
                title: 'no registry signatures on latest version',
                details: { integrity: dist.integrity ?? null, tarball: dist.tarball ?? null },
            })
        );
    }

    const hasAttest = Boolean(dist.attestations);
    if (!hasAttest) {
        observations.push(
            makeObservation({
                monitor: name,
                subject,
                severity: SEVERITY.WARN,
                title: 'no Sigstore provenance attestation on latest version',
                details: { tarball: dist.tarball ?? null },
            })
        );
    }

    const tarballCheck = await checkTarballIntegrity(dist);
    if (tarballCheck) {
        observations.push(
            makeObservation({
                monitor: name,
                subject,
                severity: SEVERITY.ALARM,
                title: 'tarball hash does not match packument integrity',
                details: tarballCheck,
            })
        );
    }

    if (observations.length === 0) {
        observations.push(
            makeObservation({
                monitor: name,
                subject,
                severity: SEVERITY.INFO,
                title: 'registry checks passed',
                details: {
                    integrity: dist.integrity,
                    signatures: sigs.length,
                    hasAttestation: hasAttest,
                },
            })
        );
    }
    return observations;
}

async function checkTarballIntegrity(dist) {
    if (!dist.tarball || !dist.integrity) {
        return null;
    }
    const [algo, expected] = dist.integrity.split('-');
    if (algo !== 'sha512') {
        return { error: `unsupported integrity algo: ${algo}` };
    }
    const res = await fetch(dist.tarball);
    if (!res.ok) {
        return { error: `tarball fetch HTTP ${res.status}` };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const actual = createHash('sha512').update(bytes).digest('base64');
    if (actual === expected) {
        return null;
    }
    return { expected, actual, tarball: dist.tarball };
}
