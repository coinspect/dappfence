import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    resolveManifestKey,
    matchesCondition,
    collectContentRuleActions,
} from '../manifest/rules.js';
import {
    toPathname,
    verifyManifestSignature,
    verifyLocation,
    verifyImportedScript,
} from '../manifest/verification.js';
import { normalizeManifestData } from '../storage/manifest-store.js';
import { createSingleFlight } from '../../core/utils.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

// ── normalizeManifestData ─────────────────────────────────────────────────────

describe('normalizeManifestData', () => {
    it('handles enhanced format with files section', () => {
        const input = {
            files: { '/app.js': 'abc123', '/style.css': 'def456' },
        };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toEqual(['abc123']);
        expect(result.files['/style.css']).toEqual(['def456']);
    });

    it('handles enhanced format with object entries', () => {
        const input = {
            files: { '/app.js': { hash: 'abc123' } },
        };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toEqual(['abc123']);
    });

    it('handles legacy flat format with string values', () => {
        const input = { '/app.js': 'abc123' };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toEqual(['abc123']);
    });

    it('handles legacy flat format with object entries', () => {
        const input = { '/app.js': { hash: 'abc123' } };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toEqual(['abc123']);
    });

    it('preserves SRI hashes as-is (no encoding conversion)', () => {
        const sriHash = 'sha256-' + btoa('test');
        const input = { files: { '/app.js': sriHash } };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toEqual([sriHash]);
    });

    it('returns empty files for non-object input', () => {
        const empty = { files: {}, pathRules: [], contentRules: [], mode: 'reporting' };
        expect(normalizeManifestData(42)).toEqual(empty);
        expect(normalizeManifestData(undefined)).toEqual(empty);
    });

    it('stores empty array for unparseable entries', () => {
        const input = { files: { '/app.js': null, '/ok.js': 'hash' } };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toEqual([]);
        expect(result.files['/ok.js']).toEqual(['hash']);
    });

    it('handles enhanced format with array of hashes', () => {
        const input = { files: { '/lib.js': ['hash-a', 'hash-b'] } };
        const result = normalizeManifestData(input);
        expect(result.files['/lib.js']).toEqual(['hash-a', 'hash-b']);
    });

    it('stores empty array for empty hash arrays', () => {
        const input = { files: { '/lib.js': [], '/ok.js': 'hash' } };
        const result = normalizeManifestData(input);
        expect(result.files['/lib.js']).toEqual([]);
        expect(result.files['/ok.js']).toEqual(['hash']);
    });

    it('preserves top-level fields (mode, metadata, future fields) in enhanced format', () => {
        const input = {
            files: { '/app.js': 'abc' },
            mode: 'reporting',
            metadata: { extensions: ['.js', '.wasm'] },
            customField: { future: true },
        };
        const result = normalizeManifestData(input);
        expect(result.mode).toBe('reporting');
        expect(result.metadata).toEqual({ extensions: ['.js', '.wasm'] });
        expect(result.customField).toEqual({ future: true });
        expect(result.files['/app.js']).toEqual(['abc']);
    });
});

// ── toPathname ────────────────────────────────────────────────────────────────

describe('toPathname', () => {
    const baseUrl = 'https://example.com/dappfence.js';

    it('returns pathname for same-origin absolute URLs', () => {
        expect(toPathname('https://example.com/app.js', baseUrl)).toBe('/app.js');
    });

    it('returns pathname for relative URLs', () => {
        expect(toPathname('/app.js', baseUrl)).toBe('/app.js');
    });

    it('returns full href for cross-origin URLs', () => {
        expect(toPathname('https://cdn.other.com/lib.js', baseUrl)).toBe(
            'https://cdn.other.com/lib.js'
        );
    });

    it('prepends / for bare relative paths', () => {
        expect(toPathname('app.js', 'not-a-valid-url')).toBe('/app.js');
    });

    it('returns absolute URL as-is on parse failure', () => {
        expect(toPathname('https://cdn.com/lib.js', 'bad-base')).toBe('https://cdn.com/lib.js');
    });
});

// ── resolveManifestKey ────────────────────────────────────────────────────────

