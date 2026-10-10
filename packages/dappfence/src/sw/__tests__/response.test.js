import { describe, expect, it, vi } from 'vitest';
import securityWarningHtml from '../../templates/security-warning.html?raw';
import {
    createBlockResponse,
    createRedirectResponse,
    createSecurityPageResponse,
    injectResponseHeaders,
} from '../response.js';

// `isFeatureEnabled` reads the Vite-injected `__FEATURES__` define, which
// isn't populated in the vitest runtime — stub it so `response.js`'s
// module-load evaluation of the feature flag doesn't throw.
vi.mock('../../core/utils.js', () => ({
    isFeatureEnabled: vi.fn(() => false),
}));

describe('createBlockResponse', () => {
    it('returns JS redirect when request targets the SW script', () => {
        const response = createBlockResponse(
            { mode: 'no-cors', url: 'https://example.com/sw.js' },
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('javascript');
    });

    it('returns 302 redirect to the warning page for navigation requests', () => {
        const response = createBlockResponse(
            { mode: 'navigate', url: 'https://example.com/app.js' },
            'https://example.com/sw.js'
        );
        expect(response.status).toBe(302);
        expect(response.headers.get('Location')).toBe('/sw-api/security-warning');
    });

    it('returns plain text warning for non-navigation subresource requests', () => {
        const response = createBlockResponse(
            { mode: 'no-cors', url: 'https://example.com/app.js' },
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('text/plain');
        expect(response.status).toBe(403);
    });

    it('does not treat a cross-origin same-pathname URL as the SW script', () => {
        const response = createBlockResponse(
            { mode: 'no-cors', url: 'https://evil.com/sw.js' },
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('text/plain');
        expect(response.status).toBe(403);
    });
});

describe('createRedirectResponse', () => {
    it('returns a 302 redirect with no-cache headers', () => {
        const response = createRedirectResponse('/some/path');
        expect(response.status).toBe(302);
        expect(response.headers.get('Location')).toBe('/some/path');
        expect(response.headers.get('Cache-Control')).toContain('no-cache');
    });
});

describe('security-warning template', () => {
    // `response.js` pre-slices the bundled template around this tag at module
    // load. A rename or removal of the id would make `createSecurityPageResponse`
    // render a warning page with an empty `DAPPFENCE_CONFIG` — this test fails
    // fast at dev time instead.
    it('contains the <script id="dappfence-config"> placeholder', () => {
        expect(securityWarningHtml).toMatch(/<script id="dappfence-config">[\s\S]*?<\/script>/);
    });

    // The view object produced by response.js's BLOCK_VIEW only matters if
    // renderBlocks actually reads it. These smoke checks pin the specific
    // identifiers the template consumes so a rename on the response.js side
    // (or a stray deletion in the template) breaks loudly.
    it('reads view fields and renders expected/actual rows conditionally', () => {
        expect(securityWarningHtml).toMatch(/block\.view/);
        expect(securityWarningHtml).toMatch(/view\.title/);
        expect(securityWarningHtml).toMatch(/view\.expectedLabel/);
        expect(securityWarningHtml).toMatch(/view\.actualLabel/);
    });

    it('renders expectedHashes as a list via formatList (not a scalar expectedHash)', () => {
        expect(securityWarningHtml).toMatch(/formatList\(block\.expectedHashes\)/);
        expect(securityWarningHtml).not.toMatch(/block\.expectedHash\b(?!es)/);
    });

    it('surfaces block.reason when present', () => {
        expect(securityWarningHtml).toMatch(/block\.reason/);
    });

    it('applies the top-of-page summary from config', () => {
        expect(securityWarningHtml).toMatch(/applySummary/);
        expect(securityWarningHtml).toMatch(/id="security-subtitle"/);
        expect(securityWarningHtml).toMatch(/id="security-message"/);
    });
});

describe('createSecurityPageResponse — DAPPFENCE_CONFIG view', () => {
    // Rendered HTML contains:
    //   <script>const DAPPFENCE_CONFIG = JSON.parse(decodeURIComponent("<pct-encoded>"));</script>
    // Pull the encoded blob back out and decode it so we can assert on the
    // view fields the template will actually see at runtime.
    const CONFIG_PATTERN = /JSON\.parse\(decodeURIComponent\("([^"]+)"\)\)/;
    async function extractConfig(response) {
        const text = await response.text();
        const match = CONFIG_PATTERN.exec(text);
        expect(match, 'rendered HTML must contain the DAPPFENCE_CONFIG script').not.toBeNull();
        return JSON.parse(decodeURIComponent(match[1]));
    }

    function block(overrides) {
        return {
            status: 'MISMATCH',
            assetType: 'asset',
            fileKey: '/app.js',
            url: 'https://example.com/app.js',
            timestamp: '2026-10-07T12:00:00.000Z',
            ...overrides,
        };
    }

    it('resolves view labels for a hash MISMATCH', async () => {
        const res = createSecurityPageResponse('tok', [
            block({ expectedHashes: ['sha256-aaa'], actualHash: 'sha256-bbb' }),
        ]);
        const cfg = await extractConfig(res);
        const [b] = cfg.activeBlocks;
        expect(b.view.title).toBe('File content tampered');
        expect(b.view.expectedLabel).toBe('Expected hash');
        expect(b.view.actualLabel).toBe('Actual hash');
        expect(b.expectedHashes).toEqual(['sha256-aaa']);
        expect(b.actualHash).toBe('sha256-bbb');
    });

    it('preserves multiple expectedHashes as an array', async () => {
        const res = createSecurityPageResponse('tok', [
            block({ expectedHashes: ['sha256-a', 'sha256-b'], actualHash: 'sha256-c' }),
        ]);
        const cfg = await extractConfig(res);
        expect(cfg.activeBlocks[0].expectedHashes).toEqual(['sha256-a', 'sha256-b']);
    });

    it('resolves view for NOT_FOUND_IN_MANIFEST without an expected label', async () => {
        const res = createSecurityPageResponse('tok', [
            block({ status: 'NOT_FOUND_IN_MANIFEST', actualHash: 'sha256-xyz' }),
        ]);
        const cfg = await extractConfig(res);
        expect(cfg.activeBlocks[0].view.title).toBe('File not listed in trusted manifest');
        expect(cfg.activeBlocks[0].view.expectedLabel).toBeUndefined();
        expect(cfg.activeBlocks[0].view.actualLabel).toBe('Actual hash');
    });

    it('resolves view for DENIED_BY_RULE with no hash labels', async () => {
        const res = createSecurityPageResponse('tok', [block({ status: 'DENIED_BY_RULE' })]);
        const cfg = await extractConfig(res);
        expect(cfg.activeBlocks[0].view.title).toBe('File blocked by security rule');
        expect(cfg.activeBlocks[0].view.expectedLabel).toBeUndefined();
        expect(cfg.activeBlocks[0].view.actualLabel).toBeUndefined();
    });

    it('resolves view for ERROR by reason', async () => {
        const res = createSecurityPageResponse('tok', [
            block({ status: 'ERROR', reason: 'FETCH_BAD_STATUS', httpStatus: 500 }),
        ]);
        const cfg = await extractConfig(res);
        expect(cfg.activeBlocks[0].view.title).toBe('Verification failed: non-OK HTTP status');
    });

    it('falls back on unknown ERROR reason', async () => {
        const res = createSecurityPageResponse('tok', [
            block({ status: 'ERROR', reason: 'FUTURE_REASON' }),
        ]);
        const cfg = await extractConfig(res);
        expect(cfg.activeBlocks[0].view.title).toBe('Verification error (FUTURE_REASON)');
    });

    it('resolves MANIFEST_UNTRUSTED / SIGNER_CHANGED to the signer-rotation view', async () => {
        const res = createSecurityPageResponse('tok', [
            block({
                status: 'MANIFEST_UNTRUSTED',
                assetType: 'manifest',
                reason: 'SIGNER_CHANGED',
                fileKey: '/manifest.json',
                expectedHashes: ['fulcio-oidc:andres@coinspect.com'],
                actualHash: 'fulcio-oidc:other@coinspect.com',
            }),
        ]);
        const cfg = await extractConfig(res);
        const [b] = cfg.activeBlocks;
        expect(b.view.title).toBe('Manifest signer changed since pinning');
        expect(b.view.expectedLabel).toBe('Pinned signer');
        expect(b.view.actualLabel).toBe('Current signer');
        expect(b.expectedHashes).toEqual(['fulcio-oidc:andres@coinspect.com']);
        expect(b.actualHash).toBe('fulcio-oidc:other@coinspect.com');
        expect(b.reason).toBe('SIGNER_CHANGED');
    });

    it('resolves MANIFEST_UNTRUSTED / SIGNATURE_MISMATCH to the recovered-signer view', async () => {
        const res = createSecurityPageResponse('tok', [
            block({
                status: 'MANIFEST_UNTRUSTED',
                assetType: 'manifest',
                reason: 'SIGNATURE_MISMATCH',
            }),
        ]);
        const cfg = await extractConfig(res);
        expect(cfg.activeBlocks[0].view.title).toBe(
            'Manifest signature identity does not match pinned signer'
        );
        expect(cfg.activeBlocks[0].view.actualLabel).toBe('Recovered signer');
    });

    it.each([
        ['UNSUPPORTED_SIGNATURE', 'Manifest signature uses an unsupported algorithm'],
        ['SIGNATURE_ERROR', 'Manifest signature verification threw an error'],
        ['MANIFEST_PARSE_ERROR', 'Manifest could not be parsed'],
        ['MANIFEST_FETCH_BAD_STATUS', 'Manifest fetch returned a non-OK status'],
        ['MANIFEST_FETCH_EXCEPTION', 'Manifest fetch threw an exception'],
        ['CONFIG_ERROR', 'DappFence manifest is misconfigured'],
    ])('resolves MANIFEST_UNTRUSTED / %s title', async (reason, title) => {
        const res = createSecurityPageResponse('tok', [
            block({ status: 'MANIFEST_UNTRUSTED', assetType: 'manifest', reason }),
        ]);
        const cfg = await extractConfig(res);
        expect(cfg.activeBlocks[0].view.title).toBe(title);
    });

    it('falls back on unknown MANIFEST_UNTRUSTED reason', async () => {
        const res = createSecurityPageResponse('tok', [
            block({ status: 'MANIFEST_UNTRUSTED', assetType: 'manifest', reason: 'FUTURE' }),
        ]);
        const cfg = await extractConfig(res);
        expect(cfg.activeBlocks[0].view.title).toBe('Manifest cannot be trusted (FUTURE)');
    });

    it('falls back on unknown status', async () => {
        const res = createSecurityPageResponse('tok', [block({ status: 'NEW_STATUS' })]);
        const cfg = await extractConfig(res);
        expect(cfg.activeBlocks[0].view.title).toBe('Security violation (NEW_STATUS)');
    });

    it('uses the file-tamper summary when all blocks are asset-level', async () => {
        const res = createSecurityPageResponse('tok', [block({ status: 'MISMATCH' })]);
        const cfg = await extractConfig(res);
        expect(cfg.summary.subtitle).toBe('Potentially Malicious Content Blocked');
        expect(cfg.summary.message).toMatch(/content on this page has been modified/i);
    });

    it('switches to manifest-trust summary when any block is manifest-level', async () => {
        const res = createSecurityPageResponse('tok', [
            block({ status: 'MISMATCH' }),
            block({
                status: 'MANIFEST_UNTRUSTED',
                assetType: 'manifest',
                reason: 'SIGNER_CHANGED',
            }),
        ]);
        const cfg = await extractConfig(res);
        expect(cfg.summary.subtitle).toBe('Manifest Trust Issue');
        expect(cfg.summary.message).toMatch(/authenticity of this site's manifest/i);
    });

    it('formats the timestamp into the enriched record', async () => {
        const res = createSecurityPageResponse('tok', [block()]);
        const cfg = await extractConfig(res);
        expect(typeof cfg.activeBlocks[0].formattedTimestamp).toBe('string');
        expect(cfg.activeBlocks[0].formattedTimestamp.length).toBeGreaterThan(0);
    });

    it('passes the apiToken through to the config', async () => {
        const res = createSecurityPageResponse('secret-token', []);
        const cfg = await extractConfig(res);
        expect(cfg.apiToken).toBe('secret-token');
    });
});

describe('createBlockResponse edge cases', () => {
    it('handles invalid locationHref gracefully in SW path check', () => {
        const response = createBlockResponse(
            { mode: 'no-cors', url: 'https://example.com/app.js' },
            'not-a-valid-url'
        );
        expect(response.status).toBe(403);
    });
});

describe('injectResponseHeaders', () => {
    // injectResponseHeaders is a simple applier now — it wraps the response
    // with the given Headers wholesale. Trust-model decisions (which origin
    // headers to strip / preserve, which SW-derived to set) live in the
    // caller (currently manifest/csp.js § buildCspHeader). Tests here just
    // verify the plumbing.
    function makeResponse(headers = {}, status = 200) {
        return new Response('body', { status, headers });
    }

    it('applies the given headers to the returned response', () => {
        const base = makeResponse();
        const result = injectResponseHeaders(base, { 'X-Custom': 'value' });
        expect(result.headers.get('X-Custom')).toBe('value');
    });

    it('accepts a Headers instance as well as a plain object', () => {
        const base = makeResponse();
        const headers = new Headers({ 'X-Custom': 'via-headers' });
        const result = injectResponseHeaders(base, headers);
        expect(result.headers.get('X-Custom')).toBe('via-headers');
    });

    it('does not preserve origin headers unless caller included them', () => {
        // Contract change from the earlier additive behavior: the caller is
        // responsible for constructing the full desired Headers (e.g. by
        // copying from response.headers first, as buildCspHeader does).
        const base = makeResponse({ 'Content-Type': 'text/html' });
        const result = injectResponseHeaders(base, { 'X-Custom': 'added' });
        expect(result.headers.get('Content-Type')).toBeNull();
        expect(result.headers.get('X-Custom')).toBe('added');
    });

    it('when caller copies origin headers into the Headers, they survive', () => {
        const base = makeResponse({ 'Content-Type': 'text/html' });
        const headers = new Headers(base.headers);
        headers.set('X-Custom', 'added');
        const result = injectResponseHeaders(base, headers);
        expect(result.headers.get('Content-Type')).toBe('text/html');
        expect(result.headers.get('X-Custom')).toBe('added');
    });

    it('preserves status and statusText from the original response', () => {
        const base = new Response('body', { status: 404, statusText: 'Not Found' });
        const result = injectResponseHeaders(base, { 'X-Custom': 'v' });
        expect(result.status).toBe(404);
        expect(result.statusText).toBe('Not Found');
    });
});
