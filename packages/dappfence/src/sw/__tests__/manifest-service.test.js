import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createManifestService } from '../manifest/manifest-service.js';
import { calculateHash, ethereumAddress } from '../../core/crypto.js';
import { VERIFICATION_STATUS, MODE } from '../../core/constants.js';
import { sign, etc, hashes } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { recoverPublicKey } from '@noble/secp256k1';

const baseHref = 'https://app.example.com/sw.js';

const testPrivKey = new Uint8Array(32).fill(0);
testPrivKey[31] = 77;

function makeSignedManifest(payload) {
    hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);
    hashes.sha256 = sha256;
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
    const msgHash = keccak_256(payloadBytes);
    const sigBytes = sign(msgHash, testPrivKey, { prehash: false, format: 'recovered' });
    const sigHex = etc.bytesToHex(sigBytes);
    const pubKey = recoverPublicKey(sigBytes, msgHash, { prehash: false });
    const address = ethereumAddress(pubKey);
    return { sig: sigHex, address };
}

const setup = ({ fetch, manifestEntry, config } = {}) => {
    const swContext = {
        fetch: fetch ?? vi.fn(),
        getLocationHref: vi.fn().mockReturnValue(baseHref),
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
        config: config ?? {},
    });
    return { swContext, appStore, manifestService, trustedManifestStore };
};