describe('resolveManifestKey', () => {
    const base = 'https://example.com/dappfence.js';
    const req = (url, destination = 'document') => ({ url, destination });
    const manifest = (pathRules, files) => ({ pathRules, files });

    describe('no pathRules', () => {
        it('returns pathname for same-origin URL', () => {
            expect(resolveManifestKey(req('https://example.com/app.js'), base)).toBe('/app.js');
        });

        it('returns full URL for cross-origin', () => {
            expect(resolveManifestKey(req('https://cdn.other.com/lib.js'), base)).toBe(
                'https://cdn.other.com/lib.js'
            );
        });

        it('falls back to pathname when no rule matches', () => {
            expect(
                resolveManifestKey(req('/about'), base, {
                    files: { '/about/index.html': 'h' },
                })
            ).toBe('/about');
        });

        it('returns pathname for relative path', () => {
            expect(resolveManifestKey(req('/style.css'), base)).toBe('/style.css');
        });
    });

    describe('directory-index rule', () => {
        const files = { '/index.html': 'h', '/docs/index.html': 'h', '/about/index.html': 'h' };
        const pathRules = [{ type: 'directory-index' }];

        it('resolves "/" to "/index.html"', () => {
            expect(resolveManifestKey(req('/'), base, manifest(pathRules, files))).toBe(
                '/index.html'
            );
        });

        it('resolves "/docs/" to "/docs/index.html"', () => {
            expect(resolveManifestKey(req('/docs/'), base, manifest(pathRules, files))).toBe(
                '/docs/index.html'
            );
        });

        it('resolves extensionless "/docs" to "/docs/index.html"', () => {
            expect(resolveManifestKey(req('/docs'), base, manifest(pathRules, files))).toBe(
                '/docs/index.html'
            );
        });

        it('resolves "/about" to "/about/index.html"', () => {
            expect(resolveManifestKey(req('/about'), base, manifest(pathRules, files))).toBe(
                '/about/index.html'
            );
        });

        it('does not remap paths that already have an extension', () => {
            expect(resolveManifestKey(req('/app.js'), base, manifest(pathRules, files))).toBe(
                '/app.js'
            );
        });

        it('falls back to pathname when candidate not in files', () => {
            expect(resolveManifestKey(req('/missing'), base, manifest(pathRules, files))).toBe(
                '/missing'
            );
        });

        it('never applies to cross-origin URLs', () => {
            expect(
                resolveManifestKey(req('https://cdn.com/lib.js'), base, manifest(pathRules, files))
            ).toBe('https://cdn.com/lib.js');
        });
    });

    describe('html-extension rule', () => {
        const files = { '/about.html': 'h', '/contact.html': 'h' };
        const pathRules = [{ type: 'html-extension' }];

        it('resolves "/about" to "/about.html"', () => {
            expect(resolveManifestKey(req('/about'), base, manifest(pathRules, files))).toBe(
                '/about.html'
            );
        });

        it('does not remap paths with extension', () => {
            expect(resolveManifestKey(req('/app.js'), base, manifest(pathRules, files))).toBe(
                '/app.js'
            );
        });

        it('does not remap trailing-slash paths', () => {
            expect(resolveManifestKey(req('/about/'), base, manifest(pathRules, files))).toBe(
                '/about/'
            );
        });

        it('falls back to pathname when candidate not in files', () => {
            expect(resolveManifestKey(req('/missing'), base, manifest(pathRules, files))).toBe(
                '/missing'
            );
        });
    });

    describe('match/resolveAs override', () => {
        const files = { '/campaigns/landing/index.html': 'h' };
        const pathRules = [{ match: '/landing', resolveAs: '/campaigns/landing/index.html' }];

        it('returns resolveAs for exact match', () => {
            expect(resolveManifestKey(req('/landing'), base, manifest(pathRules, files))).toBe(
                '/campaigns/landing/index.html'
            );
        });

        it('falls through for non-matching paths', () => {
            expect(resolveManifestKey(req('/other'), base, manifest(pathRules, files))).toBe(
                '/other'
            );
        });
    });

    describe('condition.urlFilter scoping', () => {
        const files = { '/docs/index.html': 'h' };
        const pathRules = [
            { condition: { urlFilter: '/docs/' }, type: 'directory-index' },
            { type: 'html-extension' },
        ];

        it('applies scoped rule only to matching prefix', () => {
            expect(resolveManifestKey(req('/docs/'), base, manifest(pathRules, files))).toBe(
                '/docs/index.html'
            );
        });

        it('falls through to next rule when prefix does not match', () => {
            const files2 = { ...files, '/about.html': 'h2' };
            expect(resolveManifestKey(req('/about'), base, manifest(pathRules, files2))).toBe(
                '/about.html'
            );
        });
    });
});

// ── matchesCondition ─────────────────────────────────────────────────────────

