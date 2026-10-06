/**
 * Security-specific tests:
 *   - Leaf-level: securityVerifyAgainstManifest + ACTION_HANDLERS + withCspHeaders.
 *   - Factory-level: security-only orchestration behaviors (allow-rule pre-check
 *     in verifyResponse; DENIED_BY_RULE / CSP flows that depend on both the
 *     action pipeline and the shared escalation).
 *
 * Shared factory behavior (pinning, escalation, gate checks, pruning) is tested
 * in verifier.test.js against both strategies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVerifier, securityVerifyAgainstManifest } from '../manifest/security-verifier.js';
import { isRequestAllowed } from '../manifest/rules.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

const FILE_HASH = 'sha256-abc123';
const LOCATION_HREF = 'https://example.com/sw.js';

vi.mock('../../core/crypto.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, calculateHash: vi.fn(() => Promise.resolve(FILE_HASH)) };
});
import { calculateHash } from '../../core/crypto.js';

beforeEach(() => {
    calculateHash.mockReset();
    calculateHash.mockResolvedValue(FILE_HASH);
});

function makeNav(path = '/') {
    return {
        method: 'GET',
        mode: 'navigate',
        destination: 'document',
        url: `https://example.com${path}`,
    };
}

function makeSubResource(path = '/app.js') {
    return {
        method: 'GET',
        mode: 'same-origin',
        destination: 'script',
        url: `https://example.com${path}`,
    };
}

function makeLeafResponse(bytes = new Uint8Array([1, 2, 3])) {
    return {
        getBodyBytes: vi.fn(() => Promise.resolve({ value: bytes })),
    };
}

function makeOkResponse() {
    const r = {
        ok: true,
        type: 'basic',
        arrayBuffer: vi.fn(() => Promise.resolve(new ArrayBuffer(8))),
    };
    r.clone = vi.fn(() => makeOkResponse());
    return r;
}

function makeSwContext() {
    return {
        getLocationHref: () => LOCATION_HREF,
        matchAllClients: vi.fn(() => Promise.resolve([{ id: 'client-1' }])),
    };
}

function makeAppStore() {
    return {
        verificationResultsStore: { add: vi.fn(() => Promise.resolve()) },
    };
}

const SECURITY_STRATEGY = {
    verifyAgainstManifest: securityVerifyAgainstManifest,
    isAllowed: isRequestAllowed,
};

function makeFactory({
    latestManifest,
    historicManifests = [],
    fetchResult = latestManifest,
} = {}) {
    const fetchAndStoreManifest = vi.fn(() =>
        Promise.resolve({ status: VERIFICATION_STATUS.MATCH, ...fetchResult })
    );
    const getManifestHistory = vi.fn(() => Promise.resolve(historicManifests));
    const manifestLoader = {
        storeManifestFromResponse: vi.fn(),
        fetchAndStoreManifest,
        getManifestHistory,
    };
    const { verifyResponse } = createVerifier(
        {
            swContext: makeSwContext(),
            appStore: makeAppStore(),
            config: { manifestUrl: 'https://example.com/integrity-manifest.json' },
        },
        manifestLoader,
        SECURITY_STRATEGY
    );
    const verify = (req, response, clientId = 'client-1') =>
        verifyResponse(req, response, clientId, latestManifest);
    return { verify, verifyResponse, fetchAndStoreManifest, getManifestHistory };
}

// ── leaf: action pipeline semantics ───────────────────────────────────────────

describe('securityVerifyAgainstManifest — action pipeline', () => {
    const run = (manifest, req = makeSubResource('/index.html'), response = makeLeafResponse()) =>
        securityVerifyAgainstManifest(req, response, { appVersion: 'v1', manifest }, LOCATION_HREF);

    it('verify action returns MATCH when the hash is in the manifest', async () => {
        const result = await run({
            files: { '/index.html': [FILE_HASH] },
            contentRules: [],
            pathRules: [{ type: 'directory-index' }],
        });
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });

    it('verify action returns MISMATCH when hash differs', async () => {
        calculateHash.mockResolvedValueOnce('sha256-tampered');
        const result = await run({
            files: { '/index.html': [FILE_HASH] },
            contentRules: [],
            pathRules: [{ type: 'directory-index' }],
        });
        expect(result.status).toBe(VERIFICATION_STATUS.MISMATCH);
        expect(result.actualHash).toBe('sha256-tampered');
        expect(result.expectedHashes).toEqual([FILE_HASH]);
    });

    it('verify action returns NOT_FOUND_IN_MANIFEST when the fileKey is unknown', async () => {
        const result = await run(
            {
                files: { '/other.js': [FILE_HASH] },
                contentRules: [],
                pathRules: [{ type: 'directory-index' }],
            },
            makeSubResource('/nowhere.js')
        );
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
    });

    it('deny action returns DENIED_BY_RULE without hashing', async () => {
        const response = makeLeafResponse();
        const result = await run(
            {
                files: {},
                contentRules: [{ action: { type: 'deny' } }],
                pathRules: [{ type: 'directory-index' }],
            },
            makeSubResource('/anything.js'),
            response
        );
        expect(result.status).toBe(VERIFICATION_STATUS.DENIED_BY_RULE);
        expect(response.getBodyBytes).not.toHaveBeenCalled();
    });

    it('allow action returns SKIPPED', async () => {
        const result = await run({
            files: {},
            contentRules: [{ action: { type: 'allow' } }],
            pathRules: [{ type: 'directory-index' }],
        });
        expect(result.status).toBe(VERIFICATION_STATUS.SKIPPED);
    });

    it('rewrite action returns REWRITE', async () => {
        const result = await run({
            files: {},
            contentRules: [{ action: { type: 'rewrite' } }],
            pathRules: [{ type: 'directory-index' }],
        });
        expect(result.status).toBe(VERIFICATION_STATUS.REWRITE);
    });

    it('csp action returns CSP_PROTECTED (per-route verify opt-out)', async () => {
        const result = await run(
            {
                files: {},
                contentRules: [{ resourceTypes: ['document'], action: { type: 'csp' } }],
                pathRules: [{ type: 'directory-index' }],
            },
            makeNav('/')
        );
        expect(result.status).toBe(VERIFICATION_STATUS.CSP_PROTECTED);
    });

    it('transform action falls through on mismatch, allowing subsequent actions to run', async () => {
        calculateHash
            .mockResolvedValueOnce('sha256-stripped-no-match')
            .mockResolvedValueOnce(FILE_HASH);
        const result = await run(
            {
                files: { '/index.html': [FILE_HASH] },
                contentRules: [
                    { action: { type: 'transform', transform: 'netlify-cdp' } },
                    { action: { type: 'verify' } },
                ],
                pathRules: [{ type: 'directory-index' }],
            },
            makeNav('/')
        );
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });

    it('unknown action is skipped and pipeline continues', async () => {
        const result = await run(
            {
                files: { '/index.html': [FILE_HASH] },
                contentRules: [
                    { action: { type: 'unknown-action' } },
                    { action: { type: 'verify' } },
                ],
                pathRules: [{ type: 'directory-index' }],
            },
            makeNav('/')
        );
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });
});

// ── leaf: CSP header layering ─────────────────────────────────────────────────

describe('securityVerifyAgainstManifest — CSP header layering', () => {
    const cspManifest = (cspSection = {}) => ({
        files: {},
        contentRules: [{ resourceTypes: ['document'], action: { type: 'csp' } }],
        pathRules: [{ type: 'directory-index' }],
        csp: cspSection,
    });

    const run = (manifest) =>
        securityVerifyAgainstManifest(
            makeNav('/'),
            makeLeafResponse(),
            { appVersion: 'v-csp', manifest },
            LOCATION_HREF
        );

    it('document result carries a Content-Security-Policy header', async () => {
        const result = await run(cspManifest());
        expect(result.headers).toBeInstanceOf(Headers);
        expect(result.headers.get('Content-Security-Policy')).toBeTruthy();
    });

    it('surfaces a per-response nonce referenced inside the CSP', async () => {
        const result = await run(cspManifest());
        expect(result.nonce).toEqual(expect.any(String));
        expect(result.nonce.length).toBeGreaterThan(0);
        expect(result.headers.get('Content-Security-Policy')).toContain(`'nonce-${result.nonce}'`);
    });

    it('uses script-src-elem with nonce + * for external scripts', async () => {
        const result = await run(cspManifest());
        const csp = result.headers.get('Content-Security-Policy');
        expect(csp).toContain('script-src-elem');
        expect(csp).toContain(`'nonce-${result.nonce}'`);
        expect(csp).toContain('*');
        expect(csp).not.toContain('strict-dynamic');
    });

    it('includes inline hashes when the page entry matches the page key', async () => {
        const result = await run(cspManifest({ pages: { '/': ['sha256-abc123'] } }));
        const csp = result.headers.get('Content-Security-Policy');
        expect(csp).toContain("'sha256-abc123'");
    });

    it('manifest.csp.enabled=false skips header injection entirely', async () => {
        const result = await run(cspManifest({ enabled: false }));
        expect(result.headers).toBeUndefined();
        expect(result.nonce).toBeUndefined();
    });

    it('manifest.csp.enabled=true still emits headers', async () => {
        const result = await run(cspManifest({ enabled: true }));
        expect(result.headers).toBeInstanceOf(Headers);
        expect(result.headers.get('Content-Security-Policy')).toBeTruthy();
    });

    it('CSP_PROTECTED is a non-violating status', () => {
        expect(VERIFICATION_STATUS.CSP_PROTECTED.isViolation).toBe(false);
    });
});

// ── factory: security-only orchestration behavior ─────────────────────────────

describe('verifyResponse — allow-rule pre-check (security only)', () => {
    it('returns SKIPPED when a content rule allows the request, bypassing opaque REWRITE', async () => {
        const latestManifest = {
            appVersion: 'v-allow',
            manifest: {
                files: {},
                pathRules: [],
                contentRules: [
                    {
                        condition: { urlFilter: 'https://cdn.example.com/' },
                        action: { type: 'allow' },
                    },
                ],
            },
        };
        const { verify } = makeFactory({ latestManifest });

        // Opaque executable → shouldSkipVerification would return REWRITE if reached.
        // The allow-rule pre-check must fire first → SKIPPED.
        const opaqueResponse = {
            ok: false,
            type: 'opaque',
            arrayBuffer: vi.fn(() => Promise.resolve(new ArrayBuffer(8))),
            clone: vi.fn(function () {
                return this;
            }),
        };
        const req = {
            method: 'GET',
            mode: 'no-cors',
            destination: 'embed',
            url: 'https://cdn.example.com/allowed-embed.pdf',
        };

        const result = await verify(req, opaqueResponse);
        expect(result.status).toBe(VERIFICATION_STATUS.SKIPPED);
    });
});

describe('factory + security leaf — orchestration semantics', () => {
    it('DENIED_BY_RULE stops escalation — does not try historic or fetched manifests', async () => {
        const denyManifest = {
            appVersion: 'v-deny',
            manifest: {
                files: { '/index.html': [FILE_HASH] },
                contentRules: [{ action: { type: 'deny' } }],
                pathRules: [{ type: 'directory-index' }],
                mode: 'protected',
            },
        };
        const { verify, getManifestHistory, fetchAndStoreManifest } = makeFactory({
            latestManifest: denyManifest,
        });
        const result = await verify(makeNav('/'), makeOkResponse());
        expect(result.status).toBe(VERIFICATION_STATUS.DENIED_BY_RULE);
        expect(getManifestHistory).not.toHaveBeenCalled();
        expect(fetchAndStoreManifest).not.toHaveBeenCalled();
    });

    it('csp action is terminal — does not escalate to historic manifests', async () => {
        const cspManifestInfo = {
            appVersion: 'v-csp',
            manifest: {
                files: {},
                contentRules: [{ resourceTypes: ['document'], action: { type: 'csp' } }],
                pathRules: [{ type: 'directory-index' }],
                csp: {},
                mode: 'protected',
            },
        };
        const { verify, getManifestHistory, fetchAndStoreManifest } = makeFactory({
            latestManifest: cspManifestInfo,
        });
        await verify(makeNav('/'), makeOkResponse());
        expect(getManifestHistory).not.toHaveBeenCalled();
        expect(fetchAndStoreManifest).not.toHaveBeenCalled();
    });
});
