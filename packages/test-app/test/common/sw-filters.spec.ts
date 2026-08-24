/**
 * End-to-end tests for manifest filter rules.
 *
 * Filter rules handle two distinct CDN injection problems:
 *
 * 1. Strip (`pattern` + `appliesTo`): CDN injects a snippet into HTML. The SW
 *    strips it before hashing so the computed hash matches the pre-injection
 *    manifest entry.
 *
 * 2. Rewrite (`rewriteUrls`): the injected snippet loads a script from a CDN URL.
 *    The SW applies a tiered policy: content matching a known-good hash is allowed
 *    through (MATCH); any other content — unknown hash or no manifest entry — is
 *    replaced with an empty stub (REWRITE) so the page keeps working.
 *
 * CDN script variants live in assets/.netlify/scripts/. The manifest records both
 * hashes (cdp.js and cdp-alt.js) so either triggers MATCH. cdp-fail.js is not
 * listed, so it triggers REWRITE.
 */
import { expect, test } from '../sw-fixtures';

// Matches the netlify-cdp.js filter pattern — only whitespace between the opening
// div and the script tag, so the SW strips it before hashing.
const CDN_INJECT =
    '<div data-netlify-deploy-id="abcdef1234567890" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>';

// Extra <script> inside the div causes the pattern NOT to match, so the snippet
// is left in place, and the page hash mismatches.
const CDN_INJECT_MALICIOUS =
    '<div data-netlify-deploy-id="abcdef1234567890" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed"><script>evil()</script><script async src="/.netlify/scripts/cdp"></script></div>';

test.describe('filter rules', () => {
    test.beforeEach(async ({ page, swHelper }) => {
        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation();
    });

    test('should strip valid CDN injection and serve CDN script when its first hash matches', async ({
        page,
        swHelper,
    }) => {
        // The SW strips the injected snippet before hashing so the page hash matches the manifest.
        // The CDN script itself is verified against manifest.files and MATCH allows it through.
        await swHelper.interceptAndModifyPageContent([
            { pattern: '**/', formula: 'inject', args: [CDN_INJECT, '</body>'] },
            {
                pattern: '/.netlify/scripts/cdp',
                formula: 'replace',
                args: '.netlify/scripts/cdp.js',
            },
        ]);
        await page.reload();
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await page.waitForFunction(() => window.__cdnScriptLoaded === 'YES');
    });

    test('should block when a CDN-like injection contains extra content', async ({
        page,
        swHelper,
    }) => {
        // The injected snippet has an extra <script> inside the div, so the strict
        // netlify-cdp.js pattern does not match, and the snippet is NOT stripped.
        // The resulting hash mismatch triggers a security block.
        await swHelper.interceptAndModifyPageContent([
            { pattern: '**/', formula: 'inject', args: [CDN_INJECT_MALICIOUS, '</body>'] },
        ]);
        await page.reload();
        await page.waitForURL(/.*\/sw-api/);
    });

    test('should serve CDN script unchanged when its second hash matches the manifest', async ({
        page,
        swHelper,
    }) => {
        // The replacement formula causes the dev server to serve cdp-alt.js whose hash is the
        // second entry in manifest.files['/.netlify/scripts/cdp']. MATCH allows it through.
        await swHelper.interceptAndModifyPageContent([
            { pattern: '**/', formula: 'inject', args: [CDN_INJECT, '</body>'] },
            {
                pattern: '/.netlify/scripts/cdp',
                formula: 'replace',
                args: '.netlify/scripts/cdp-alt.js',
            },
        ]);
        await page.reload();
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await page.waitForFunction(() => window.__cdnScriptLoaded === 'ALT');
    });

    test('should rewrite CDN script with empty stub when served content is empty', async ({
        page,
        swHelper,
    }) => {
        // The empty formula makes the dev server return no content for the CDN script URL.
        // The URL is in rewriteUrls, so any violation gives REWRITE — the page keeps working.
        await swHelper.interceptAndModifyPageContent([
            { pattern: '**/', formula: 'inject', args: [CDN_INJECT, '</body>'] },
            {
                pattern: '/.netlify/scripts/cdp',
                formula: 'empty',
                contentType: 'application/javascript',
            },
        ]);
        const [cdpResponse] = await Promise.all([
            page.waitForResponse('**/.netlify/scripts/cdp'),
            page.reload(),
        ]);
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        const body = await cdpResponse.text();
        expect(body).toBe('/* replaced by dappfence */');
    });
});
