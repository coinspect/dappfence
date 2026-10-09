/**
 * Message Broker & Handler
 * Handles queuing and delivery of security messages to clients,
 * and dispatches incoming messages (CLAIM_CONTROL, DAPPFENCE_CLIENT_READY, etc.)
 */

import { API, MSG } from '../core/constants.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger();

async function sendPendingMessages(pendingMessages, client) {
    const clientId = client.id;
    logger.log(`Sending ${pendingMessages.length} pending security messages to client ${clientId}`);

    for (const message of pendingMessages) {
        try {
            await client.postMessage(message);
            logger.log(`Sent pending message to client ${clientId}`);
        } catch (error) {
            logger.error(`Failed to send pending message to client ${clientId}:`, error);
        }
    }
}

/**
 * @param {object} swContext
 */
export function createMessageBroker(swContext) {
    const pendingMessages = new Map();

    async function broadcastSecurityViolation() {
        try {
            const allClients = await swContext.matchAllClients({
                type: 'window',
                includeUncontrolled: true,
            });

            const message = {
                type: MSG.SECURITY_BLOCK,
                warningUrl: API.SECURITY_WARNING,
                timestamp: Date.now(),
            };

            logger.log(
                `%cBroadcasting security violation to ${allClients.length} clients`,
                'color:red',
                'clientIds',
                allClients.map((c) => c.id)
            );

            for (const client of allClients) {
                if (!pendingMessages.has(client.id)) {
                    pendingMessages.set(client.id, []);
                }
                pendingMessages.get(client.id).push(message);
                logger.log(`Queued security message for client ${client.id}`);
            }
            for (const client of allClients) {
                sendPendingMessages(pendingMessages.get(client.id), client).catch((error) =>
                    logger.error(`Failed to send pending messages to client ${client.id}:`, error)
                );
            }

            logger.log(`Security messages queued for ${allClients.length} clients`);
        } catch (error) {
            logger.error('Failed to broadcast security violation:', error);
        }
    }

    async function handleClientReady(clientId) {
        try {
            logger.log(`handleClientReady called with clientId: ${clientId}`);

            const messages = pendingMessages.get(clientId) || [];
            logger.log(`Found ${messages.length} pending messages for client ${clientId}`);
            if (messages.length === 0) {
                logger.log(`No pending messages for client ${clientId}`);
                return;
            }

            const client = await swContext.getClient(clientId);
            if (!client) {
                logger.warn(`Client ${clientId} not found in clients.get()`);
            } else {
                await sendPendingMessages(messages, client);
                pendingMessages.delete(clientId);
                logger.log(`Cleared pending messages for client ${clientId}`);
            }
        } catch (error) {
            logger.error('Error handling client ready:', error);
        }
    }

    return { broadcastSecurityViolation, handleClientReady };
}

/**
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {function} deps.onClientReady
 */
export function createMessageHandler({ swContext, onClientReady }) {
    return async (event, callChildHandlers) => {
        logger.log('Received message:', event.data);

        if (event.data && event.data.type === MSG.CLAIM_CONTROL) {
            logger.log('CLAIM_CONTROL - Client requested control - claiming all clients');
            await swContext.claimClients();
        } else if (event.data && event.data.type === MSG.CLIENT_READY) {
            logger.log(
                `Client ready - event.source.id: ${event.source.id}, event.source type: ${typeof event.source}`
            );
            await onClientReady(event.source.id);
        } else {
            logger.log('Received message:', event.data);
        }
        callChildHandlers(event);
    };
}
