import { describe, it, expect } from 'vitest';
import { resolveManifestKey } from '../manifest/rules.js';

const base = 'https://example.com/dappfence.js';
const req = (url, destination = 'document') => ({ url, destination });
const manifest = (pathRules, files) => ({ pathRules, files });

describe('resolveManifestKey', () => {
    describe('no pathRules', () => {
        it('returns pathname for same-origin URL', () => {
            expect(resolveManifestKey(req('https://example.com/app.js'), base)).toBe('/app.js');
        });

        it('returns full URL for cross-origin', () => {
            expect(resolveManifestKey(req('https://cdn.other.com/lib.js'), base)).toBe(
                'https://cdn.other.com/lib.js'
            );
        });

        it('falls back to pathname when no rule matches', () => {
            expect(
                resolveManifestKey(req('/about'), base, {
                    files: { '/about/index.html': 'h' },
                })
            ).toBe('/about');
        });

        it('returns pathname for relative path', () => {
            expect(resolveManifestKey(req('/style.css'), base)).toBe('/style.css');
        });

        it('percent-decodes same-origin pathname so lookup matches manifest keys', () => {
            expect(
                resolveManifestKey(
                    req(
                        'https://example.com/_next/static/chunks/app/partials/dynamic/%5Bid%5D/page.js'
                    ),
                    base
                )
            ).toBe('/_next/static/chunks/app/partials/dynamic/[id]/page.js');
        });
    });

    describe('directory-index rule', () => {
        const files = { '/index.html': 'h', '/docs/index.html': 'h', '/about/index.html': 'h' };
        const pathRules = [{ type: 'directory-index' }];

        it('resolves "/" to "/index.html"', () => {
            expect(resolveManifestKey(req('/'), base, manifest(pathRules, files))).toBe(
                '/index.html'
            );
        });

        it('resolves "/docs/" to "/docs/index.html"', () => {
            expect(resolveManifestKey(req('/docs/'), base, manifest(pathRules, files))).toBe(
                '/docs/index.html'
            );
        });

        it('resolves extensionless "/docs" to "/docs/index.html"', () => {
            expect(resolveManifestKey(req('/docs'), base, manifest(pathRules, files))).toBe(
                '/docs/index.html'
            );
        });

        it('resolves "/about" to "/about/index.html"', () => {
            expect(resolveManifestKey(req('/about'), base, manifest(pathRules, files))).toBe(
                '/about/index.html'
            );
        });

        it('does not remap paths that already have an extension', () => {
            expect(resolveManifestKey(req('/app.js'), base, manifest(pathRules, files))).toBe(
                '/app.js'
            );
        });

        it('falls back to pathname when candidate not in files', () => {
            expect(resolveManifestKey(req('/missing'), base, manifest(pathRules, files))).toBe(
                '/missing'
            );
        });

        it('never applies to cross-origin URLs', () => {
            expect(
                resolveManifestKey(req('https://cdn.com/lib.js'), base, manifest(pathRules, files))
            ).toBe('https://cdn.com/lib.js');
        });
    });

    describe('html-extension rule', () => {
        const files = { '/about.html': 'h', '/contact.html': 'h' };
        const pathRules = [{ type: 'html-extension' }];

        it('resolves "/about" to "/about.html"', () => {
            expect(resolveManifestKey(req('/about'), base, manifest(pathRules, files))).toBe(
                '/about.html'
            );
        });

        it('does not remap paths with extension', () => {
            expect(resolveManifestKey(req('/app.js'), base, manifest(pathRules, files))).toBe(
                '/app.js'
            );
        });

        it('does not remap trailing-slash paths', () => {
            expect(resolveManifestKey(req('/about/'), base, manifest(pathRules, files))).toBe(
                '/about/'
            );
        });

        it('falls back to pathname when candidate not in files', () => {
            expect(resolveManifestKey(req('/missing'), base, manifest(pathRules, files))).toBe(
                '/missing'
            );
        });
    });

    describe('match/resolveAs override', () => {
        const files = { '/campaigns/landing/index.html': 'h' };
        const pathRules = [{ match: '/landing', resolveAs: '/campaigns/landing/index.html' }];

        it('returns resolveAs for exact match', () => {
            expect(resolveManifestKey(req('/landing'), base, manifest(pathRules, files))).toBe(
                '/campaigns/landing/index.html'
            );
        });

        it('falls through for non-matching paths', () => {
            expect(resolveManifestKey(req('/other'), base, manifest(pathRules, files))).toBe(
                '/other'
            );
        });
    });

    describe('condition.urlFilter scoping', () => {
        const files = { '/docs/index.html': 'h' };
        const pathRules = [
            { condition: { urlFilter: '/docs/' }, type: 'directory-index' },
            { type: 'html-extension' },
        ];

        it('applies scoped rule only to matching prefix', () => {
            expect(resolveManifestKey(req('/docs/'), base, manifest(pathRules, files))).toBe(
                '/docs/index.html'
            );
        });

        it('falls through to next rule when prefix does not match', () => {
            const files2 = { ...files, '/about.html': 'h2' };
            expect(resolveManifestKey(req('/about'), base, manifest(pathRules, files2))).toBe(
                '/about.html'
            );
        });
    });

    describe('error-page rule', () => {
        const files = { '/404.html': 'h', '/about/index.html': 'h' };
        const pathRules = [
            { type: 'directory-index' },
            { type: 'error-page', status: 404, url: '/404.html' },
        ];

        it('maps a non-ok navigation to the error-page url', () => {
            const result = resolveManifestKey(req('/missing'), base, manifest(pathRules, files), {
                ok: false,
                status: 404,
            });
            expect(result).toBe('/404.html');
        });

        it('does not apply when the response is ok', () => {
            const result = resolveManifestKey(req('/missing'), base, manifest(pathRules, files), {
                ok: true,
                status: 200,
            });
            expect(result).toBe('/missing');
        });

        it('does not apply when status does not match', () => {
            const result = resolveManifestKey(req('/missing'), base, manifest(pathRules, files), {
                ok: false,
                status: 500,
            });
            expect(result).toBe('/missing');
        });

        it('does not apply when the pathname is a known file', () => {
            const result = resolveManifestKey(req('/about'), base, manifest(pathRules, files), {
                ok: false,
                status: 404,
            });
            expect(result).toBe('/about/index.html');
        });

        it('honors condition.resourceTypes when scoping the fallback', () => {
            const rules = [
                {
                    type: 'error-page',
                    status: 404,
                    url: '/404.html',
                    condition: { resourceTypes: ['document'] },
                },
            ];
            expect(
                resolveManifestKey(
                    req('/missing', 'script'),
                    base,
                    { pathRules: rules, files },
                    { ok: false, status: 404 }
                )
            ).toBe('/missing');
            expect(
                resolveManifestKey(
                    req('/missing', 'document'),
                    base,
                    { pathRules: rules, files },
                    { ok: false, status: 404 }
                )
            ).toBe('/404.html');
        });
    });
});