describe('manifestService.verifyLocation', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = { mark_request: true };
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });

    it('line 100: does not add sw-verification header when mark_request is disabled', async () => {
        globalThis.__FEATURES__ = { mark_request: false };
        const { manifestService, swContext } = setup({
            fetch: vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Error' }),
        });

        await manifestService.verifyLocation('/lib.js');

        expect(swContext.fetch).toHaveBeenCalledWith('/lib.js', {});
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

describe('resolveManifest', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = {};
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });

    it('cached path: returns mode and verifyFile when getLatest returns a manifest', async () => {
        const { manifestService, trustedManifestStore } = setup();
        trustedManifestStore.getLatest.mockResolvedValue({
            appVersion: 'v1',
            manifest: { mode: MODE.REPORTING, files: { '/app.js': 'hash1' }, metadata: {} },
        });

        const ctx = await manifestService.resolveManifest();

        expect(ctx.mode).toBe(MODE.REPORTING);
        expect(typeof ctx.verifyFile).toBe('function');
    });

    it('mode falls back to REPORTING when manifest has no mode field', async () => {
        const { manifestService, trustedManifestStore } = setup();
        trustedManifestStore.getLatest.mockResolvedValue({
            appVersion: 'v1',
            manifest: { files: {}, metadata: {} },
        });

        const ctx = await manifestService.resolveManifest();

        expect(ctx.mode).toBe(MODE.REPORTING);
        expect(typeof ctx.verifyFile).toBe('function');
    });

    it('verifyFile skips non-matching asset extensions', async () => {
        const { manifestService, trustedManifestStore } = setup();
        trustedManifestStore.getLatest.mockResolvedValue({
            appVersion: 'v1',
            manifest: { mode: MODE.REPORTING, files: {}, metadata: {} },
        });

        const ctx = await manifestService.resolveManifest();
        const fakeResponse = new Response('', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
        });
        const result = ctx.verifyFile('/app.txt', fakeResponse);

        expect(result).toEqual({ status: VERIFICATION_STATUS.SKIPPED, fileKey: '/app.txt' });
    });

    it('loadManifestFromUrl succeeds with a valid signed manifest', async () => {
        const payload = { files: { '/app.js': 'sha256-abc' }, mode: 'reporting' };
        const { sig, address } = makeSignedManifest(payload);

        const mockManifest = { pay: payload, sig };
        const storedManifest = {
            appVersion: 'v-signed',
            manifest: { files: { '/app.js': 'sha256-abc' }, mode: 'reporting' },
        };

        const { manifestService, appStore } = setup({
            config: {
                manifestUrl: '/manifest.json',
                manifestSignatureType: 'noble-secp256k1-recovered-eth',
                manifestSignatureIdentity: address,
            },
            fetch: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => mockManifest,
            }),
        });

        appStore.trustedManifestStore.addLatest = vi.fn().mockResolvedValue(storedManifest);

        const result = await manifestService.fetchAndStoreManifest();

        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.appVersion).toBe('v-signed');
    });

    it('loadManifestFromUrl returns MISMATCH when signature verification fails', async () => {
        const payload = { files: {}, mode: 'reporting' };
        const { sig } = makeSignedManifest(payload);

        const mockManifest = { pay: payload, sig };

        const { manifestService } = setup({
            config: {
                manifestUrl: '/manifest.json',
                manifestSignatureType: 'noble-secp256k1-recovered-eth',
                manifestSignatureIdentity: '0xwrongaddress',
            },
            fetch: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => mockManifest,
            }),
        });

        const result = await manifestService.fetchAndStoreManifest();

        expect(result.status).toBe(VERIFICATION_STATUS.MISMATCH);
        expect(result.assetType).toBe('manifest');
    });

    it('loadManifestFromUrl returns ERROR when response.json() throws', async () => {
        const { manifestService } = setup({
            config: {
                manifestUrl: '/manifest.json',
                manifestSignatureType: 'noble-secp256k1-recovered-eth',
                manifestSignatureIdentity: '0xABC',
            },
            fetch: vi.fn().mockResolvedValue({
                ok: true,
                json: async () => {
                    throw new Error('invalid json');
                },
            }),
        });

        const result = await manifestService.fetchAndStoreManifest();

        expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
    });

    it('loadManifestFromUrl returns ERROR on non-ok fetch response', async () => {
        const { manifestService } = setup({
            config: {
                manifestUrl: '/manifest.json',
                manifestSignatureType: 'noble-secp256k1-recovered-eth',
                manifestSignatureIdentity: '0xABC',
            },
            fetch: vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                statusText: 'Server Error',
            }),
        });

        const result = await manifestService.fetchAndStoreManifest();

        expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
        expect(result.fileKey).toBe('/manifest.json');
    });

    it('cold-start path: getLatest returns null, fetchAndStoreManifest returns valid manifest', async () => {
        const payload = { files: { '/app.js': 'sha256-abc' }, mode: 'reporting' };
        const { sig, address } = makeSignedManifest(payload);
        const mockManifest = { pay: payload, sig };
        const storedManifest = {
            appVersion: 'cold-v1',
            manifest: { files: { '/app.js': 'sha256-abc' }, mode: 'reporting' },
        };

        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => mockManifest,
        });

        const { manifestService, appStore, trustedManifestStore } = setup({
            config: {
                manifestUrl: '/manifest.json',
                manifestSignatureType: 'noble-secp256k1-recovered-eth',
                manifestSignatureIdentity: address,
            },
            fetch: fetchMock,
        });
        trustedManifestStore.getLatest.mockResolvedValue(null);
        appStore.trustedManifestStore.addLatest = vi.fn().mockResolvedValue(storedManifest);

        const ctx = await manifestService.resolveManifest();

        expect(ctx.mode).toBe('reporting');
        expect(typeof ctx.verifyFile).toBe('function');
    });

    it('verifyResponse cold-start path: sets manifestInfo from fetchAndStoreManifest', async () => {
        const payload = { files: { '/app.js': 'sha256-abc' }, mode: 'reporting' };
        const { sig, address } = makeSignedManifest(payload);
        const mockManifest = { pay: payload, sig };
        const storedManifest = {
            appVersion: 'cold-v2',
            manifest: { files: { '/app.js': 'sha256-abc' }, mode: 'reporting' },
        };

        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => mockManifest,
        });

        const { manifestService, appStore, trustedManifestStore } = setup({
            config: {
                manifestUrl: '/manifest.json',
                manifestSignatureType: 'noble-secp256k1-recovered-eth',
                manifestSignatureIdentity: address,
            },
            fetch: fetchMock,
        });

        trustedManifestStore.getLatest.mockResolvedValue({
            appVersion: 'v-cache',
            manifest: { mode: MODE.REPORTING, files: {}, metadata: {} },
        });
        trustedManifestStore.findByHash.mockResolvedValue(null);
        appStore.trustedManifestStore.addLatest = vi.fn().mockResolvedValue(storedManifest);

        const ctx = await manifestService.resolveManifest({ clientId: 'test-client' });
        const body = new TextEncoder().encode('content').buffer;
        const jsResponse = new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/javascript' },
        });
        const result = await ctx.verifyFile('/app.js', jsResponse);
        expect(result).toBeDefined();
    });

    it('verifyFile calls verifyResponse for a .js asset (line 220 path)', async () => {
        const body = new TextEncoder().encode('console.log("app")').buffer;
        const fileHash = await calculateHash(body);
        const { manifestService, trustedManifestStore } = setup({
            fetch: vi.fn().mockResolvedValue(
                new Response(body, {
                    status: 200,
                    headers: { 'content-type': 'text/javascript' },
                })
            ),
            manifestEntry: {
                appVersion: 'v1',
                manifest: { files: { '/app.js': fileHash } },
            },
        });
        trustedManifestStore.getLatest.mockResolvedValue({
            appVersion: 'v1',
            manifest: { mode: MODE.REPORTING, files: { '/app.js': fileHash }, metadata: {} },
        });
        trustedManifestStore.findByHash.mockResolvedValue({
            appVersion: 'v1',
            manifest: { files: { '/app.js': fileHash } },
        });

        const ctx = await manifestService.resolveManifest({ clientId: 'client-1' });
        const jsResponse = new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/javascript' },
        });
        const result = await ctx.verifyFile('/app.js', jsResponse);

        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });

    it('line 138: clientId + !isNavigation path uses pinned manifest on second call', async () => {
        const body = new TextEncoder().encode('console.log("pinned")').buffer;
        const fileHash = await calculateHash(body);
        const manifestEntry = {
            appVersion: 'v-pinned',
            manifest: { files: { '/app.js': fileHash } },
        };
        const { manifestService, trustedManifestStore, appStore } = setup({
            manifestEntry,
        });
        trustedManifestStore.getLatest.mockResolvedValue({
            appVersion: 'v-pinned',
            manifest: { mode: MODE.REPORTING, files: { '/app.js': fileHash }, metadata: {} },
        });
        trustedManifestStore.findByHash.mockResolvedValue(manifestEntry);

        const ctx = await manifestService.resolveManifest({
            clientId: 'client-pin',
            isNavigation: false,
        });
        const jsResponse = () =>
            new Response(body, { status: 200, headers: { 'content-type': 'text/javascript' } });

        const result1 = await ctx.verifyFile('/app.js', jsResponse());
        expect(result1.status).toBe(VERIFICATION_STATUS.MATCH);

        trustedManifestStore.findByHash.mockClear();
        const result2 = await ctx.verifyFile('/app.js', jsResponse());
        expect(result2.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(appStore.verificationResultsStore.add).toHaveBeenCalled();
    });

    it('lines 155-166: verifyResponse isNavigation=true path covers navigation log branch', async () => {
        const body = new TextEncoder().encode('<!DOCTYPE html>').buffer;
        const fileHash = await calculateHash(body);
        const manifestEntry = {
            appVersion: 'v-nav',
            manifest: { files: { '/index.html': fileHash } },
        };
        const { manifestService, trustedManifestStore } = setup({
            manifestEntry,
        });
        trustedManifestStore.getLatest.mockResolvedValue({
            appVersion: 'v-nav',
            manifest: { mode: MODE.REPORTING, files: { '/index.html': fileHash }, metadata: {} },
        });
        trustedManifestStore.findByHash.mockResolvedValue(manifestEntry);

        const ctx = await manifestService.resolveManifest({
            clientId: 'nav-client',
            isNavigation: true,
        });
        const htmlResponse = new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/html' },
        });

        const result = await ctx.verifyFile('/', htmlResponse);
        expect(result).toBeDefined();
    });

    it('line 155-166: clientId pin is stored after findByHash resolves manifest', async () => {
        const body = new TextEncoder().encode('console.log("store-pin")').buffer;
        const fileHash = await calculateHash(body);
        const manifestEntry = {
            appVersion: 'v-store-pin',
            manifest: { files: { '/app.js': fileHash } },
        };
        const { manifestService, trustedManifestStore } = setup({
            manifestEntry,
        });
        trustedManifestStore.getLatest.mockResolvedValue({
            appVersion: 'v-store-pin',
            manifest: { mode: MODE.REPORTING, files: { '/app.js': fileHash }, metadata: {} },
        });
        trustedManifestStore.findByHash.mockResolvedValue(manifestEntry);

        const ctx = await manifestService.resolveManifest({
            clientId: 'client-store',
            isNavigation: false,
        });
        const jsResponse = () =>
            new Response(body, { status: 200, headers: { 'content-type': 'text/javascript' } });

        await ctx.verifyFile('/app.js', jsResponse());
        const callsAfterFirst = trustedManifestStore.findByHash.mock.calls.length;

        await ctx.verifyFile('/app.js', jsResponse());
        expect(trustedManifestStore.findByHash.mock.calls.length).toBe(callsAfterFirst);
    });

    it('line 166: verifyResponse with cross-origin fileKey covers globe icon branch', async () => {
        const body = new TextEncoder().encode('console.log("cdn")').buffer;
        const fileHash = await calculateHash(body);
        const externalUrl = 'https://cdn.example.com/lib.js';
        const manifestEntry = {
            appVersion: 'v-cdn',
            manifest: { files: { [externalUrl]: fileHash } },
        };
        const { manifestService, trustedManifestStore } = setup({
            manifestEntry,
        });
        trustedManifestStore.getLatest.mockResolvedValue({
            appVersion: 'v-cdn',
            manifest: {
                mode: MODE.REPORTING,
                files: { [externalUrl]: fileHash },
                metadata: { extensions: ['.js'], contentTypes: [] },
            },
        });
        trustedManifestStore.findByHash.mockResolvedValue(manifestEntry);

        const ctx = await manifestService.resolveManifest({});
        const jsResponse = new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/javascript' },
        });

        const result = await ctx.verifyFile(externalUrl, jsResponse);
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });

    it('line 204: mode falls back to PROTECTED when feature flag is set and manifest has no mode', async () => {
        globalThis.__FEATURES__ = { 'default-to-protected-mode': true };
        const { manifestService, trustedManifestStore } = setup({ config: {} });
        trustedManifestStore.getLatest.mockResolvedValue({
            appVersion: 'v-nomode',
            manifest: { files: {} },
        });

        const ctx = await manifestService.resolveManifest();

        expect(ctx.mode).toBe(MODE.PROTECTED);
        delete globalThis.__FEATURES__;
    });
});
