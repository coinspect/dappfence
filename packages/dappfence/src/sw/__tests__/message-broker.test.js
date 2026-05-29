import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMessageBroker, createMessageHandler } from '../message-broker.js';

function createMockSwContext() {
    const clients = [];
    return {
        matchAllClients: async () => clients,
        getClient: async (id) => clients.find((c) => c.id === id),
        claimClients: vi.fn(),
        _addClient(id) {
            const client = { id, postMessage: vi.fn() };
            clients.push(client);
            return client;
        },
    };
}

describe('createMessageBroker', () => {
    let broker;
    let swContext;

    beforeEach(() => {
        swContext = createMockSwContext();
        broker = createMessageBroker(swContext);
    });

    describe('broadcastSecurityViolation', () => {
        it('broadcasts a blockId-less DAPPFENCE_SECURITY_BLOCK with warningUrl', async () => {
            const client1 = swContext._addClient('c1');
            const client2 = swContext._addClient('c2');

            await broker.broadcastSecurityViolation();

            const expected = expect.objectContaining({
                type: 'DAPPFENCE_SECURITY_BLOCK',
                warningUrl: '/sw-api/security-warning',
            });
            expect(client1.postMessage).toHaveBeenCalledWith(expected);
            expect(client2.postMessage).toHaveBeenCalledWith(expected);
            // blockId must no longer be in the payload
            expect(client1.postMessage.mock.calls[0][0]).not.toHaveProperty('blockId');
        });

        it('does not crash when no clients are connected', async () => {
            await expect(broker.broadcastSecurityViolation()).resolves.not.toThrow();
        });
    });

    describe('handleClientReady', () => {
        it('does nothing when no pending messages for client', async () => {
            swContext._addClient('c1');
            await expect(broker.handleClientReady('c1')).resolves.not.toThrow();
        });

        it('sends queued messages when client becomes ready', async () => {
            const client = swContext._addClient('c1');
            await broker.broadcastSecurityViolation();

            client.postMessage.mockClear();
            await broker.handleClientReady('c1');

            expect(client.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'DAPPFENCE_SECURITY_BLOCK' })
            );
        });

        it('clears pending messages after delivery', async () => {
            const client = swContext._addClient('c1');
            await broker.broadcastSecurityViolation();

            client.postMessage.mockClear();
            await broker.handleClientReady('c1');
            client.postMessage.mockClear();
            await broker.handleClientReady('c1');
            expect(client.postMessage).not.toHaveBeenCalled();
        });

        it('handles client not found gracefully', async () => {
            swContext._addClient('c1');
            await broker.broadcastSecurityViolation();

            swContext.getClient = async () => undefined;
            await expect(broker.handleClientReady('c1')).resolves.not.toThrow();
        });

        it('handles getClient rejecting without throwing', async () => {
            swContext._addClient('c1');
            await broker.broadcastSecurityViolation();

            swContext.getClient = async () => {
                throw new Error('clients.get() failed');
            };
            await expect(broker.handleClientReady('c1')).resolves.not.toThrow();
        });
    });

    describe('broadcastSecurityViolation error paths', () => {
        it('handles matchAllClients rejecting without throwing', async () => {
            swContext.matchAllClients = async () => {
                throw new Error('matchAllClients failed');
            };
            await expect(broker.broadcastSecurityViolation()).resolves.not.toThrow();
        });

        it('handles client.postMessage rejecting without throwing', async () => {
            const client = swContext._addClient('c1');
            client.postMessage.mockRejectedValue(new Error('postMessage failed'));
            await expect(broker.broadcastSecurityViolation()).resolves.not.toThrow();
        });
    });
});

describe('createMessageHandler', () => {
    it('calls onClientReady on DAPPFENCE_CLIENT_READY message', async () => {
        const onClientReady = vi.fn();
        const swContext = createMockSwContext();
        const handler = createMessageHandler({ swContext, onClientReady });
        const callChildHandlers = vi.fn();

        await handler(
            { data: { type: 'DAPPFENCE_CLIENT_READY' }, source: { id: 'c1' } },
            callChildHandlers
        );

        expect(onClientReady).toHaveBeenCalledWith('c1');
        expect(callChildHandlers).toHaveBeenCalled();
    });

    it('calls claimClients on CLAIM_CONTROL message', async () => {
        const onClientReady = vi.fn();
        const swContext = createMockSwContext();
        const handler = createMessageHandler({ swContext, onClientReady });
        const callChildHandlers = vi.fn();

        await handler({ data: { type: 'CLAIM_CONTROL' } }, callChildHandlers);

        expect(swContext.claimClients).toHaveBeenCalled();
        expect(onClientReady).not.toHaveBeenCalled();
        expect(callChildHandlers).toHaveBeenCalled();
    });

    it('passes unknown messages to child handlers', async () => {
        const onClientReady = vi.fn();
        const swContext = createMockSwContext();
        const handler = createMessageHandler({ swContext, onClientReady });
        const callChildHandlers = vi.fn();

        await handler({ data: { type: 'UNKNOWN' } }, callChildHandlers);

        expect(onClientReady).not.toHaveBeenCalled();
        expect(callChildHandlers).toHaveBeenCalled();
    });
});
