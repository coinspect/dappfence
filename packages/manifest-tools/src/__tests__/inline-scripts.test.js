import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const { extractInlineScriptHashes, extractInlineAttrHashes, extractInlineHashesFromHtml } =
    _require('../inline-scripts');
const { calculateStringHash } = _require('../build');

let tmpFiles = [];
async function writeHtml(content) {
    const p = path.join(os.tmpdir(), `df-inline-test-${Date.now()}-${Math.random()}.html`);
    await fs.writeFile(p, content, 'utf8');
    tmpFiles.push(p);
    return p;
}
async function writeRaw(buf) {
    const p = path.join(os.tmpdir(), `df-inline-test-${Date.now()}-${Math.random()}.html`);
    await fs.writeFile(p, buf);
    tmpFiles.push(p);
    return p;
}

afterEach(async () => {
    for (const f of tmpFiles) await fs.unlink(f).catch(() => {});
    tmpFiles = [];
});

describe('extractInlineScriptHashes', () => {
    it('returns empty arrays for HTML with no scripts', async () => {
        const p = await writeHtml('<html><body><p>hello</p></body></html>');
        const { hashes, warnings } = await extractInlineScriptHashes(p);
        expect(hashes).toEqual([]);
        expect(warnings).toEqual([]);
    });

    it('hashes a single inline script body', async () => {
        const content = 'console.log("hi");';
        const p = await writeHtml(`<html><body><script>${content}</script></body></html>`);
        const { hashes, warnings } = await extractInlineScriptHashes(p);
        expect(warnings).toEqual([]);
        expect(hashes).toEqual([calculateStringHash(content)]);
    });

    it('skips scripts with a src attribute', async () => {
        const p = await writeHtml(
            '<html><body><script src="/app.js"></script><script>inline();</script></body></html>'
        );
        const { hashes } = await extractInlineScriptHashes(p);
        expect(hashes).toEqual([calculateStringHash('inline();')]);
    });

    it('skips scripts with src in any attribute order', async () => {
        const p = await writeHtml(
            '<html><body><script type="module" src="/app.js"></script></body></html>'
        );
        const { hashes } = await extractInlineScriptHashes(p);
        expect(hashes).toEqual([]);
    });

    it('returns hashes in document order for multiple inline scripts', async () => {
        const a = 'var a = 1;';
        const b = 'var b = 2;';
        const p = await writeHtml(
            `<html><body><script>${a}</script><script>${b}</script></body></html>`
        );
        const { hashes } = await extractInlineScriptHashes(p);
        expect(hashes).toEqual([calculateStringHash(a), calculateStringHash(b)]);
    });

    it('includes leading/trailing whitespace in the hash', async () => {
        const content = '\n    var x = 1;\n';
        const p = await writeHtml(`<html><body><script>${content}</script></body></html>`);
        const { hashes } = await extractInlineScriptHashes(p);
        expect(hashes).toEqual([calculateStringHash(content)]);
    });

    it('correctly handles the HTML5 double-escape pattern: <!--<script>...</script>', async () => {
        // The HTML5 state machine: <!-- → ESCAPED, <script> → DOUBLE_ESCAPED,
        // </script> in DOUBLE_ESCAPED → back to ESCAPED (does NOT close the element).
        // Only the outer </script> closes the element.
        const html =
            '<html><body>' +
            '<script>a.push([0,"<!--<script>"])</script>/\nwindow.__x = true;\n</script>' +
            '</body></html>';
        const p = await writeHtml(html);
        const { hashes, warnings } = await extractInlineScriptHashes(p);
        expect(warnings).toEqual([]);
        // One script element whose content spans the intermediate </script>
        const expectedContent = 'a.push([0,"<!--<script>"])</script>/\nwindow.__x = true;\n';
        expect(hashes).toEqual([calculateStringHash(expectedContent)]);
    });

    it('treats <!-- as opening escaped state, --> closes it', async () => {
        // Script data escaped state: <!-- ... --> is regular content, not a comment.
        // The </script> after --> closes the element.
        const inner = 'x = 1; <!-- not a comment --> y = 2;';
        const p = await writeHtml(`<html><body><script>${inner}</script></body></html>`);
        const { hashes } = await extractInlineScriptHashes(p);
        expect(hashes).toEqual([calculateStringHash(inner)]);
    });

    it('handles type attribute without src — still hashed', async () => {
        const content = 'var mod = true;';
        const p = await writeHtml(
            `<html><body><script type="module">${content}</script></body></html>`
        );
        const { hashes } = await extractInlineScriptHashes(p);
        expect(hashes).toEqual([calculateStringHash(content)]);
    });

    it('strips UTF-8 BOM and returns correct hashes', async () => {
        const content = 'var bom = 1;';
        const bom = Buffer.from([0xef, 0xbb, 0xbf]);
        const rest = Buffer.from(`<html><body><script>${content}</script></body></html>`, 'utf8');
        const p = await writeRaw(Buffer.concat([bom, rest]));
        const { hashes, warnings } = await extractInlineScriptHashes(p);
        expect(warnings).toEqual([]);
        expect(hashes).toEqual([calculateStringHash(content)]);
    });

    it('throws on UTF-16 LE BOM', async () => {
        const p = await writeRaw(Buffer.from([0xff, 0xfe, 0x3c, 0x00]));
        await expect(extractInlineScriptHashes(p)).rejects.toThrow('UTF-16 BOM');
    });

    it('throws on UTF-16 BE BOM', async () => {
        const p = await writeRaw(Buffer.from([0xfe, 0xff, 0x00, 0x3c]));
        await expect(extractInlineScriptHashes(p)).rejects.toThrow('UTF-16 BOM');
    });

    it('throws on non-UTF-8 meta charset', async () => {
        const p = await writeHtml(
            '<html><head><meta charset="iso-8859-1"></head><body><script>x=1;</script></body></html>'
        );
        await expect(extractInlineScriptHashes(p)).rejects.toThrow('unsupported charset');
    });

    it('accepts utf-8 meta charset (case-insensitive)', async () => {
        const content = 'x = 1;';
        const p = await writeHtml(
            `<html><head><meta charset="UTF-8"></head><body><script>${content}</script></body></html>`
        );
        const { hashes } = await extractInlineScriptHashes(p);
        expect(hashes).toEqual([calculateStringHash(content)]);
    });

    it('emits a warning for unterminated script', async () => {
        const p = await writeHtml('<html><body><script>oops(');
        const { hashes, warnings } = await extractInlineScriptHashes(p);
        expect(hashes).toEqual([]);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('Unterminated');
    });

    it('emits a nonce warning and still hashes the script body', async () => {
        const content = 'doSomething();';
        const p = await writeHtml(
            `<html><body><script nonce="abc123">${content}</script></body></html>`
        );
        const { hashes, warnings } = await extractInlineScriptHashes(p);
        expect(hashes).toEqual([calculateStringHash(content)]);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('nonce');
    });

    it('emits a nonce warning for single-quoted nonce attribute', async () => {
        const p = await writeHtml(`<html><body><script nonce='xyz'>x();</script></body></html>`);
        const { warnings } = await extractInlineScriptHashes(p);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('nonce');
    });

    it('does not warn for scripts without a nonce', async () => {
        const p = await writeHtml('<html><body><script>safe();</script></body></html>');
        const { warnings } = await extractInlineScriptHashes(p);
        expect(warnings).toEqual([]);
    });
});

