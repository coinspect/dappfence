import { createServices } from './services.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger();

/**
 * Main Service Worker Module
 * Initializes protection and registers event handlers.
 */
export function initializeServiceWorker() {
    logger.log('Initializing service worker protection');

    const {
        hookService,
        fetchHandler,
        installHandler,
        activateHandler,
        messageHandler,
        syncHandler,
        securityProcessor,
    } = createServices(self);

    hookService.installHooks();

    hookService.addEventListener('fetch', (event, callChildHandlers) => {
        logger.log('Security SW fetch');
        const fetchPromise = fetchHandler(event, callChildHandlers);
        event.respondWith(fetchPromise);
        event.waitUntil(fetchPromise.finally(() => securityProcessor.reportAfterFetch(event)));
    });

    hookService.addEventListener('install', (event, callChildHandlers) => {
        logger.log('Security SW installing');
        event.waitUntil(installHandler(event, callChildHandlers));
    });

    hookService.addEventListener('activate', (event, callChildHandlers) => {
        logger.log('Security SW activate');
        event.waitUntil(activateHandler(event, callChildHandlers));
    });

    hookService.addEventListener('message', (event, callChildHandlers) => {
        event.waitUntil(messageHandler(event, callChildHandlers));
    });
    hookService.addEventListener('sync', (event) => {
        event.waitUntil(syncHandler(event));
    });
    hookService.addDefaultEventListeners();

    logger.log('Service worker protection initialized');
}
