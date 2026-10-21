/**
 * Site-unblock must only move the signer anchor when a rotation is what the
 * user is accepting.
 *
 * `handleSiteUnblock` writes `config.manifestSignatureIdentity` into the
 * active-identity anchor before clearing blocks, unconditionally — it never
 * reads the active blocks, so it cannot tell "accept this signer rotation"
 * apart from "dismiss this hash-mismatch warning".
 *
 * Two reasons that matters:
 *
 *  1. Scope. The endpoint is named, documented and surfaced in the UI as
 *     "clear the active blocks". Permanently re-rooting manifest trust is a
 *     different action, and the warning page's confirm dialogs describe only
 *     the first one.
 *
 *  2. Verification. The loader was deliberately changed so the anchor can only
 *     ever hold an identity that produced a valid manifest signature (see
 *     "verify the signature before setting the activeIdentity"). This path
 *     bypasses that: it takes an identity straight from the bootstrap config
 *     and persists it without any signature having been checked. If that
 *     identity never signs a storable manifest, the client is left anchored to
 *     a signer it can never satisfy.
 *
 * STATUS: the two "does not re-anchor" tests FAIL against the current
 * implementation. They describe the intended behavior. The SIGNER_CHANGED
 * tests pass today and must keep passing — accepting a real rotation is the
 * reason this write exists at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApiHandler } from '../api-handler.js';
import { API } from '../../core/constants.js';

// response.js reads isFeatureEnabled('auto_confirm_site_lock') at module scope,
// and __FEATURES__ is a build-time define that does not exist under vitest.
// vi.hoisted runs before the import graph is evaluated, so the real
// isFeatureEnabled works instead of being stubbed.
vi.hoisted(() => {
    globalThis.__FEATURES__ = {};
});

const TOKEN = 'test-token-123';
const ANCHORED = { signatureType: 'noble-secp256k1-recovered-eth', identity: '0xANCHORED' };
const CONFIG_IDENTITY = '0xFROM_BOOTSTRAP_HTML';

/** A stored block record, shaped as recordSecurityBlock persists it. */
const block = (status, reason) => ({ status, reason, fileKey: '/app.js', active: true });

function makeAppStore(activeBlocks) {
    return {
        apiTokenStore: { getApiToken: vi.fn().mockResolvedValue(TOKEN) },
        activeBlocksStore: {
            isBlocked: vi.fn().mockResolvedValue(true),
            getActiveBlocks: vi.fn().mockResolvedValue(activeBlocks),
            getAllBlocks: vi.fn().mockResolvedValue(activeBlocks),
            clearBlockCondition: vi.fn().mockResolvedValue(undefined),
        },
        trustedManifestStore: { getLatest: vi.fn().mockResolvedValue(undefined) },
        activeIdentityStore: {
            getActiveIdentity: vi.fn().mockResolvedValue(ANCHORED),
            updateActiveIdentity: vi.fn().mockResolvedValue(undefined),
        },
        verificationResultsStore: { get: vi.fn().mockResolvedValue([]) },
    };
}

function unblockRequest() {
    return new Request(`https://example.com${API.SITE_UNBLOCK}`, {
        method: 'POST',
        headers: { 'X-DappFence-Token': TOKEN },
    });
}

describe('site-unblock and the signer anchor', () => {
    let appStore;
    let handler;

    const arrange = (activeBlocks) => {
        appStore = makeAppStore(activeBlocks);
        handler = createApiHandler({
            onSecurityViolation: vi.fn(),
            appStore,
            config: {
                manifestSignatureType: 'noble-secp256k1-recovered-eth',
                manifestSignatureIdentity: CONFIG_IDENTITY,
            },
        });
    };

    beforeEach(() => vi.clearAllMocks());

    describe('dismissing a block that is not a signer rotation', () => {
        it('clears the blocks but does not re-anchor on FILE_UNTRUSTED', async () => {
            arrange([block('FILE_UNTRUSTED', 'HASH_MISMATCH')]);

            const res = await handler(API.SITE_UNBLOCK, unblockRequest());

            expect(res.status).toBe(200);
            expect(appStore.activeBlocksStore.clearBlockCondition).toHaveBeenCalled();
            expect(appStore.activeIdentityStore.updateActiveIdentity).not.toHaveBeenCalled();
        });

        it('does not re-anchor on a manifest block whose reason is not SIGNER_CHANGED', async () => {
            arrange([block('MANIFEST_UNTRUSTED', 'SIGNATURE_MISMATCH')]);

            await handler(API.SITE_UNBLOCK, unblockRequest());

            expect(appStore.activeIdentityStore.updateActiveIdentity).not.toHaveBeenCalled();
        });
    });

    describe('accepting a signer rotation', () => {
        it('re-anchors to the bootstrap identity on SIGNER_CHANGED', async () => {
            arrange([block('MANIFEST_UNTRUSTED', 'SIGNER_CHANGED')]);

            const res = await handler(API.SITE_UNBLOCK, unblockRequest());

            expect(res.status).toBe(200);
            expect(appStore.activeIdentityStore.updateActiveIdentity).toHaveBeenCalledWith({
                signatureType: 'noble-secp256k1-recovered-eth',
                identity: CONFIG_IDENTITY,
            });
            expect(appStore.activeBlocksStore.clearBlockCondition).toHaveBeenCalled();
        });

        it('re-anchors when a rotation is blocked alongside unrelated violations', async () => {
            arrange([
                block('FILE_UNTRUSTED', 'HASH_MISMATCH'),
                block('MANIFEST_UNTRUSTED', 'SIGNER_CHANGED'),
            ]);

            await handler(API.SITE_UNBLOCK, unblockRequest());

            expect(appStore.activeIdentityStore.updateActiveIdentity).toHaveBeenCalledOnce();
        });
    });
});
