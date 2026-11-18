import { describe, it, expect } from 'vitest';
import { BodyTooLargeError, createSwContext } from '../context.js';

/**
 * Minimal Response shape for wrap/fetch tests. `.clone()` returns a new instance
 * whose body is a fresh stream over the same bytes, matching the native
 * Response contract (each clone has an independent stream).
 */
function makeMockResponse(bytes = new Uint8Array(), { status = 200, url = '' } = {}) {
    const bodyFactory = () => ({
        getReader() {
            let delivered = false;
            return {
                async read() {
                    if (delivered || bytes.byteLength === 0) {
                        return { value: undefined, done: true };
                    }
                    delivered = true;
                    return { value: bytes, done: false };
                },
                async cancel() {},
                releaseLock() {},
            };
        },
    });
    const build = () => ({
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        type: 'basic',
        url,
        redirected: false,
        headers: new Headers(),
        body: bodyFactory(),
        clone: () => build(),
    });
    return build();
}

function createMockGlobal() {
    return {
        location: {
            href: 'https://example.com/sw.js',
            origin: 'https://example.com',
        },
        clients: {
            matchAll: async (opts) => [{ id: 'client-1', opts }],
            get: async (id) => ({ id }),
            claim: async () => 'claimed',
        },
        navigator: { userAgent: 'TestAgent/1.0' },
        skipWaiting: async () => 'skipped',
        fetch: async (input) =>
            makeMockResponse(new TextEncoder().encode('hello'), { url: String(input) }),
    };
}

describe('createSwContext', () => {
    it('getLocationHref delegates to global', () => {
        const ctx = createSwContext(createMockGlobal());
        expect(ctx.getLocationHref()).toBe('https://example.com/sw.js');
    });

    it('getLocationOrigin delegates to global', () => {
        const ctx = createSwContext(createMockGlobal());
        expect(ctx.getLocationOrigin()).toBe('https://example.com');
    });

    it('getLocation returns the location object', () => {
        const ctx = createSwContext(createMockGlobal());
        const loc = ctx.getLocation();
        expect(loc.href).toBe('https://example.com/sw.js');
        expect(loc.origin).toBe('https://example.com');
    });

    it('matchAllClients delegates to clients.matchAll', async () => {
        const ctx = createSwContext(createMockGlobal());
        const result = await ctx.matchAllClients({ type: 'window' });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('client-1');
    });

    it('getClient delegates to clients.get', async () => {
        const ctx = createSwContext(createMockGlobal());
        const client = await ctx.getClient('client-1');
        expect(client.id).toBe('client-1');
    });

    it('claimClients delegates to clients.claim', async () => {
        const ctx = createSwContext(createMockGlobal());
        const result = await ctx.claimClients();
        expect(result).toBe('claimed');
    });

    it('skipWaiting delegates to global', async () => {
        const ctx = createSwContext(createMockGlobal());
        const result = await ctx.skipWaiting();
        expect(result).toBe('skipped');
    });

    it('fetchWrapped returns a WrappedResponse exposing url + unwrap', async () => {
        const ctx = createSwContext(createMockGlobal());
        const wrapped = await ctx.fetchWrapped('https://example.com/data');
        expect(wrapped.url).toBe('https://example.com/data');
        expect(typeof wrapped.unwrap).toBe('function');
    });

    it('getUserAgent delegates to navigator', () => {
        const ctx = createSwContext(createMockGlobal());
        expect(ctx.getUserAgent()).toBe('TestAgent/1.0');
    });

    it('reads values lazily (not captured at creation)', () => {
        const mock = createMockGlobal();
        const ctx = createSwContext(mock);

        // Mutate the mock after context creation
        mock.location.origin = 'https://changed.com';
        expect(ctx.getLocationOrigin()).toBe('https://changed.com');
    });
});

describe('wrapResponse (via swContext.wrapResponse)', () => {
    const wrap = createSwContext(createMockGlobal()).wrapResponse;

    it('exposes the Response metadata directly', () => {
        const wrapped = wrap(
            makeMockResponse(new Uint8Array(), { status: 404, url: 'https://x/y' })
        );
        expect(wrapped.status).toBe(404);
        expect(wrapped.url).toBe('https://x/y');
        expect(wrapped.ok).toBe(false);
    });

    it('unwrap() returns the original Response untouched', () => {
        const original = makeMockResponse();
        const wrapped = wrap(original);
        expect(wrapped.unwrap()).toBe(original);
    });

    it('bytes(maxBytes) returns a Uint8Array of the body', async () => {
        const wrapped = wrap(makeMockResponse(new Uint8Array([1, 2, 3])));
        const bytes = await wrapped.bytes(1024);
        expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('bytes memoizes — second call does not re-clone', async () => {
        const original = makeMockResponse(new Uint8Array([7, 7, 7]));
        let cloneCount = 0;
        const clonedOriginal = {
            ...original,
            clone: () => {
                cloneCount++;
                return original.clone();
            },
        };
        const wrapped = wrap(clonedOriginal);
        await wrapped.bytes(1024);
        await wrapped.bytes(1024);
        expect(cloneCount).toBe(1);
    });

    it('text(maxBytes) decodes the body as UTF-8', async () => {
        const wrapped = wrap(makeMockResponse(new TextEncoder().encode('hello')));
        expect(await wrapped.text(1024)).toBe('hello');
    });

    it('json(maxBytes) parses the body as JSON', async () => {
        const wrapped = wrap(makeMockResponse(new TextEncoder().encode('{"a":1}')));
        expect(await wrapped.json(1024)).toEqual({ a: 1 });
    });

    it('arrayBuffer(maxBytes) returns a defensive copy', async () => {
        const wrapped = wrap(makeMockResponse(new Uint8Array([1, 2, 3])));
        const buf = await wrapped.arrayBuffer(1024);
        new Uint8Array(buf).fill(0);
        const bytesAfter = await wrapped.bytes(1024);
        expect(bytesAfter).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('calculateBodyHash(maxBytes) returns a sha256- prefixed string', async () => {
        const wrapped = wrap(makeMockResponse(new TextEncoder().encode('hello')));
        const hash = await wrapped.calculateBodyHash(1024);
        expect(hash).toMatch(/^sha256-/);
    });

    it('calculateBodyHash caches across repeated calls', async () => {
        const wrapped = wrap(makeMockResponse(new TextEncoder().encode('hello')));
        const first = await wrapped.calculateBodyHash(1024);
        const second = await wrapped.calculateBodyHash(1024);
        expect(second).toBe(first);
    });

    it('throws BodyTooLargeError when the body exceeds the cap', async () => {
        const wrapped = wrap(makeMockResponse(new Uint8Array(100)));
        await expect(wrapped.bytes(50)).rejects.toBeInstanceOf(BodyTooLargeError);
    });

    it('rejects a non-finite maxBytes', async () => {
        const wrapped = wrap(makeMockResponse(new Uint8Array([1])));
        await expect(wrapped.bytes(0)).rejects.toThrow(TypeError);
        await expect(wrapped.bytes(-1)).rejects.toThrow(TypeError);
    });

    it('empty body (no reader) yields empty bytes', async () => {
        const wrapped = wrap({
            ok: true,
            status: 204,
            type: 'basic',
            url: '',
            redirected: false,
            headers: new Headers(),
            body: null,
            clone() {
                return this;
            },
        });
        expect(await wrapped.bytes(1024)).toEqual(new Uint8Array());
        expect(await wrapped.text(1024)).toBe('');
    });
});