describe('extractInlineHashesFromHtml', () => {
    it('returns scripts and attrs from an HTML string', () => {
        const html =
            '<html><body><script>doX();</script><button onclick="alert(1)">x</button></body></html>';
        const { scripts, attrs, warnings } = extractInlineHashesFromHtml(html);
        expect(scripts).toEqual([calculateStringHash('doX();')]);
        expect(attrs).toEqual([calculateStringHash('alert(1)')]);
        expect(warnings).toEqual([]);
    });

    it('emits a nonce warning via the string API', () => {
        const html = '<html><body><script nonce="n1">run();</script></body></html>';
        const { scripts, warnings } = extractInlineHashesFromHtml(html);
        expect(scripts).toHaveLength(1);
        expect(warnings.some((w) => w.includes('nonce'))).toBe(true);
    });

    it('returns empty arrays for HTML with no scripts or on* attrs', () => {
        const { scripts, attrs, warnings } = extractInlineHashesFromHtml('<p>hi</p>');
        expect(scripts).toEqual([]);
        expect(attrs).toEqual([]);
        expect(warnings).toEqual([]);
    });
});

describe('extractInlineAttrHashes', () => {
    it('returns empty arrays for HTML with no on* attributes', async () => {
        const p = await writeHtml('<html><body><button class="btn">click</button></body></html>');
        const { attrs, warnings } = await extractInlineAttrHashes(p);
        expect(attrs).toEqual([]);
        expect(warnings).toEqual([]);
    });

    it('extracts a single onclick attribute', async () => {
        const value = "doSomething('arg')";
        const p = await writeHtml(
            `<html><body><button onclick="${value}">x</button></body></html>`
        );
        const { attrs } = await extractInlineAttrHashes(p);
        expect(attrs).toHaveLength(1);
        expect(attrs[0].name).toBe('onclick');
        expect(attrs[0].value).toBe(value);
        expect(attrs[0].hash).toBe(calculateStringHash(value));
    });

    it('extracts multiple different on* attributes', async () => {
        const p = await writeHtml(
            '<html><body>' +
                '<button onclick="doA()">a</button>' +
                '<input onchange="doB()" />' +
                '</body></html>'
        );
        const { attrs } = await extractInlineAttrHashes(p);
        expect(attrs).toHaveLength(2);
        expect(attrs.map((a) => a.name)).toEqual(['onclick', 'onchange']);
    });

    it('deduplicates identical handler values across multiple elements', async () => {
        const value = 'handler()';
        const p = await writeHtml(
            `<html><body>` +
                `<button onclick="${value}">a</button>` +
                `<button onclick="${value}">b</button>` +
                `</body></html>`
        );
        const { attrs } = await extractInlineAttrHashes(p);
        expect(attrs).toHaveLength(1);
        expect(attrs[0].value).toBe(value);
    });

    it('does not extract on* patterns inside <script> blocks', async () => {
        const p = await writeHtml(
            '<html><body>' +
                "<script>var onclick = 'foo'; el.onclick = function(){};</script>" +
                '<button onclick="realHandler()">x</button>' +
                '</body></html>'
        );
        const { attrs } = await extractInlineAttrHashes(p);
        expect(attrs).toHaveLength(1);
        expect(attrs[0].value).toBe('realHandler()');
    });

    it('does not extract on* patterns inside HTML comments', async () => {
        const p = await writeHtml(
            '<html><body>' +
                '<!-- <button onclick="commentHandler()"> -->' +
                '<button onclick="realHandler()">x</button>' +
                '</body></html>'
        );
        const { attrs } = await extractInlineAttrHashes(p);
        expect(attrs).toHaveLength(1);
        expect(attrs[0].value).toBe('realHandler()');
    });

    it('handles single-quoted attribute values', async () => {
        const value = 'doSomething()';
        const p = await writeHtml(
            `<html><body><button onclick='${value}'>x</button></body></html>`
        );
        const { attrs } = await extractInlineAttrHashes(p);
        expect(attrs).toHaveLength(1);
        expect(attrs[0].value).toBe(value);
    });

    it('reports the hash in sha256-<base64> format', async () => {
        const p = await writeHtml('<html><body><button onclick="x()">y</button></body></html>');
        const { attrs } = await extractInlineAttrHashes(p);
        expect(attrs[0].hash).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
    });

    it('throws on UTF-16 BOM', async () => {
        const p = await writeRaw(Buffer.from([0xff, 0xfe, 0x3c, 0x00]));
        await expect(extractInlineAttrHashes(p)).rejects.toThrow('UTF-16 BOM');
    });

    it('throws on non-UTF-8 meta charset', async () => {
        const p = await writeHtml(
            '<html><head><meta charset="iso-8859-1"></head><body><button onclick="x()">y</button></body></html>'
        );
        await expect(extractInlineAttrHashes(p)).rejects.toThrow('unsupported charset');
    });
});
