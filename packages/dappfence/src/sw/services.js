/**
 * Service Worker Services Factory
 * Creates and wires all dependencies, returning the handlers that main.js registers.
 */

import { createSecurityFetchHandler } from './fetch-handler.js';
import { createActivateHandler, createInstallHandler } from './lifecycle-handlers.js';
import { createHookService, verifyImportedScript } from './appsw-hooks.js';
import { createManifestService } from './manifest/manifest-service.js';
import { createMessageBroker, createMessageHandler } from './message-broker.js';
import { createDatabase } from './storage/indexeddb.js';
import { createAppStore } from './storage/index.js';
import { createSwContext } from './context.js';
import { createLogger } from '../core/logger.js';
import { createApiHandler } from './api-handler.js';

const logger = createLogger();

function parseConfig(swContext) {
    const url = new URL(swContext.getLocation());
    return {
        appSW: url.searchParams.get('appSW'),
        manifestUrl: url.searchParams.get('manifestUrl') || '/integrity-manifest.json',
        manifestSignatureType: url.searchParams.get('manifestSignatureType'),
        manifestSignatureIdentity: url.searchParams.get('manifestSignatureIdentity'),
    };
}

/**
 * Creates and wires all service worker dependencies.
 * @param {object} swGlobal - The service worker global scope (self)
 * @returns {{ hookService: object, fetchHandler: function, installHandler: function, activateHandler: function, messageHandler: function }}
 */
export function createServices(swGlobal) {
    const swContext = createSwContext(swGlobal);
    const config = parseConfig(swContext);
    logger.log('Configuration:', config);

    const appStore = createAppStore(createDatabase(swGlobal.indexedDB), {
        userAgent: swContext.getUserAgent(),
        origin: swContext.getLocationOrigin(),
    });

    const manifestService = createManifestService({ swContext, appStore, config });
    const messageBroker = createMessageBroker(swContext);
    const core = {
        swContext,
        appStore,
        manifestService,
        onSecurityViolation: messageBroker.broadcastSecurityViolation,
    };

    const hookService = createHookService((scriptPath) => verifyImportedScript(core, scriptPath));
    const handleApiEndpoint = createApiHandler(core);

    return {
        hookService,
        fetchHandler: createSecurityFetchHandler({ ...core, handleApiEndpoint }),
        installHandler: createInstallHandler({
            ...core,
            config,
            onInstallDone: hookService.installEventDone,
        }),
        activateHandler: createActivateHandler(core),
        messageHandler: createMessageHandler({
            swContext,
            onClientReady: messageBroker.handleClientReady,
        }),
    };
}