describe('matchesCondition', () => {
    it('returns true when condition is undefined', () => {
        expect(matchesCondition(undefined, '/app.js', 'script')).toBe(true);
    });

    it('returns true when condition is null', () => {
        expect(matchesCondition(null, '/app.js', 'script')).toBe(true);
    });

    it('matches when urlFilter is a prefix of fileKey', () => {
        expect(matchesCondition({ urlFilter: '/api/' }, '/api/users', 'fetch')).toBe(true);
    });

    it('does not match when urlFilter is not a prefix of fileKey', () => {
        expect(matchesCondition({ urlFilter: '/api/' }, '/other/path', 'fetch')).toBe(false);
    });

    it('matches when destination is in resourceTypes', () => {
        expect(
            matchesCondition({ resourceTypes: ['script', 'document'] }, '/app.js', 'script')
        ).toBe(true);
    });

    it('does not match when destination is not in resourceTypes', () => {
        expect(matchesCondition({ resourceTypes: ['document'] }, '/app.js', 'script')).toBe(false);
    });

    it('matches when both urlFilter and resourceTypes are satisfied', () => {
        expect(
            matchesCondition({ urlFilter: '/api/', resourceTypes: ['fetch'] }, '/api/data', 'fetch')
        ).toBe(true);
    });

    it('does not match when urlFilter fails even if resourceTypes would pass', () => {
        expect(
            matchesCondition(
                { urlFilter: '/api/', resourceTypes: ['fetch'] },
                '/other/data',
                'fetch'
            )
        ).toBe(false);
    });
});

// ── collectContentRuleActions ─────────────────────────────────────────────────

describe('collectContentRuleActions', () => {
    const rules = [
        { condition: { resourceTypes: ['script'] }, action: { type: 'verify' } },
        { condition: { urlFilter: '/api/' }, action: { type: 'allow' } },
        { action: { type: 'deny' } },
    ];

    it('returns actions for all matching rules', () => {
        const actions = collectContentRuleActions('/app.js', 'script', rules);
        expect(actions).toEqual([{ type: 'verify' }, { type: 'deny' }]);
    });

    it('returns actions for rules without a condition (always match)', () => {
        const actions = collectContentRuleActions('/page.html', 'document', rules);
        expect(actions).toEqual([{ type: 'deny' }]);
    });

    it('returns empty array when no rules match', () => {
        const strictRules = [
            { condition: { resourceTypes: ['script'] }, action: { type: 'verify' } },
        ];
        expect(collectContentRuleActions('/page.html', 'document', strictRules)).toEqual([]);
    });

    it('returns empty array for empty contentRules', () => {
        expect(collectContentRuleActions('/app.js', 'script', [])).toEqual([]);
    });

    it('matches urlFilter rule when fileKey starts with the filter', () => {
        const actions = collectContentRuleActions('/api/data', 'fetch', rules);
        expect(actions).toContainEqual({ type: 'allow' });
    });
});

// ── verifyManifestSignature ───────────────────────────────────────────────────

describe('verifyManifestSignature', () => {
    it('returns UNSUPPORTED_SIGNATURE for unknown signature types', () => {
        const result = verifyManifestSignature('unknown-type', '0xABC', { pay: {}, sig: 'sig' });
        expect(result.status).toBe(VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE);
    });
});

// ── verifyLocation ────────────────────────────────────────────────────────────

const mockManifestService = (verifyResponseMock) => ({
    resolveManifest: vi.fn().mockResolvedValue({ verifyResponse: verifyResponseMock }),
});

describe('verifyLocation', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = { mark_request: true };
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });

    it('fetches the URL and returns the verifyResponse result enriched with url', async () => {
        const verifyResponseResult = {
            status: 'MATCH',
            fileKey: '/lib.js',
            expectedHashes: ['abc'],
            actualHash: 'abc',
            timestamp: '2026-01-01T00:00:00.000Z',
        };
        const verifyResponse = vi.fn().mockResolvedValue(verifyResponseResult);
        const response = new Response('file content');
        const deps = {
            swContext: {
                fetch: vi.fn().mockResolvedValue(response),
                getLocationHref: () => 'https://example.com/sw.js',
            },
            manifestService: mockManifestService(verifyResponse),
        };

        const result = await verifyLocation(deps, '/lib.js');

        expect(deps.swContext.fetch).toHaveBeenCalledWith('/lib.js', {
            headers: { 'x-dappfence': 'sw-verification' },
        });
        expect(verifyResponse).toHaveBeenCalledWith(
            { url: '/lib.js', destination: 'script', method: 'GET', mode: '' },
            response
        );
        expect(result).toEqual(verifyResponseResult);
    });

    it('returns error with httpStatus on fetch failure', async () => {
        const verifyResponse = vi.fn();
        const deps = {
            swContext: {
                fetch: vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Error' }),
                getLocationHref: () => 'https://example.com/sw.js',
            },
            manifestService: mockManifestService(verifyResponse),
        };

        const result = await verifyLocation(deps, '/missing.js');

        expect(verifyResponse).not.toHaveBeenCalled();
        expect(result).toEqual({ status: VERIFICATION_STATUS.ERROR, httpStatus: 500 });
    });
});

