import { describe, it, expect, vi } from 'vitest';

const EXPECTED_TAG =
    '<script src="/dappfence.js" data-manifest="/integrity-manifest.json" ' +
    'data-manifest-signature-type="noble-secp256k1-recovered-eth" ' +
    'data-manifest-signature-identity="0xAbC123"></script>';

vi.mock('virtual:dappfence/attrs', () => ({
    scriptTag: EXPECTED_TAG,
}));

const { onRequest } = await import('../inject/middleware.js');

function htmlResponse(body, headers = {}) {
    return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    });
}

describe('dappfence middleware', () => {
    it('injects the bootstrap tag once after <head> on HTML responses', async () => {
        const next = vi.fn(async () =>
            htmlResponse('<!doctype html><html><head><title>x</title></head><body></body></html>')
        );
        const res = await onRequest({}, next);
        const body = await res.text();
        expect(body).toContain(EXPECTED_TAG);
        const occurrences = body.split(EXPECTED_TAG).length - 1;
        expect(occurrences).toBe(1);
    });

    it('is idempotent when the response already contains the tag', async () => {
        const already = `<!doctype html><html><head>${EXPECTED_TAG}<title>x</title></head><body></body></html>`;
        const next = vi.fn(async () => htmlResponse(already));
        const res = await onRequest({}, next);
        const body = await res.text();
        const occurrences = body.split(EXPECTED_TAG).length - 1;
        expect(occurrences).toBe(1);
    });

    it('passes non-HTML responses through unchanged', async () => {
        const payload = JSON.stringify({ ok: true });
        const original = new Response(payload, {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
        const next = vi.fn(async () => original);
        const res = await onRequest({}, next);
        expect(res).toBe(original);
    });

    it('passes HTML fragments without <head> through unchanged in body', async () => {
        const fragment = '<div><p>server island content</p></div>';
        const next = vi.fn(async () => htmlResponse(fragment));
        const res = await onRequest({}, next);
        const body = await res.text();
        expect(body).toBe(fragment);
        expect(body).not.toContain(EXPECTED_TAG);
    });

    it('drops content-length from the returned response after injection', async () => {
        const html = '<!doctype html><html><head></head><body></body></html>';
        const next = vi.fn(async () =>
            htmlResponse(html, { 'content-length': String(html.length) })
        );
        const res = await onRequest({}, next);
        expect(res.headers.get('content-length')).toBeNull();
    });

    it('preserves status and other headers on HTML responses', async () => {
        const next = vi.fn(async () =>
            htmlResponse('<!doctype html><html><head></head><body></body></html>', {
                'x-custom': 'preserved',
            })
        );
        const res = await onRequest({}, next);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-custom')).toBe('preserved');
        expect(res.headers.get('content-type')).toContain('text/html');
    });
});
