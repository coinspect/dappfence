import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createManifestService } from '../manifest/manifest-service.js';
import { calculateHash } from '../../core/crypto.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

const baseHref = 'https://app.example.com/sw.js';

const setup = ({ fetch, manifestEntry, config } = {}) => {
    const swContext = {
        fetch: fetch ?? vi.fn(),
        getLocationHref: vi.fn().mockReturnValue(baseHref),
        getLocationOrigin: vi.fn().mockReturnValue(new URL(baseHref).origin),
    };
    const trustedManifestStore = {
        findByHash: vi.fn().mockResolvedValue(manifestEntry ?? null),
        getLatest: vi.fn().mockResolvedValue(manifestEntry ?? null),
        addLatest: vi.fn(),
    };
    const verificationResultsStore = { add: vi.fn().mockResolvedValue() };
    const appStore = { trustedManifestStore, verificationResultsStore };
    const manifestService = createManifestService({
        swContext,
        appStore,
        config: config ?? {},
    });
    return { swContext, appStore, manifestService };
};

const scriptRequest = (url) => ({
    url,
    destination: 'script',
    method: 'GET',
    mode: '',
});

describe('manifestService.resolveManifest → verifyResponse', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = { mark_request: true };
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });

    it('returns MATCH when the file hash is in a stored manifest', async () => {
        const body = new TextEncoder().encode('console.log("hello")').buffer;
        const fileHash = await calculateHash(body);
        const manifestEntry = {
            appVersion: 'manifest-abc',
            manifest: { files: { '/lib.js': fileHash } },
        };
        const { manifestService, appStore } = setup({ manifestEntry });

        const ctx = await manifestService.resolveManifest();
        const response = new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/javascript' },
        });
        const result = await ctx.verifyResponse(scriptRequest('/lib.js'), response);

        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.fileKey).toBe('/lib.js');
        expect(result.actualHash).toBe(fileHash);
        expect(appStore.verificationResultsStore.add).toHaveBeenCalledWith(
            'manifest-abc',
            expect.objectContaining({ status: VERIFICATION_STATUS.MATCH.description })
        );
    });

    it('returns CONFIG_ERROR from fetchAndStoreManifest when config has no manifestUrl', async () => {
        const { manifestService } = setup();

        const result = await manifestService.fetchAndStoreManifest();

        expect(result.status).toBe(VERIFICATION_STATUS.CONFIG_ERROR);
    });
});
