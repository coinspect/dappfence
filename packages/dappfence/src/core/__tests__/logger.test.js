import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Logger module keeps per-realm state (singleton, buffer, bufferSkipDepth,
 * currentMinLevel) at module scope. Every test imports a fresh copy via
 * `vi.resetModules()` + dynamic import so state can't leak across cases.
 */
async function freshLogger() {
    vi.resetModules();
    const mod = await import('../logger.js');
    return mod.createLogger();
}

describe('createLogger — SW realm', () => {
    let debugSpy, logSpy, warnSpy, errorSpy;

    beforeEach(() => {
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('console emission', () => {
        it('.debug writes to console.debug when floor allows', async () => {
            const logger = await freshLogger();
            logger.setMinLevel('debug');
            logger.debug('hello');
            expect(debugSpy).toHaveBeenCalledTimes(1);
            expect(logSpy).not.toHaveBeenCalled();
        });

        it('.log writes to console.log', async () => {
            const logger = await freshLogger();
            logger.log('hello');
            expect(logSpy).toHaveBeenCalledTimes(1);
        });

        it('.warn writes to console.warn', async () => {
            const logger = await freshLogger();
            logger.warn('hello');
            expect(warnSpy).toHaveBeenCalledTimes(1);
        });

        it('.error writes to console.error', async () => {
            const logger = await freshLogger();
            logger.error('hello');
            expect(errorSpy).toHaveBeenCalledTimes(1);
        });

        it('prefixes args with [HH:MM:SS.mmm] [DappFence SW]', async () => {
            const logger = await freshLogger();
            logger.log('hello');
            const [prefix, body] = logSpy.mock.calls[0];
            expect(prefix).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[DappFence SW\]$/);
            expect(body).toBe('hello');
        });

        it('folds prefix into %c format strings so console styling still applies', async () => {
            const logger = await freshLogger();
            logger.log('%cstyled', 'color: red');
            const [styled, color] = logSpy.mock.calls[0];
            expect(styled).toMatch(/^%c\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[DappFence SW\] styled$/);
            expect(color).toBe('color: red');
        });
    });

    describe('buffer (SW)', () => {
        it('admits a .log entry with {ts, level, args}', async () => {
            const logger = await freshLogger();
            logger.log('a');
            const [entry, ...rest] = logger.getPendingLogs();
            expect(rest).toEqual([]);
            expect(entry.level).toBe('log');
            expect(entry.args).toEqual(['a']);
            expect(typeof entry.ts).toBe('number');
            expect(entry.count).toBeUndefined();
        });

        it('dedups consecutive identical entries via count; ts stays first-occurrence', async () => {
            const logger = await freshLogger();
            const before = Date.now();
            logger.log('a');
            const firstTs = logger.getPendingLogs()[0].ts;
            logger.log('a');
            logger.log('a');
            logger.log('a');
            const pending = logger.getPendingLogs();
            expect(pending).toHaveLength(1);
            expect(pending[0].count).toBe(3);
            expect(pending[0].ts).toBeLessThanOrEqual(firstTs);
            expect(pending[0].ts).toBeGreaterThanOrEqual(before);
        });

        it('breaks dedup on different level or different args', async () => {
            const logger = await freshLogger();
            logger.log('a');
            logger.warn('a');
            logger.log('b');
            expect(logger.getPendingLogs()).toHaveLength(3);
        });

        it('caps buffer at 500 entries (evicts oldest)', async () => {
            const logger = await freshLogger();
            for (let i = 0; i < 501; i++) {
                logger.log(`msg-${i}`);
            }
            const pending = logger.getPendingLogs();
            expect(pending).toHaveLength(500);
            expect(pending[0].args).toEqual(['msg-1']);
            expect(pending[499].args).toEqual(['msg-500']);
        });

        it('getPendingLogs empties the buffer', async () => {
            const logger = await freshLogger();
            logger.log('a');
            expect(logger.getPendingLogs()).toHaveLength(1);
            expect(logger.getPendingLogs()).toEqual([]);
        });

        it('.debug admits to buffer with level "debug"', async () => {
            const logger = await freshLogger();
            logger.setMinLevel('debug');
            logger.debug('x');
            const [entry] = logger.getPendingLogs();
            expect(entry.level).toBe('debug');
        });
    });

    describe('setMinLevel', () => {
        it('default floor is "log"; .debug is suppressed everywhere', async () => {
            const logger = await freshLogger();
            logger.debug('x');
            expect(debugSpy).not.toHaveBeenCalled();
            expect(logger.getPendingLogs()).toEqual([]);
        });

        it('setMinLevel("debug") opens .debug in both sinks', async () => {
            const logger = await freshLogger();
            logger.setMinLevel('debug');
            logger.debug('x');
            expect(debugSpy).toHaveBeenCalledTimes(1);
            expect(logger.getPendingLogs()).toHaveLength(1);
        });

        it('setMinLevel("warn") suppresses .log and .debug but allows .warn', async () => {
            const logger = await freshLogger();
            logger.setMinLevel('warn');
            logger.debug('d');
            logger.log('l');
            logger.warn('w');
            expect(debugSpy).not.toHaveBeenCalled();
            expect(logSpy).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledTimes(1);
            const pending = logger.getPendingLogs();
            expect(pending).toHaveLength(1);
            expect(pending[0].level).toBe('warn');
        });

        it('ignores unknown level names silently', async () => {
            const logger = await freshLogger();
            logger.setMinLevel('nope');
            logger.log('a');
            expect(logSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('withDebugLog', () => {
        it('demotes .log inside the scope to console.debug + buffer level "debug"', async () => {
            const logger = await freshLogger();
            logger.setMinLevel('debug');
            await logger.withDebugLog(async () => {
                logger.log('inside');
            });
            expect(logSpy).not.toHaveBeenCalled();
            expect(debugSpy).toHaveBeenCalledTimes(1);
            const [entry] = logger.getPendingLogs();
            expect(entry.level).toBe('debug');
        });

        it('does not demote .warn or .error', async () => {
            const logger = await freshLogger();
            await logger.withDebugLog(async () => {
                logger.warn('w');
                logger.error('e');
            });
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledTimes(1);
        });

        it('nests reentrantly; nested scopes keep .log demoted throughout', async () => {
            const logger = await freshLogger();
            logger.setMinLevel('debug');
            await logger.withDebugLog(async () => {
                await logger.withDebugLog(async () => {
                    logger.log('deep');
                });
                logger.log('mid');
            });
            expect(logSpy).not.toHaveBeenCalled();
            expect(debugSpy).toHaveBeenCalledTimes(2);
        });

        it('restores .log behavior after scope exit', async () => {
            const logger = await freshLogger();
            await logger.withDebugLog(async () => {});
            logger.log('after');
            expect(logSpy).toHaveBeenCalledTimes(1);
            const [entry] = logger.getPendingLogs();
            expect(entry.level).toBe('log');
        });

        it('restores depth and rethrows when the inner function throws', async () => {
            const logger = await freshLogger();
            await expect(
                logger.withDebugLog(async () => {
                    throw new Error('boom');
                })
            ).rejects.toThrow('boom');
            logger.log('after');
            const [entry] = logger.getPendingLogs();
            expect(entry.level).toBe('log');
        });
    });

    it('createLogger returns the same instance on repeated calls', async () => {
        vi.resetModules();
        const { createLogger } = await import('../logger.js');
        expect(createLogger()).toBe(createLogger());
    });
});

describe('createLogger — client realm', () => {
    let logSpy;

    beforeEach(() => {
        vi.stubGlobal('window', {});
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('prefixes with [DappFence Client]', async () => {
        const logger = await freshLogger();
        logger.log('hi');
        const [prefix] = logSpy.mock.calls[0];
        expect(prefix).toContain('[DappFence Client]');
    });

    it('emits to console.log but never populates the buffer', async () => {
        const logger = await freshLogger();
        logger.log('hi');
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logger.getPendingLogs()).toEqual([]);
    });

    it('getPendingLogs stays empty even after many .log calls', async () => {
        const logger = await freshLogger();
        for (let i = 0; i < 10; i++) {
            logger.log(`msg-${i}`);
        }
        expect(logger.getPendingLogs()).toEqual([]);
    });

    it('appends window.pageId to the prefix when set', async () => {
        vi.stubGlobal('window', { pageId: 'page-42' });
        const logger = await freshLogger();
        logger.log('hi');
        const args = logSpy.mock.calls[0];
        expect(args).toContain('(page-42)');
    });

    it('createLogger singleton works on the client too', async () => {
        vi.resetModules();
        const { createLogger } = await import('../logger.js');
        expect(createLogger()).toBe(createLogger());
    });
});
