/**
 * Destination safety tests — prove that inert response destinations and other
 * browser-level guarantees block JavaScript execution in Playwright's Chromium.
 *
 * These are regression tests for the INERT_DESTINATIONS assumption documented in
 * packages/dappfence/src/core/constants.js. A passing test proves the execution
 * vector is dead in the current browser engine; a failing test means a new path to
 * execution was discovered and the relevant policy must be revised.
 *
 * No service worker is involved — these tests exercise raw browser behaviour.
 * Style tests: inject <link> into assets/withoutDappfence.html, serve evil CSS
 * via synthetic inject intercept on /safety-test/style.css.
 * XSLT test: navigate to assets/xslt-safety-test.xml; serve evil XSLT via
 * synthetic inject intercept on /xslt-safety-test.xslt.
 * Browser-blocked tests: run entirely via page.evaluate() on a loaded page.
 */
import { expect, test } from '../sw-fixtures';
import { Page } from '@playwright/test';

type W = { __pwned?: number };

async function assertNotPwned(page: Page) {
    expect(await page.evaluate(() => (window as unknown as W).__pwned)).toBeUndefined();
}

test.describe('style destination cannot execute JavaScript', () => {
    const CSS_ATTACK_VECTORS = [
        [
            'expression() is a dead IE-only vector',
            'body { background-color: expression(window.__pwned=1); --loaded: 1; }',
        ],
        [
            'javascript: in CSS url() is a dead vector',
            `body { background: url('javascript:window.__pwned=1'); --loaded: 1; }`,
        ],
        [
            'JS body served with text/css content-type is not executed',
            'body { --loaded: 1; } window.__pwned = 1;',
        ],
        [
            'behavior:/HTC is a dead IE-only vector',
            `body { behavior: url('/safety-test/component.htc'); --loaded: 1; }`,
        ],
    ];
    CSS_ATTACK_VECTORS.forEach(([name, css]) => {
        test(name, async ({ page, swHelper }) => {
            // Sets up the two-intercept chain used by all style tests:
            //   1. inject a <link> into withoutDappfence.html before </head>
            //   2. serve the evil CSS body synthetically for /safety-test/style.css
            await swHelper.interceptAndModifyPageContent([
                {
                    pattern: '**/withoutDappfence.html',
                    formula: 'inject',
                    args: ['<link rel="stylesheet" href="/safety-test/style.css">', '</head>'],
                },
                {
                    pattern: '**/safety-test/style.css',
                    formula: 'inject',
                    args: css,
                    contentType: 'text/css',
                },
            ]);
            await page.goto('/withoutDappfence.html');
            await swHelper.waitForServiceWorkerActivation();
            const swMsg = swHelper.waitForServiceWorkerMessage('destination: style');
            await page.reload();
            await page.waitForLoadState('networkidle');
            expect((await swMsg).msg.text()).toContain('destination: style');
            expect(
                await page.evaluate(() =>
                    getComputedStyle(document.body).getPropertyValue('--loaded').trim()
                )
            ).toBe('1');
            await assertNotPwned(page);
        });
    });
});

