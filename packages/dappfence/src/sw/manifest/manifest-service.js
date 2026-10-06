/**
 * Manifest Service
 * Composes manifest loading and file verification into the public API.
 */

import { MODE } from '../../core/constants.js';
import { isFeatureEnabled } from '../../core/utils.js';
import { createManifestLoader } from './manifest-loader.js';
import {
    basicVerifyAgainstManifest,
    createVerifier,
    securityVerifyAgainstManifest,
} from './security-verifier.js';
import { createLogger } from '../../core/logger.js';
import { isRequestAllowed } from './rules.js';

const logger = createLogger();

const getEffectiveMode = (manifest) =>
    manifest?.mode ||
    (isFeatureEnabled('default_to_protected_mode') ? MODE.PROTECTED : MODE.REPORTING);

/**
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.config
 */
export const createManifestService = (deps) => {
    const manifestLoader = createManifestLoader(deps);
    const strategy = isFeatureEnabled('enforce_content_rules')
        ? { verifyAgainstManifest: securityVerifyAgainstManifest, isAllowed: isRequestAllowed }
        : { verifyAgainstManifest: basicVerifyAgainstManifest, isAllowed: () => false };
    const verifier = createVerifier(deps, manifestLoader, strategy);

    const resolveManifest = async () => {
        const latestManifest = await manifestLoader.resolveLatest();
        const mode = getEffectiveMode(latestManifest?.manifest);
        logger.log(`Resolved manifest ${latestManifest?.appVersion} with mode ${mode}`);

        return {
            mode,
            prepareRequest: (request) => verifier.prepareRequest(request, latestManifest),
            verifyResponse: (req, response, clientId = null) =>
                verifier.verifyResponse(req, response, clientId, latestManifest),
        };
    };

    return {
        fetchAndStoreManifest: manifestLoader.fetchAndStoreManifest,
        resolveManifest,
    };
};