// ── verifyImportedScript ──────────────────────────────────────────────────────

describe('verifyImportedScript', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = { mark_request: true };
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });

    it('calls verifyResponse with script URL and the fetched response', async () => {
        const verifyResponse = vi.fn().mockResolvedValue({ status: 'MATCH' });
        const response = new Response('script content');
        const core = {
            manifestService: mockManifestService(verifyResponse),
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi.fn().mockResolvedValue(response),
                getLocationHref: () => 'https://example.com/sw.js',
            },
        };

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(core.swContext.fetch).toHaveBeenCalledWith('https://example.com/lib.js', {
            headers: { 'x-dappfence': 'sw-verification' },
        });
        expect(verifyResponse).toHaveBeenCalledWith(
            { url: 'https://example.com/lib.js', destination: 'script', method: 'GET', mode: '' },
            response
        );
        expect(core.appStore.recordSecurityViolation).not.toHaveBeenCalled();
    });

    it('records violation on mismatch', async () => {
        const verifyResponse = vi.fn().mockResolvedValue({
            status: VERIFICATION_STATUS.MISMATCH,
            fileKey: '/lib.js',
        });
        const core = {
            manifestService: mockManifestService(verifyResponse),
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi.fn().mockResolvedValue(new Response('bad content')),
                getLocationHref: () => 'https://example.com/sw.js',
            },
        };

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(core.appStore.recordSecurityViolation).toHaveBeenCalledWith(
            expect.objectContaining({
                assetType: 'service-worker',
                url: 'https://example.com/lib.js',
            })
        );
    });

    it('records violation on fetch failure', async () => {
        const verifyResponse = vi.fn();
        const core = {
            manifestService: mockManifestService(verifyResponse),
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi
                    .fn()
                    .mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }),
                getLocationHref: () => 'https://example.com/sw.js',
            },
        };

        await verifyImportedScript(core, 'https://example.com/missing.js');

        expect(verifyResponse).not.toHaveBeenCalled();
        expect(core.appStore.recordSecurityViolation).toHaveBeenCalledWith(
            expect.objectContaining({
                status: VERIFICATION_STATUS.ERROR,
                assetType: 'service-worker',
                url: 'https://example.com/missing.js',
            })
        );
    });

    it('treats SKIPPED results as non-violations', async () => {
        const verifyResponse = vi.fn().mockResolvedValue({
            status: VERIFICATION_STATUS.SKIPPED,
            fileKey: '/lib.js',
        });
        const core = {
            manifestService: mockManifestService(verifyResponse),
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi.fn().mockResolvedValue(new Response('content')),
                getLocationHref: () => 'https://example.com/sw.js',
            },
        };

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(core.appStore.recordSecurityViolation).not.toHaveBeenCalled();
    });
});

// ── createSingleFlight ────────────────────────────────────────────────────────

describe('createSingleFlight', () => {
    it('returns the result of the function', async () => {
        const sf = createSingleFlight();
        const result = await sf(async () => 42);
        expect(result).toBe(42);
    });

    it('deduplicates concurrent calls', async () => {
        const sf = createSingleFlight();
        let callCount = 0;
        const fn = () =>
            new Promise((resolve) => {
                callCount++;
                setTimeout(() => resolve('done'), 10);
            });

        const [a, b] = await Promise.all([sf(fn), sf(fn)]);
        expect(callCount).toBe(1);
        expect(a).toBe('done');
        expect(b).toBe('done');
    });

    it('allows a new call after the previous one completes', async () => {
        const sf = createSingleFlight();
        let callCount = 0;
        const fn = async () => ++callCount;

        await sf(fn);
        await sf(fn);
        expect(callCount).toBe(2);
    });

    it('resets after rejection so the next call retries', async () => {
        const sf = createSingleFlight();
        let callCount = 0;
        const failOnce = async () => {
            callCount++;
            if (callCount === 1) {
                throw new Error('fail');
            }
            return 'ok';
        };

        await expect(sf(failOnce)).rejects.toThrow('fail');
        const result = await sf(failOnce);
        expect(result).toBe('ok');
        expect(callCount).toBe(2);
    });
});
