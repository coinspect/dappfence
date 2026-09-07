import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildCspHeader } from '../manifest/csp.js';
import { normalizeManifestData } from '../storage/manifest-store.js';
import { API } from '../../core/constants.js';

// Every test runs its manifest through `normalizeManifestData` before handing
// it to `buildCspHeader` — mirroring production, where the SW only ever passes
// pre-normalized manifests to the CSP builder. That path also resolves the
// `csp_upgrade_insecure_requests` tri-state to a plain boolean, so tests that need
// to control the flag do so via `vi.stubGlobal('__FEATURES__', …)` below.

const REPORT_URI = `report-uri ${API.CSP_VIOLATION}`;
const NONCE = 'test-nonce-value';

// buildCspHeader now takes (fileKey, response, manifest, apiToken, nonce) and
// returns a Headers instance. `csp()` calls the helper with an empty-body
// response and returns the composed CSP header value so the existing
// string-oriented assertions still read cleanly.
const emptyResponse = () => new Response(null, { headers: new Headers() });
const csp = (manifest, fileKey = '/', apiToken, nonce = NONCE) => {
    const normalized = normalizeManifestData({ files: {}, ...(manifest ?? {}) });
    return buildCspHeader(fileKey, emptyResponse(), normalized, apiToken, nonce).get(
        'Content-Security-Policy'
    );
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('buildCspHeader', () => {
    it('produces a minimal CSP when the manifest has no csp section', () => {
        const header = csp({});
        expect(header).toContain('script-src-elem');
        expect(header).toContain(`'nonce-${NONCE}'`);
        expect(header).toContain('*');
        expect(header).toContain("connect-src 'self'");
        expect(header).toContain("form-action 'self'");
        expect(header).toContain("manifest-src 'self'");
        expect(header).toContain("default-src 'none'");
        expect(header).toContain("object-src 'none'");
        expect(header).toContain("base-uri 'none'");
        expect(header).toContain("frame-ancestors 'none'");
        // `upgrade-insecure-requests` defaults to on via the feature flag
        // fallback (missing flag → default true); the manifest doesn't opt out.
        expect(header).toContain('upgrade-insecure-requests');
        expect(header).toContain(REPORT_URI);
        expect(header).not.toContain('sha256-');
        expect(header).not.toContain('strict-dynamic');
        expect(header).not.toContain('frame-src');
        expect(header).not.toContain('media-src');
    });

    it('produces the same minimal CSP when manifest is null', () => {
        const header = csp(null);
        expect(header).toContain(`'nonce-${NONCE}'`);
        expect(header).toContain('*');
        expect(header).not.toContain('sha256-');
    });

    it('appends connectOrigins to connect-src', () => {
        const manifest = {
            csp: { connectOrigins: ['https://api.example.com', 'wss://ws.example.com'] },
        };
        const header = csp(manifest);
        expect(header).toContain('https://api.example.com');
        expect(header).toContain('wss://ws.example.com');
        expect(header).toMatch(
            /connect-src 'self' https:\/\/api\.example\.com wss:\/\/ws\.example\.com/
        );
    });

    it('adds nonce first, then hashes, then * in script-src-elem', () => {
        const manifest = {
            csp: { pages: { '/': ['sha256-abc123', 'sha256-def456'] } },
        };
        const header = csp(manifest);
        expect(header).toContain(
            `script-src-elem 'nonce-${NONCE}' 'sha256-abc123' 'sha256-def456' *`
        );
        expect(header).not.toContain('strict-dynamic');
    });

    it('emits only nonce + * when the pageKey has no inline hashes', () => {
        const manifest = {
            csp: { pages: { '/other': ['sha256-abc123'] } },
        };
        const header = csp(manifest);
        expect(header).toContain(`script-src-elem 'nonce-${NONCE}' *`);
        expect(header).not.toContain('sha256-');
    });

    it('uses the correct pageKey to look up inline hashes', () => {
        const manifest = {
            csp: {
                pages: {
                    '/page-a': ['sha256-hash-a'],
                    '/page-b': ['sha256-hash-b'],
                },
            },
        };
        const headerA = csp(manifest, '/page-a');
        const headerB = csp(manifest, '/page-b');
        expect(headerA).toContain("'sha256-hash-a'");
        expect(headerA).not.toContain("'sha256-hash-b'");
        expect(headerB).toContain("'sha256-hash-b'");
        expect(headerB).not.toContain("'sha256-hash-a'");
    });

    it('always includes the report-uri directive', () => {
        expect(csp({})).toContain(REPORT_URI);
        expect(csp(null)).toContain(REPORT_URI);
        expect(csp({ csp: { pages: { '/': ['sha256-h'] } } })).toContain(REPORT_URI);
    });

    it('appends token as query param on report-uri when provided', () => {
        const header = csp({}, '/', 'my-secret-token');
        expect(header).toContain(`${API.CSP_VIOLATION}?token=my-secret-token`);
    });

    it('uses bare report-uri when no token is provided', () => {
        const header = csp({});
        expect(header).toContain(`report-uri ${API.CSP_VIOLATION}`);
        expect(header).not.toContain('?token=');
    });

    it('encodes special characters in the token', () => {
        const header = csp({}, '/', 'tok en+special=chars');
        expect(header).toContain('token=tok%20en%2Bspecial%3Dchars');
    });
});

describe('buildCspHeader — configurable origin fields', () => {
    it('appends formActionOrigins to form-action after self', () => {
        const manifest = {
            csp: { formActionOrigins: ['https://payments.example', 'https://sso.example'] },
        };
        expect(csp(manifest)).toMatch(
            /form-action 'self' https:\/\/payments\.example https:\/\/sso\.example/
        );
    });

    it('appends manifestSrcOrigins to manifest-src after self', () => {
        const manifest = { csp: { manifestSrcOrigins: ['https://cdn.example'] } };
        expect(csp(manifest)).toContain("manifest-src 'self' https://cdn.example");
    });

    it('appends imgOrigins to img-src after self and data:', () => {
        const manifest = { csp: { imgOrigins: ['https://images.example'] } };
        expect(csp(manifest)).toContain("img-src 'self' data: https://images.example");
    });

    it('appends fontOrigins to font-src after self', () => {
        const manifest = { csp: { fontOrigins: ['https://fonts.example'] } };
        expect(csp(manifest)).toContain("font-src 'self' https://fonts.example");
    });

    it('appends styleOrigins to style-src after self and unsafe-inline', () => {
        const manifest = { csp: { styleOrigins: ['https://styles.example'] } };
        expect(csp(manifest)).toContain("style-src 'self' 'unsafe-inline' https://styles.example");
    });

    it('emits frame-src only when frameOrigins is non-empty', () => {
        expect(csp({ csp: { frameOrigins: [] } })).not.toContain('frame-src');
        expect(csp({ csp: { frameOrigins: ['https://embeds.example'] } })).toContain(
            "frame-src 'self' https://embeds.example"
        );
    });

    it('emits media-src only when mediaOrigins is non-empty', () => {
        expect(csp({ csp: { mediaOrigins: [] } })).not.toContain('media-src');
        expect(csp({ csp: { mediaOrigins: ['https://media.example'] } })).toContain(
            "media-src 'self' https://media.example"
        );
    });

    it('replaces frame-ancestors none with self + values when frameAncestors is non-empty', () => {
        const permissive = csp({ csp: { frameAncestors: ['https://parent.example'] } });
        expect(permissive).toContain("frame-ancestors 'self' https://parent.example");
        expect(permissive).not.toContain("frame-ancestors 'none'");
    });

    it('keeps frame-ancestors none when frameAncestors is empty or missing', () => {
        expect(csp({ csp: {} })).toContain("frame-ancestors 'none'");
        expect(csp({ csp: { frameAncestors: [] } })).toContain("frame-ancestors 'none'");
    });

    it('always emits report-uri as the last directive so URI regex extractors work', () => {
        // Consumers (including our own e2e tests) scan the policy with
        // `/report-uri\s+(\S+)/` to POST reports back. If anything follows
        // report-uri, the `; ` separator gets glued onto the captured URI.
        const manifest = {
            csp: {
                frameOrigins: ['https://embeds.example'],
                mediaOrigins: ['https://media.example'],
                upgradeInsecureRequests: true,
            },
        };
        const header = csp(manifest);
        const directives = header.split('; ');
        expect(directives[directives.length - 1]).toMatch(/^report-uri /);
    });

    describe("'report-sample' (tri-state resolved in normalizeManifestData)", () => {
        it('prepends the keyword to script-src-elem and style-src when opted in', () => {
            const header = csp({ csp: { reportSample: true } });
            expect(header).toContain("script-src-elem 'report-sample' 'nonce-");
            expect(header).toContain("style-src 'report-sample' 'self' 'unsafe-inline'");
        });

        it('prepends the keyword to script-src-attr when both attrs and sample are on', () => {
            const manifest = {
                csp: {
                    reportSample: true,
                    pages: { '/': { scripts: [], attrs: ['sha256-h'] } },
                },
            };
            expect(csp(manifest)).toContain(
                "script-src-attr 'report-sample' 'unsafe-hashes' 'sha256-h'"
            );
        });

        it('does not touch origin-list directives (img-src, font-src, connect-src, ...)', () => {
            const header = csp({ csp: { reportSample: true } });
            expect(header).not.toMatch(/img-src 'report-sample'/);
            expect(header).not.toMatch(/font-src 'report-sample'/);
            expect(header).not.toMatch(/connect-src 'report-sample'/);
            expect(header).not.toMatch(/form-action 'report-sample'/);
            expect(header).not.toMatch(/manifest-src 'report-sample'/);
        });

        it('manifest false wins over flag true', () => {
            vi.stubGlobal('__FEATURES__', { csp_report_sample: true });
            expect(csp({ csp: { reportSample: false } })).not.toContain("'report-sample'");
        });

        it('manifest omitted → flag decides', () => {
            vi.stubGlobal('__FEATURES__', { csp_report_sample: true });
            expect(csp({ csp: {} })).toContain("'report-sample'");
            vi.stubGlobal('__FEATURES__', { csp_report_sample: false });
            expect(csp({ csp: {} })).not.toContain("'report-sample'");
        });

        it('code default is false when the flag is missing entirely', () => {
            vi.stubGlobal('__FEATURES__', {});
            expect(csp({})).not.toContain("'report-sample'");
        });
    });

    describe('upgrade-insecure-requests (tri-state resolved in normalizeManifestData)', () => {
        it('emits the directive when the manifest explicitly opts in', () => {
            // Even with the flag forced off, the manifest boolean wins.
            vi.stubGlobal('__FEATURES__', { csp_upgrade_insecure_requests: false });
            expect(csp({ csp: { upgradeInsecureRequests: true } })).toContain(
                'upgrade-insecure-requests'
            );
        });

        it('omits the directive when the manifest explicitly opts out (overrides flag)', () => {
            vi.stubGlobal('__FEATURES__', { csp_upgrade_insecure_requests: true });
            expect(csp({ csp: { upgradeInsecureRequests: false } })).not.toContain(
                'upgrade-insecure-requests'
            );
        });

        it('non-boolean manifest values fall back to the feature flag (default true here)', () => {
            // __FEATURES__ absent → normalizer returns default true → directive emitted.
            expect(csp({ csp: { upgradeInsecureRequests: 'yes' } })).toContain(
                'upgrade-insecure-requests'
            );
        });

        it('defers to the feature flag when the manifest omits the field — flag on → emit', () => {
            vi.stubGlobal('__FEATURES__', { csp_upgrade_insecure_requests: true });
            expect(csp({ csp: {} })).toContain('upgrade-insecure-requests');
        });

        it('defers to the feature flag when the manifest omits the field — flag off → skip', () => {
            vi.stubGlobal('__FEATURES__', { csp_upgrade_insecure_requests: false });
            expect(csp({ csp: {} })).not.toContain('upgrade-insecure-requests');
        });

        it('defaults to true when the flag is missing entirely from __FEATURES__', () => {
            // Flag present as an object but this key absent — code default kicks in.
            vi.stubGlobal('__FEATURES__', { some_other_flag: false });
            expect(csp({ csp: {} })).toContain('upgrade-insecure-requests');
        });

        it('defaults to true when the manifest has no csp section at all', () => {
            // The normalizer always emits a fully-resolved csp block, even when
            // the raw manifest is silent, so the flag-default path still fires.
            expect(csp({})).toContain('upgrade-insecure-requests');
        });
    });
});

describe('buildCspHeader — script-src-attr (on* attribute hashes)', () => {
    it('omits script-src-attr when the page entry is an array (legacy format)', () => {
        const manifest = { csp: { pages: { '/': ['sha256-abc'] } } };
        expect(csp(manifest)).not.toContain('script-src-attr');
    });

    it('omits script-src-attr when the page entry has no attrs', () => {
        const manifest = { csp: { pages: { '/': { scripts: ['sha256-abc'], attrs: [] } } } };
        expect(csp(manifest)).not.toContain('script-src-attr');
    });

    it('omits script-src-attr when there is no page entry', () => {
        expect(csp({})).not.toContain('script-src-attr');
    });

    it('emits script-src-attr with unsafe-hashes when attrs are present', () => {
        const manifest = {
            csp: { pages: { '/': { scripts: [], attrs: ['sha256-h1', 'sha256-h2'] } } },
        };
        expect(csp(manifest)).toContain("script-src-attr 'unsafe-hashes' 'sha256-h1' 'sha256-h2'");
    });

    it('script-src-elem still uses scripts from object format', () => {
        const manifest = {
            csp: {
                pages: { '/': { scripts: ['sha256-script'], attrs: ['sha256-attr'] } },
            },
        };
        const header = csp(manifest);
        expect(header).toContain("'sha256-script'");
        expect(header).toContain('script-src-elem');
        expect(header).toContain("script-src-attr 'unsafe-hashes' 'sha256-attr'");
    });

    it('script-src-attr appears between script-src-elem and style-src', () => {
        const manifest = {
            csp: { pages: { '/': { scripts: [], attrs: ['sha256-h'] } } },
        };
        const directives = csp(manifest).split('; ');
        const elemIdx = directives.findIndex((d) => d.startsWith('script-src-elem'));
        const attrIdx = directives.findIndex((d) => d.startsWith('script-src-attr'));
        const styleIdx = directives.findIndex((d) => d.startsWith('style-src'));
        expect(attrIdx).toBeGreaterThan(elemIdx);
        expect(attrIdx).toBeLessThan(styleIdx);
    });
});

describe('buildCspHeader — origin CSP stripping', () => {
    it('strips origin Content-Security-Policy and replaces with the built policy', () => {
        // Origin sends attacker-controlled directives; DappFence must replace,
        // not merge. Note: DappFence's own policy has `style-src 'unsafe-inline'`
        // (comment in csp.js explains why it's safe for styles), so we assert
        // on specific origin fragments that must not survive rather than a
        // blanket "no 'unsafe-inline'".
        const response = new Response(null, {
            headers: new Headers({
                'Content-Security-Policy':
                    "script-src 'unsafe-inline' 'unsafe-eval'; frame-ancestors *",
            }),
        });
        const headers = buildCspHeader('/', response, {}, undefined, NONCE);
        const csp = headers.get('Content-Security-Policy');
        expect(csp).not.toContain("'unsafe-eval'"); // origin used, DappFence never does
        expect(csp).not.toContain("script-src '"); // DappFence emits script-src-elem, not script-src
        expect(csp).not.toContain('frame-ancestors *'); // origin's permissive frame-ancestors gone
        expect(csp).toContain(`'nonce-${NONCE}'`);
        expect(csp).toContain("frame-ancestors 'none'"); // DappFence's replacement
    });

    it('strips origin Content-Security-Policy-Report-Only', () => {
        const response = new Response(null, {
            headers: new Headers({
                'Content-Security-Policy-Report-Only': "script-src 'unsafe-inline'",
            }),
        });
        const headers = buildCspHeader('/', response, {}, undefined, NONCE);
        expect(headers.get('Content-Security-Policy-Report-Only')).toBeNull();
    });

    it('preserves other origin headers', () => {
        const response = new Response(null, {
            headers: new Headers({
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Security-Policy': "script-src 'none'",
            }),
        });
        const headers = buildCspHeader('/', response, {}, undefined, NONCE);
        expect(headers.get('Content-Type')).toBe('text/html; charset=utf-8');
        expect(headers.get('Cache-Control')).toBe('no-store');
    });
});
