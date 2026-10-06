import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSingleFlight, isFeatureEnabled, once } from '../utils.js';

describe('createSingleFlight', () => {
    it('returns the result of the function', async () => {
        const sf = createSingleFlight();
        const result = await sf(() => Promise.resolve('hello'));
        expect(result).toBe('hello');
    });

    it('deduplicates concurrent calls', async () => {
        const sf = createSingleFlight();
        const fn = vi.fn().mockResolvedValue('result');

        const [a, b] = await Promise.all([sf(fn), sf(fn)]);
        expect(a).toBe('result');
        expect(b).toBe('result');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('allows a new call after the first completes', async () => {
        const sf = createSingleFlight();
        const fn = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');

        const first = await sf(fn);
        const second = await sf(fn);
        expect(first).toBe('first');
        expect(second).toBe('second');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('resets after a rejected promise', async () => {
        const sf = createSingleFlight();
        const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce('ok');

        await expect(sf(fn)).rejects.toThrow('fail');
        const result = await sf(fn);
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });
});

describe('once', () => {
    it('invokes the wrapped function the first time and returns its result', () => {
        const fn = vi.fn(() => 'hello');
        const wrapped = once(fn);
        expect(wrapped()).toBe('hello');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('returns the same cached result on subsequent calls without re-invoking', () => {
        const fn = vi.fn().mockReturnValueOnce('first').mockReturnValueOnce('second');
        const wrapped = once(fn);
        expect(wrapped()).toBe('first');
        expect(wrapped()).toBe('first');
        expect(wrapped()).toBe('first');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('caches null / undefined / falsy results instead of re-invoking', () => {
        const fn = vi.fn(() => null);
        const wrapped = once(fn);
        expect(wrapped()).toBeNull();
        expect(wrapped()).toBeNull();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('caches the returned promise so async work runs once', async () => {
        const fn = vi.fn().mockResolvedValue('async-result');
        const wrapped = once(fn);
        const [a, b, c] = await Promise.all([wrapped(), wrapped(), wrapped()]);
        expect(a).toBe('async-result');
        expect(b).toBe('async-result');
        expect(c).toBe('async-result');
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe('isFeatureEnabled', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = {};
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });

    it('returns true for enabled features', () => {
        globalThis.__FEATURES__ = { auto_confirm_site_lock: true };
        expect(isFeatureEnabled('auto_confirm_site_lock')).toBe(true);
    });

    it('returns false for disabled features', () => {
        globalThis.__FEATURES__ = { auto_confirm_site_lock: false };
        expect(isFeatureEnabled('auto_confirm_site_lock')).toBe(false);
    });

    it('returns false for undefined features', () => {
        globalThis.__FEATURES__ = {};
        expect(isFeatureEnabled('nonexistent')).toBe(false);
    });
});