test.describe('xslt destination cannot execute JavaScript', () => {
    const makeEvilXslt = (
        version: string,
        xmlns: string,
        tag: string,
        prefix: string,
        body: string,
        ext?: string
    ) =>
        `<?xml version="1.0"?>
<xsl:stylesheet version="${version}"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  ${xmlns}${ext ? `\n  extension-element-prefixes="${ext}"` : ''}>
  <${tag} implements-prefix="${prefix}" language="javascript">
    ${body}
  </${tag}>
  <xsl:template match="/">
    <html><body><p>probe</p></body></html>
  </xsl:template>
</xsl:stylesheet>`;

    const XSLT_ATTACK_VECTORS = [
        [
            'xsl:script is not executed',
            makeEvilXslt(
                '1.1',
                'xmlns:js="urn:dappfence-test-js"',
                'xsl:script',
                'js',
                'window.__pwned = 1;'
            ),
        ],
        [
            'msxsl:script is not executed',
            makeEvilXslt(
                '1.0',
                'xmlns:msxsl="urn:schemas-microsoft-com:xslt"',
                'msxsl:script',
                'msxsl',
                'window.__pwned = 1;\n    function tryPwn() { window.__pwned = 1; return ""; }',
                'msxsl'
            ),
        ],
    ];
    XSLT_ATTACK_VECTORS.forEach(([name, xslt]) => {
        test(name, async ({ page, swHelper }) => {
            await swHelper.interceptAndModifyPageContent({
                pattern: '**/xslt-safety-test.xslt',
                formula: 'inject',
                args: xslt,
                contentType: 'application/xslt+xml',
            });
            await page.goto('/withoutDappfence.html');
            await swHelper.waitForServiceWorkerActivation();
            await page.goto('/xslt-safety-test.xml', { waitUntil: 'domcontentloaded' });
            const swMsg = swHelper.waitForServiceWorkerMessage('destination: xslt');
            await page.reload({ waitUntil: 'domcontentloaded' });
            expect((await swMsg).msg.text()).toContain('destination: xslt');
            await assertNotPwned(page);
        });
    });
});

test.describe('image destination cannot execute JavaScript', () => {
    // SVG with an embedded <script> — when loaded as <img> the browser sandboxes
    // the SVG, and the script does not execute (image destination).
    const EVIL_SVG = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">',
        '  <script>window.__pwned = 1;</script>',
        '  <rect width="100" height="100" fill="blue"/>',
        '</svg>',
    ].join('\n');

    test('SVG with embedded <script> loaded as <img> does not execute', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent([
            {
                pattern: '**/withoutDappfence.html',
                formula: 'inject',
                args: ['<img id="probe-img" src="/safety-test/evil.svg">', '</body>'],
            },
            {
                pattern: '**/safety-test/evil.svg',
                formula: 'inject',
                args: EVIL_SVG,
                contentType: 'image/svg+xml',
            },
        ]);
        await page.goto('/withoutDappfence.html');
        await swHelper.waitForServiceWorkerActivation();
        const swMsg = swHelper.waitForServiceWorkerMessage('destination: image');
        await page.reload();
        await page.waitForLoadState('networkidle');
        expect((await swMsg).msg.text()).toContain('destination: image');
        // Verify the image actually loaded (naturalWidth > 0) then check no JS ran.
        expect(
            await page.evaluate(() => {
                const img = document.querySelector('#probe-img') as HTMLImageElement;
                return img?.naturalWidth ?? 0;
            })
        ).toBeGreaterThan(0);
        await assertNotPwned(page);
    });
});

test.describe('browser-blocked execution vectors', () => {
    test.beforeEach(async ({ page, swHelper }) => {
        // Navigate to a plain page so page.evaluate() has a document context.
        // No SW activation — these tests measure browser-engine behaviour only.
        await swHelper.interceptAndModifyPageContent({
            pattern: '**/withoutDappfence.html',
            formula: 'unchanged',
        });
        await page.goto('/withoutDappfence.html');
        await page.waitForLoadState('networkidle');
    });

    test('innerHTML script injection is not executed', async ({ page }) => {
        // Browsers do not execute <script> elements inserted via innerHTML (by spec).
        await page.evaluate(() => {
            const div = document.createElement('div');
            document.body.appendChild(div);
            div.innerHTML = '<script>window.__pwned=1<\\/script>';
        });
        // Give the event loop a tick in case any async execution path exists.
        await page.waitForTimeout(100);
        await assertNotPwned(page);
    });

    test('innerHTML with <script src="data:..."> is not executed', async ({ page }) => {
        // innerHTML suppresses execution even when the script has a src attribute —
        // including data: URIs that would execute if appended via createElement.
        await page.evaluate(() => {
            const div = document.createElement('div');
            document.body.appendChild(div);
            div.innerHTML = '<script src="data:text/javascript,window.__pwned=1"><\\/script>';
        });
        await page.waitForTimeout(100);
        await assertNotPwned(page);
    });
});
