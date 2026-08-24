import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApiHandler } from '../api-handler.js';

vi.mock('../../templates/security-warning.html?raw', () => ({
    default:
        '<html><style>/* CSS will be injected here during build */</style><script id="dappfence-config">const DAPPFENCE_CONFIG = {};</script></html>',
}));
vi.mock('../../templates/security-warning.css?raw', () => ({
    default: 'body { color: red; }',
}));
vi.mock('../../core/utils.js', () => ({
    isFeatureEnabled: vi.fn(() => false),
}));

const TOKEN = 'test-token-123';

function createMockAppStore() {
    return {
        apiTokenStore: {
            getApiToken: vi.fn().mockResolvedValue(TOKEN),
        },
        activeBlocksStore: {
            isBlocked: vi.fn().mockResolvedValue(false),
            getActiveBlocks: vi.fn().mockResolvedValue([]),
            getAllBlocks: vi.fn().mockResolvedValue([]),
            clearBlockCondition: vi.fn().mockResolvedValue(undefined),
        },
        trustedManifestStore: {
            getLatest: vi.fn().mockResolvedValue({
                appVersion: 'v1',
                manifest: { files: { '/app.js': 'hash1' } },
            }),
        },
        verificationResultsStore: {
            get: vi.fn().mockResolvedValue([{ file: '/app.js', status: 'match' }]),
        },
    };
}

function req(pathname, { method = 'GET', token, mode } = {}) {
    const url = `https://example.com${pathname}`;
    const headers = {};
    if (token) headers['X-DappFence-Token'] = token;
    const r = new Request(url, { method, headers });
    // Request.mode = 'navigate' cannot be set via init (spec forbids it), so we
    // override the property for tests that need to simulate a real navigation.
    if (mode) Object.defineProperty(r, 'mode', { value: mode, configurable: true });
    return r;
}

