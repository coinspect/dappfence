import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createManifestService } from '../manifest/manifest-service.js';
import { VERIFICATION_STATUS, MODE } from '../../core/constants.js';

const baseHref = 'https://app.example.com/sw.js';

const setup = ({ latestManifest = null, config } = {}) => {
    const swContext = {
        fetch: vi.fn(),
        getLocationHref: vi.fn().mockReturnValue(baseHref),
        matchAllClients: vi.fn().mockResolvedValue([]),
    };
    const trustedManifestStore = {
        getLatest: vi.fn().mockResolvedValue(latestManifest),
        getAll: vi.fn().mockResolvedValue(latestManifest ? [latestManifest] : []),
        addLatest: vi.fn(),
    };
    const verificationResultsStore = { add: vi.fn().mockResolvedValue() };
    const appStore = { trustedManifestStore, verificationResultsStore };
    return {
        swContext,
        appStore,
        deps: { swContext, appStore, config: config ?? {} },
    };
};

describe('createManifestService — composition', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = {};
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });

    it('exposes fetchAndStoreManifest and resolveManifest', () => {
        const { deps } = setup();
        const svc = createManifestService(deps);
        expect(typeof svc.fetchAndStoreManifest).toBe('function');
        expect(typeof svc.resolveManifest).toBe('function');
    });

    it('resolveManifest returns { mode, prepareRequest, verifyResponse }', async () => {
        const latestManifest = {
            appVersion: 'v1',
            manifest: { files: {}, pathRules: [], mode: MODE.PROTECTED },
        };
        const { deps } = setup({ latestManifest });
        const ctx = await createManifestService(deps).resolveManifest();
        expect(ctx.mode).toBe(MODE.PROTECTED);
        expect(typeof ctx.prepareRequest).toBe('function');
        expect(typeof ctx.verifyResponse).toBe('function');
    });

    it('effective mode falls back to REPORTING when manifest is empty and flag is off', async () => {
        const { deps } = setup();
        const ctx = await createManifestService(deps).resolveManifest();
        expect(ctx.mode).toBe(MODE.REPORTING);
    });

    it('effective mode falls back to PROTECTED when default_to_protected_mode is on', async () => {
        globalThis.__FEATURES__ = { default_to_protected_mode: true };
        const { deps } = setup();
        const ctx = await createManifestService(deps).resolveManifest();
        expect(ctx.mode).toBe(MODE.PROTECTED);
    });

    it('returns CONFIG_ERROR from fetchAndStoreManifest when config has no manifestUrl', async () => {
        const { deps } = setup();
        const result = await createManifestService(deps).fetchAndStoreManifest();
        expect(result.status).toBe(VERIFICATION_STATUS.CONFIG_ERROR);
    });
});
