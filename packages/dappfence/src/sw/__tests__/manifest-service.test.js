import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createManifestService } from '../manifest/manifest-service.js';
import { calculateHash } from '../../core/crypto.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

const baseHref = 'https://app.example.com/sw.js';

const setup = ({ fetch, manifestEntry } = {}) => {
    const swContext = {
        fetch: fetch ?? vi.fn(),
        getLocationHref: vi.fn().mockReturnValue(baseHref),
        getLocationOrigin: vi.fn().mockReturnValue(new URL(baseHref).origin),
    };
    const trustedManifestStore = {
        findByHash: vi.fn().mockResolvedValue(manifestEntry ?? null),
        getLatest: vi.fn(),
        addLatest: vi.fn(),
    };
    const verificationResultsStore = { add: vi.fn().mockResolvedValue() };
    const appStore = { trustedManifestStore, verificationResultsStore };
    const manifestService = createManifestService({
        swContext,
        appStore,
        config: {},
    });
    return { swContext, appStore, manifestService };
};

describe('manifestService.verifyLocation', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = { mark_request: true };
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });

    it('marks the fetch with the sw-verification header when mark_request is enabled', async () => {
        const { manifestService, swContext } = setup({
            fetch: vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Error' }),
        });

        await manifestService.verifyLocation('/lib.js');

        expect(swContext.fetch).toHaveBeenCalledWith('/lib.js', {
            headers: { 'x-dappfence': 'sw-verification' },
        });
    });

    it('returns ERROR on a non-ok fetch response', async () => {
        const { manifestService } = setup({
            fetch: vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }),
        });

        const result = await manifestService.verifyLocation('/missing.js');

        expect(result).toEqual({ status: VERIFICATION_STATUS.ERROR });
    });

    it('returns ERROR when fetch throws', async () => {
        const { manifestService } = setup({
            fetch: vi.fn().mockRejectedValue(new Error('network down')),
        });

        const result = await manifestService.verifyLocation('/lib.js');

        expect(result).toEqual({ status: VERIFICATION_STATUS.ERROR });
    });

    it('returns MATCH when the file hash is in a stored manifest', async () => {
        const body = new TextEncoder().encode('console.log("hello")').buffer;
        const fileHash = await calculateHash(body);
        const manifestEntry = {
            appVersion: 'manifest-abc',
            manifest: { files: { '/lib.js': fileHash } },
        };
        const { manifestService, appStore } = setup({
            fetch: vi.fn().mockResolvedValue(
                new Response(body, {
                    status: 200,
                    headers: { 'content-type': 'text/javascript' },
                })
            ),
            manifestEntry,
        });

        const result = await manifestService.verifyLocation('/lib.js');

        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.fileKey).toBe('/lib.js');
        expect(result.actualHash).toBe(fileHash);
        expect(appStore.verificationResultsStore.add).toHaveBeenCalledWith(
            'manifest-abc',
            expect.objectContaining({ status: VERIFICATION_STATUS.MATCH.description })
        );
    });

    it('returns CONFIG_ERROR when no manifest is available and config has no manifestUrl', async () => {
        const body = new TextEncoder().encode('console.log("hello")').buffer;
        const { manifestService } = setup({
            fetch: vi.fn().mockResolvedValue(
                new Response(body, {
                    status: 200,
                    headers: { 'content-type': 'text/javascript' },
                })
            ),
            manifestEntry: null,
        });

        const result = await manifestService.verifyLocation('/lib.js');

        expect(result.status).toBe(VERIFICATION_STATUS.CONFIG_ERROR);
    });
});
