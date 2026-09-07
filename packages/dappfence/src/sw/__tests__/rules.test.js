import { describe, it, expect } from 'vitest';
import { TRANSFORMS } from '../manifest/html/transforms.js';

const encode = (str) => new TextEncoder().encode(str);
const decode = (buf) => new TextDecoder().decode(buf);

const applyTransform = (buf, name) => {
    const rule = TRANSFORMS[name];
    if (!rule) {
        return null;
    }
    const text = decode(buf);
    const ranges = rule.findStripRanges(text);
    let result = text;
    for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
        result = result.slice(0, start) + result.slice(end);
    }
    return encode(result);
};

const NETLIFY_SNIPPET = (deployId = 'aabbccdd', siteId = '00000000-0000-0000-0000-000000000000') =>
    `<div data-netlify-deploy-id="${deployId}" data-netlify-site-id="${siteId}" data-vcs="github" style="position:fixed">\n  \n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;

const HTML = (extra = '') => `<!DOCTYPE html><html><body><p>Hello</p>${extra}</body></html>`;

// ── applyTransform ────────────────────────────────────────────────────────────

describe('applyTransform', () => {
    describe('unknown transform', () => {
        it('returns null for unknown transform names', () => {
            const buf = encode(HTML());
            expect(applyTransform(buf, 'unknown-cdn')).toBeNull();
        });
    });

    describe('netlify-cdp transform', () => {
        it('strips the Netlify CDP snippet from an HTML document', () => {
            const buf = encode(HTML(NETLIFY_SNIPPET()));
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toBe(HTML());
        });

        it('applies to .htm content as well (content-agnostic)', () => {
            const buf = encode(HTML(NETLIFY_SNIPPET()));
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toBe(HTML());
        });

        it('strips with any valid hex deploy id', () => {
            const buf = encode(HTML(NETLIFY_SNIPPET('deadbeef0123456789abcdef')));
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toBe(HTML());
        });

        it('handles the snippet anywhere in the document', () => {
            const html = `<!DOCTYPE html><html><head></head><body>${NETLIFY_SNIPPET()}<p>content</p></body></html>`;
            const result = decode(applyTransform(encode(html), 'netlify-cdp'));
            expect(result).not.toContain('data-netlify-deploy-id');
            expect(result).toContain('<p>content</p>');
        });

        it('does not strip when deploy id contains non-hex characters', () => {
            const snippet = `<div data-netlify-deploy-id="gg-invalid!!" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when site id is not a valid UUID', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="not-a-uuid" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when data-vcs is not "github"', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="malicious" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when style attribute differs', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:absolute">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when extra content is hidden inside the div', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed"><script>evil()</script><script async src="/.netlify/scripts/cdp"></script></div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when the cdp script src differs', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed">\n  <script async src="/evil/script.js"></script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when attribute order differs', () => {
            const snippet = `<div data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-netlify-deploy-id="aabbccdd" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when cdp script has inline content', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp">alert(1)</script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when div contains extra elements after the cdp script', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n  <script>extra()</script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('no-ops when snippet is absent (returns same content)', () => {
            const buf = encode(HTML());
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toBe(HTML());
        });

        it('does not apply to non-HTML content (script bytes still processed)', () => {
            // transform is content-agnostic; pattern won't match in JS
            const buf = encode('console.log("hello")');
            const result = decode(applyTransform(buf, 'netlify-cdp'));
            expect(result).toBe('console.log("hello")');
        });
    });
});
