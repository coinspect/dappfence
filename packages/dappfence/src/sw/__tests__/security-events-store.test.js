import { describe, it, expect, beforeEach } from 'vitest';
import { createSecurityEventsStore } from '../storage/security-stores.js';

function createInMemoryDatabase() {
    const store = new Map();
    return {
        get: async (key) => store.get(key),
        set: async (key, value) => store.set(key, value),
    };
}

describe('createSecurityEventsStore', () => {
    let store;

    beforeEach(() => {
        store = createSecurityEventsStore(createInMemoryDatabase());
    });

    describe('logSecurityEvent', () => {
        it('stores an event', async () => {
            await store.logSecurityEvent({ status: 'MISMATCH', fileKey: '/app.js' });
            const events = await store.getSecurityEvents();
            expect(events).toHaveLength(1);
            expect(events[0].status).toBe('MISMATCH');
        });

        it('assigns an id and timestamp to each event', async () => {
            await store.logSecurityEvent({ status: 'MISMATCH' });
            const events = await store.getSecurityEvents();
            expect(events[0].id).toMatch(/^event_/);
            expect(events[0].timestamp).toBeDefined();
        });

        it('preserves provided timestamp', async () => {
            const ts = '2024-01-01T00:00:00.000Z';
            await store.logSecurityEvent({ status: 'MISMATCH', timestamp: ts });
            const events = await store.getSecurityEvents();
            expect(events[0].timestamp).toBe(ts);
        });
    });

    describe('getSecurityEvents', () => {
        it('returns empty array when no events exist', async () => {
            const events = await store.getSecurityEvents();
            expect(events).toEqual([]);
        });

        it('returns events most-recent-first', async () => {
            await store.logSecurityEvent({ status: 'first' });
            await store.logSecurityEvent({ status: 'second' });
            const events = await store.getSecurityEvents();
            expect(events[0].status).toBe('second');
            expect(events[1].status).toBe('first');
        });

        it('respects the limit parameter', async () => {
            for (let i = 0; i < 10; i++) {
                await store.logSecurityEvent({ status: `event-${i}` });
            }
            const events = await store.getSecurityEvents(3);
            expect(events).toHaveLength(3);
        });

        it('caps storage at 1000 events', async () => {
            const db = createInMemoryDatabase();
            const s = createSecurityEventsStore(db);
            // Pre-seed 1000 events
            const events = Array.from({ length: 1000 }, (_, i) => ({
                status: `event-${i}`,
                id: `event_${i}`,
                timestamp: new Date().toISOString(),
            }));
            await db.set('security-events', events);

            // Adding one more should keep total at 1000
            await s.logSecurityEvent({ status: 'overflow' });
            const all = await s.getSecurityEvents(2000);
            expect(all.length).toBeLessThanOrEqual(1000);
        });

        it('returns empty array when database.get rejects', async () => {
            const brokenDb = {
                get: async () => {
                    throw new Error('db error');
                },
                set: async () => {},
            };
            const s = createSecurityEventsStore(brokenDb);
            const result = await s.getSecurityEvents();
            expect(result).toEqual([]);
        });
    });
});
