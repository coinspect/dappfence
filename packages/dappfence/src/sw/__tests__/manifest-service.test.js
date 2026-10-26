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

    it('returns MANIFEST_UNTRUSTED with CONFIG_ERROR reason when config has no manifestUrl', async () => {
        const { deps } = setup();
        const result = await createManifestService(deps).fetchAndStoreManifest();
        expect(result.status).toBe(VERIFICATION_STATUS.MANIFEST_UNTRUSTED);
        expect(result.reason).toBe('CONFIG_ERROR');
    });
});

describe('resolveManifest — telemetry fields', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = {};
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });

    it('prefers the manifest endpoint over the config fallback', async () => {
        const latestManifest = {
            appVersion: 'v1',
            manifest: {
                files: {},
                telemetry: { endpoint: 'https://logs.manifest/collect' },
            },
        };
        const { deps } = setup({
            latestManifest,
            config: { telemetryEndpoint: 'https://logs.config/collect' },
        });
        const ctx = await createManifestService(deps).resolveManifest();
        expect(ctx.telemetryUrl).toBe('https://logs.manifest/collect');
        expect(ctx.appVersion).toBe('v1');
    });

    it('falls back to config.telemetryEndpoint when manifest endpoint is null', async () => {
        const latestManifest = {
            appVersion: 'v2',
            manifest: { files: {}, telemetry: { endpoint: null } },
        };
        const { deps } = setup({
            latestManifest,
            config: { telemetryEndpoint: 'https://logs.config/collect' },
        });
        const ctx = await createManifestService(deps).resolveManifest();
        expect(ctx.telemetryUrl).toBe('https://logs.config/collect');
        expect(ctx.appVersion).toBe('v2');
    });

    it('returns null telemetryUrl when neither manifest nor config supply one', async () => {
        const latestManifest = {
            appVersion: 'v3',
            manifest: { files: {}, telemetry: { endpoint: null } },
        };
        const { deps } = setup({ latestManifest, config: {} });
        const ctx = await createManifestService(deps).resolveManifest();
        expect(ctx.telemetryUrl).toBeNull();
        expect(ctx.appVersion).toBe('v3');
    });

    it('returns null appVersion when no manifest is cached, still honors config endpoint', async () => {
        const { deps } = setup({ config: { telemetryEndpoint: 'https://logs.config/collect' } });
        const ctx = await createManifestService(deps).resolveManifest();
        expect(ctx.telemetryUrl).toBe('https://logs.config/collect');
        expect(ctx.appVersion).toBeNull();
    });

    it('does not leak the raw manifest on the returned context', async () => {
        const latestManifest = {
            appVersion: 'v4',
            manifest: { files: {}, telemetry: { endpoint: 'https://logs/' } },
        };
        const { deps } = setup({ latestManifest });
        const ctx = await createManifestService(deps).resolveManifest();
        expect(ctx).not.toHaveProperty('manifest');
    });
});