describe('createApiHandler', () => {
    let handler;
    let appStore;
    let onSecurityViolation;

    beforeEach(() => {
        appStore = createMockAppStore();
        onSecurityViolation = vi.fn();
        handler = createApiHandler({ onSecurityViolation, appStore });
    });

    describe('authentication', () => {
        it('falls through (undefined) for protected endpoints without token', async () => {
            const res = await handler(
                '/sw-api/site-unblock',
                req('/sw-api/site-unblock', { method: 'POST' })
            );
            expect(res).toBeUndefined();
        });

        it('falls through (undefined) for protected endpoints with wrong token', async () => {
            const res = await handler(
                '/sw-api/site-unblock',
                req('/sw-api/site-unblock', { method: 'POST', token: 'wrong' })
            );
            expect(res).toBeUndefined();
        });

        it('accepts token via header', async () => {
            const res = await handler(
                '/sw-api/site-unblock',
                req('/sw-api/site-unblock', { method: 'POST', token: TOKEN })
            );
            expect(res.status).toBe(200);
        });

        it('accepts token via query param', async () => {
            const res = await handler(
                '/sw-api/site-unblock',
                new Request(`https://example.com/sw-api/site-unblock?token=${TOKEN}`, {
                    method: 'POST',
                })
            );
            expect(res.status).toBe(200);
        });

        it('does not require auth for /sw-api/status', async () => {
            const res = await handler('/sw-api/status', req('/sw-api/status'));
            expect(res.status).toBe(200);
        });

        it('does not require auth for /sw-api/security-warning on navigation', async () => {
            const res = await handler(
                '/sw-api/security-warning',
                req('/sw-api/security-warning', { mode: 'navigate' })
            );
            // No active block → 302 home redirect; auth is not checked
            expect(res.status).toBe(302);
        });
    });

    describe('GET /sw-api/status', () => {
        it('returns status JSON with manifest stats', async () => {
            const res = await handler('/sw-api/status', req('/sw-api/status'));
            const body = await res.json();

            expect(res.headers.get('Content-Type')).toBe('application/json');
            expect(body.appVersion).toBe('v1');
            expect(body.stats.trustedFiles).toBe(1);
            expect(body.stats.totalVerifications).toBe(1);
            expect(body.stats.totalBlocks).toBe(0);
            expect(body.stats.activeBlocks).toBe(0);
            expect(body.blockHistory).toEqual([]);
        });

        it('returns empty stats when no manifest is stored', async () => {
            appStore.trustedManifestStore.getLatest.mockResolvedValue(undefined);
            appStore.verificationResultsStore.get.mockResolvedValue([]);

            const res = await handler('/sw-api/status', req('/sw-api/status'));
            const body = await res.json();

            expect(body.appVersion).toBeNull();
            expect(body.stats.trustedFiles).toBe(0);
            expect(body.stats.totalVerifications).toBe(0);
        });

        it('returns the full verification-results log (no cap)', async () => {
            const results = Array.from({ length: 30 }, (_, i) => ({ id: i }));
            appStore.verificationResultsStore.get.mockResolvedValue(results);

            const res = await handler('/sw-api/status', req('/sw-api/status'));
            const body = await res.json();

            expect(body.verificationResults).toHaveLength(30);
            expect(body.stats.totalVerifications).toBe(30);
        });

        it('includes blockHistory and counts active vs total blocks', async () => {
            appStore.activeBlocksStore.getAllBlocks.mockResolvedValue([
                { id: 'block_a', fileKey: '/a.js', active: true, occurrenceCount: 2 },
                { id: 'block_b', fileKey: '/b.js', active: false, occurrenceCount: 5 },
                { id: 'block_c', fileKey: '/c.js', active: true, occurrenceCount: 1 },
            ]);

            const res = await handler('/sw-api/status', req('/sw-api/status'));
            const body = await res.json();

            expect(body.blockHistory).toHaveLength(3);
            expect(body.stats.totalBlocks).toBe(3);
            expect(body.stats.activeBlocks).toBe(2);
        });
    });

    describe('GET /sw-api/security-warning', () => {
        it('falls through (undefined) when accessed without navigate mode', async () => {
            appStore.activeBlocksStore.isBlocked.mockResolvedValue(true);

            const res = await handler('/sw-api/security-warning', req('/sw-api/security-warning'));
            expect(res).toBeUndefined();
            expect(onSecurityViolation).not.toHaveBeenCalled();
        });

        it('redirects to / when there are no active blocks', async () => {
            appStore.activeBlocksStore.isBlocked.mockResolvedValue(false);

            const res = await handler(
                '/sw-api/security-warning',
                req('/sw-api/security-warning', { mode: 'navigate' })
            );
            expect(res.status).toBe(302);
            expect(res.headers.get('Location')).toBe('/');
            expect(onSecurityViolation).not.toHaveBeenCalled();
        });

        it('renders the security page and broadcasts when blocked', async () => {
            appStore.activeBlocksStore.isBlocked.mockResolvedValue(true);

            const res = await handler(
                '/sw-api/security-warning',
                req('/sw-api/security-warning', { mode: 'navigate' })
            );

            expect(res.status).toBe(200);
            expect(res.headers.get('Content-Type')).toContain('text/html');
            expect(onSecurityViolation).toHaveBeenCalledWith();
            expect(onSecurityViolation).toHaveBeenCalledTimes(1);

            const html = await res.text();
            expect(html).toContain('body { color: red; }');
        });

        // `encodeURIComponent` output never contains `"`, so this capture is safe.
        function decodeInlinedConfig(html) {
            const match = html.match(/decodeURIComponent\("([^"]*)"\)/);
            if (!match) throw new Error('no encoded config payload found');
            return JSON.parse(decodeURIComponent(match[1]));
        }

        it('inlines apiToken, activeBlocks, and autoConfirmSiteLock into DAPPFENCE_CONFIG', async () => {
            appStore.activeBlocksStore.isBlocked.mockResolvedValue(true);
            appStore.activeBlocksStore.getActiveBlocks.mockResolvedValue([
                {
                    id: 'block_abc',
                    timestamp: '2025-01-01T00:00:00.000Z',
                    status: 'MISMATCH',
                    fileKey: '/app.js',
                    expectedHashes: ['aaa'],
                    actualHash: 'bbb',
                    occurrenceCount: 3,
                },
            ]);

            const res = await handler(
                '/sw-api/security-warning',
                req('/sw-api/security-warning', { mode: 'navigate' })
            );
            const html = await res.text();

            expect(html).not.toContain('const DAPPFENCE_CONFIG = {};');
            const config = decodeInlinedConfig(html);
            expect(config.apiToken).toBe(TOKEN);
            expect(config.autoConfirmSiteLock).toBe(false); // mocked `isFeatureEnabled` returns false
            expect(config.activeBlocks).toHaveLength(1);
            expect(config.activeBlocks[0]).toMatchObject({
                id: 'block_abc',
                fileKey: '/app.js',
                expectedHashes: ['aaa'],
                occurrenceCount: 3,
            });
            expect(config.activeBlocks[0].formattedTimestamp).toBeDefined();
        });

        it('defaults missing optional block fields in the inlined payload', async () => {
            appStore.activeBlocksStore.isBlocked.mockResolvedValue(true);
            appStore.activeBlocksStore.getActiveBlocks.mockResolvedValue([
                {
                    id: 'block_xyz',
                    timestamp: '2025-01-01T00:00:00.000Z',
                    status: 'NEW_FILE',
                    fileKey: '/new.js',
                },
            ]);

            const res = await handler(
                '/sw-api/security-warning',
                req('/sw-api/security-warning', { mode: 'navigate' })
            );
            const { activeBlocks } = decodeInlinedConfig(await res.text());

            expect(activeBlocks[0].expectedHashes).toEqual([]);
            expect(activeBlocks[0].actualHash).toBe('N/A');
            expect(activeBlocks[0].occurrenceCount).toBe(1);
        });

        it('keeps HTML-sensitive chars out of the inlined payload while preserving them on decode', async () => {
            appStore.activeBlocksStore.isBlocked.mockResolvedValue(true);
            const nastyFileKey = '/x.js?</script><script>alert(1&2)"\\  ';
            appStore.activeBlocksStore.getActiveBlocks.mockResolvedValue([
                {
                    id: 'block_evil',
                    timestamp: '2025-01-01T00:00:00.000Z',
                    status: 'MISMATCH',
                    fileKey: nastyFileKey,
                },
            ]);

            const res = await handler(
                '/sw-api/security-warning',
                req('/sw-api/security-warning', { mode: 'navigate' })
            );
            const html = await res.text();
            const match = html.match(/decodeURIComponent\("([^"]*)"\)/);
            expect(match).not.toBeNull();
            const encoded = match[1];

            // None of the breakout chars can appear in encodeURIComponent output.
            for (const ch of ['<', '>', '"', '\\', '&', ' ', ' ']) {
                expect(encoded).not.toContain(ch);
            }
            // Round-trip preserves the original attacker-supplied bytes intact.
            const { activeBlocks } = decodeInlinedConfig(html);
            expect(activeBlocks[0].fileKey).toBe(nastyFileKey);
        });

        it('injects the config wrapped in DOUBLE quotes (single quotes would be unsafe)', async () => {
            // `'` is in encodeURIComponent's unreserved set, so an attacker-
            // supplied apostrophe would survive unescaped. Wrapping in `'...'`
            // would let them close the literal.
            appStore.activeBlocksStore.isBlocked.mockResolvedValue(true);
            appStore.activeBlocksStore.getActiveBlocks.mockResolvedValue([
                {
                    id: 'block_quote',
                    timestamp: '2025-01-01T00:00:00.000Z',
                    status: 'MISMATCH',
                    fileKey: "/a'b;alert(1)//",
                },
            ]);

            const res = await handler(
                '/sw-api/security-warning',
                req('/sw-api/security-warning', { mode: 'navigate' })
            );
            const html = await res.text();
            expect(html).toMatch(/JSON\.parse\(decodeURIComponent\("[^"]+"\)\)/);
            expect(html).not.toMatch(/decodeURIComponent\('[^']+'\)/);
        });
    });

    describe('POST /sw-api/site-unblock', () => {
        it('clears the block condition and returns success', async () => {
            const res = await handler(
                '/sw-api/site-unblock',
                req('/sw-api/site-unblock', { method: 'POST', token: TOKEN })
            );
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(appStore.activeBlocksStore.clearBlockCondition).toHaveBeenCalledTimes(1);
        });

        it('returns a plain-text 500 when clearBlockCondition throws', async () => {
            appStore.activeBlocksStore.clearBlockCondition.mockRejectedValue(new Error('DB error'));

            const res = await handler(
                '/sw-api/site-unblock',
                req('/sw-api/site-unblock', { method: 'POST', token: TOKEN })
            );

            expect(res.status).toBe(500);
            expect(await res.text()).toBe('Internal server error');
        });
    });

    describe('unknown endpoint', () => {
        it('falls through (undefined) so the network returns its own 404', async () => {
            const res = await handler('/sw-api/nope', req('/sw-api/nope', { token: TOKEN }));
            expect(res).toBeUndefined();
        });
    });

    describe('outer error handling', () => {
        it('returns 500 when an unexpected error occurs', async () => {
            appStore.trustedManifestStore.getLatest.mockRejectedValue(new Error('unexpected'));

            const res = await handler('/sw-api/status', req('/sw-api/status'));
            expect(res.status).toBe(500);
            expect(await res.text()).toBe('Internal server error');
        });
    });
});
