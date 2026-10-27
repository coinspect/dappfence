/**
 * Service Worker Services Factory
 * Creates and wires all dependencies, returning the handlers that main.js registers.
 */

import { createSecurityFetchHandler } from './fetch-handler.js';
import {
    createActivateHandler,
    createInstallHandler,
    createSyncHandler,
} from './lifecycle-handlers.js';
import { createHookService } from './appsw-hooks.js';
import { verifyImportedScript } from './manifest/verification.js';
import { createManifestService } from './manifest/manifest-service.js';
import { createMessageBroker, createMessageHandler } from './message-broker.js';
import { createAppStore } from './storage/index.js';
import { createSwContext } from './context.js';
import { createLogger } from '../core/logger.js';
import { createApiHandler } from './api-handler.js';
import { createSecurityProcessor } from './security-processor.js';

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
 */
export function createServices(swGlobal) {
    const swContext = createSwContext(swGlobal);
    const config = parseConfig(swContext);
    logger.log('Configuration:', config);

    const appStore = createAppStore(swGlobal.indexedDB);
    const securityProcessor = createSecurityProcessor({ appStore });

    const manifestService = createManifestService({ swContext, appStore, config });
    const messageBroker = createMessageBroker(swContext);
    const core = {
        swContext,
        appStore,
        manifestService,
        securityProcessor,
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
        syncHandler: createSyncHandler({ securityProcessor }),
        messageHandler: createMessageHandler({
            swContext,
            onClientReady: messageBroker.handleClientReady,
            onReportEventsMessage: securityProcessor.reportOnClientRequest,
            onPageLoadedMessage: securityProcessor.reportOnPageLoad,
        }),
        securityProcessor,
    };
}
