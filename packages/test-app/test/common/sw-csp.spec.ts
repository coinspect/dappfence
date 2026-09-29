import { expect, test } from '../sw-fixtures';
import { APIRequestContext, Page } from '@playwright/test';

// SHA-256 of the first inline template script body in simple-app.html:
//   "\n window.__csp_inline_1 = 'script-1-ran';\n        "
// Stable as long as the template script content and indentation don't change.
const CSP_INLINE_1_HASH = 'sha256-vRDxHJVof5XdgQz3jMqMeB0wpoGfCWXTSV60g2VfXx4=';

// Matches `csp.reportUri` set in test-app build-config.js on the
// csp-report-manifest.json and csp-report-only-manifest.json variants (default
// manifest has no reportUri). Relative — browser resolves it same-origin per
// worker; the dev-server's /capture/* sink records the POST into testResponse.
const REPORT_URI = '/capture/csp';

type ViolationHit = {
    violatedDirective: string;
    effectiveDirective: string;
    blockedURI: string;
    disposition: string;
    sample: string;
};

type CspReport = {
    'violated-directive': string;
    'effective-directive': string;
    'blocked-uri': string;
    'document-uri': string;
    disposition: string;
    'script-sample'?: string;
};

async function installCspListener(page: Page) {
    await page.addInitScript(() => {
        (window as unknown as Record<string, unknown>).__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
            ((window as unknown as Record<string, unknown>).__cspViolations as ViolationHit[]).push(
                {
                    violatedDirective: e.violatedDirective,
                    effectiveDirective: e.effectiveDirective,
                    blockedURI: e.blockedURI,
                    disposition: e.disposition,
                    sample: e.sample,
                }
            );
        });
    });
}

async function readCapturedReports(
    request: APIRequestContext,
    expected: number
): Promise<CspReport[]> {
    let reports: CspReport[] = [];
    await expect
        .poll(async () => {
            const response = await request.get('/api/test-responses');
            const entries = await response.json();
            reports = entries
                .filter(
                    (e: { result: string; requestPath: string }) =>
                        e.result === 'capture' && e.requestPath === '/capture/csp'
                )
                .map((e: { body: string }) => JSON.parse(e.body)['csp-report'] as CspReport);
            return reports.length;
        })
        .toBe(expected);
    return reports;
}

test.describe('CSP injection', () => {
    test.beforeEach(async ({ page, swHelper }) => {
        // Bootstrap under csp-report-manifest.json — enforce + reportUri.
        await page.goto('/csp-report.html');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation();
    });

    test('SW injects Content-Security-Policy header on document navigation', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-denied',
            formula: 'remap',
            args: { file: 'index.html' },
        });
        const response = await page.goto('/csp-test-denied');
        expect(response.fromServiceWorker()).toBeTruthy();
        const csp = response.headers()['content-security-policy'];
        expect(csp).toBeDefined();
        expect(csp).toContain('script-src-elem');
        expect(csp).toContain('*');
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain("base-uri 'none'");
        expect(csp).toContain(`report-uri ${REPORT_URI}`);
    });

    test('SW strips origin CSP headers and replaces them, but preserves other policy headers', async ({
        page,
        swHelper,
    }) => {
        const REPORT_TO_VALUE =
            '{"group":"default","max_age":86400,"endpoints":[{"url":"https://origin.example/reports"}]}';
        await swHelper.setServerTestParameters({
            responseHeaders: [
                {
                    match: '/csp-test-denied',
                    headers: {
                        'Content-Security-Policy':
                            "script-src 'unsafe-inline' 'unsafe-eval'; frame-ancestors *",
                        'Content-Security-Policy-Report-Only': "script-src 'unsafe-inline'",
                        'Permissions-Policy': 'geolocation=(), camera=()',
                        'Reporting-Endpoints': 'default="https://origin.example/reports"',
                        'Report-To': REPORT_TO_VALUE,
                        'Cache-Control': 'no-store',
                    },
                },
            ],
            intercept: {
                pattern: '/csp-test-denied',
                formula: 'remap',
                args: { file: 'index.html' },
            },
        });
        const response = await page.goto('/csp-test-denied');
        expect(response.fromServiceWorker()).toBeTruthy();
        const headers = response.headers();

        // Origin CSP is untrusted — its directives must not survive, and DappFence's
        // replacement must be what actually enforces on the page.
        const csp = headers['content-security-policy'];
        expect(csp).toBeDefined();
        expect(csp).not.toContain("'unsafe-eval'");
        expect(csp).not.toContain('frame-ancestors *');
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain('script-src-elem');
        // Report-Only flavor is stripped too — otherwise attacker-controlled
        // report-uri would exfiltrate the browser's violation reports.
        expect(headers['content-security-policy-report-only']).toBeUndefined();

        // Headers that used to be in ADDITIVE_HEADERS pass through unmodified.
        // The SW never appends to or overrides them and never emits its own.
        expect(headers['permissions-policy']).toBe('geolocation=(), camera=()');
        expect(headers['reporting-endpoints']).toBe('default="https://origin.example/reports"');
        expect(headers['report-to']).toBe(REPORT_TO_VALUE);
    });

    test('CSP header for path with no csp.pages entry has no hash or strict-dynamic', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-denied',
            formula: 'remap',
            args: { file: 'index.html' },
        });
        const response = await page.goto('/csp-test-denied');
        expect(response.fromServiceWorker()).toBeTruthy();
        const csp = response.headers()['content-security-policy'];
        expect(csp).toBeDefined();
        expect(csp).not.toContain('sha256-');
        expect(csp).not.toContain('strict-dynamic');
    });

    test('CSP header for path with csp.pages entry includes hashes', async ({ page, swHelper }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-allowed',
            formula: 'remap',
            args: { file: 'index.html' },
        });
        const response = await page.goto('/csp-test-allowed');
        expect(response.fromServiceWorker()).toBeTruthy();
        const csp = response.headers()['content-security-policy'];
        expect(csp).toBeDefined();
        expect(csp).toContain(`'${CSP_INLINE_1_HASH}'`);
        expect(csp).toContain('*');
    });

    test('page loads without CSP violations and all directives have the expected semantics', async ({
        page,
        swHelper,
    }) => {
        await installCspListener(page);

        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-allowed',
            formula: 'remap',
            args: { file: 'index.html' },
        });
        const response = await page.goto('/csp-test-allowed');

        expect(response.fromServiceWorker()).toBeTruthy();
        const isControlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
        expect(isControlled).toBeTruthy();

        const csp = response.headers()['content-security-policy'];
        expect(csp).toBeDefined();

        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain('script-src-elem');
        expect(csp).toContain(`'${CSP_INLINE_1_HASH}'`); // one of the hashed template scripts
        expect(csp).toContain('*');
        expect(csp).not.toContain('strict-dynamic');
        expect(csp).toMatch(/style-src (?:'report-sample' )?'self' 'unsafe-inline'/);
        expect(csp).toContain("worker-src 'self'");
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain("base-uri 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain(`report-uri ${REPORT_URI}`);
        expect(csp).not.toContain('/sw-api/csp-violation');

        const brandColor = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--color-brand').trim()
        );
        expect(brandColor).toBeTruthy();

        // No CSP violations during page load — every directive is correctly configured.
        const violations = await page.evaluate(
            () => (window as unknown as Record<string, unknown>).__cspViolations as ViolationHit[]
        );
        expect(violations).toEqual([]);
    });

    test('inline script without a matching hash is blocked AND report POSTs to /capture/csp', async ({
        page,
        request,
        swHelper,
    }) => {
        await installCspListener(page);
        await swHelper.setServerTestParameters({
            saveResponses: true,
            intercept: {
                pattern: '/csp-test-denied',
                formula: 'remap',
                args: {
                    file: 'index.html',
                    inject: [
                        '<script>window.__blockedScriptRan = true;</script>',
                        '<!-- test:inject-body-end -->',
                    ],
                },
            },
        });

        await page.goto('/csp-test-denied');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        const ran = await page.evaluate(
            () => (window as unknown as Record<string, unknown>).__blockedScriptRan
        );
        expect(ran).toBeUndefined();

        const listenerHits = await page.evaluate(
            () => (window as unknown as Record<string, unknown>).__cspViolations as ViolationHit[]
        );
        expect(listenerHits.length).toBeGreaterThan(0);
        for (const v of listenerHits) {
            expect(v.effectiveDirective).toBe('script-src-elem');
            expect(v.blockedURI).toBe('inline');
            expect(v.disposition).toBe('enforce');
        }
        expect(listenerHits.find((v) => v.sample.includes('__blockedScriptRan'))).toBeDefined();

        const posted = await readCapturedReports(request, listenerHits.length);
        for (const r of posted) {
            expect(r['effective-directive']).toBe('script-src-elem');
            expect(r['blocked-uri']).toBe('inline');
            expect(r['document-uri']).toContain('/csp-test-denied');
            expect(r.disposition).toBe('enforce');
        }
        expect(
            posted.find((r) => (r['script-sample'] ?? '').includes('__blockedScriptRan'))
        ).toBeDefined();
    });

    test('template inline scripts execute when their hashes are in the manifest', async ({
        page,
        swHelper,
    }) => {
        const injectedScript = '<script>window.__injectedRan = true;</script>';
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-allowed',
            formula: 'remap',
            args: { file: 'index.html', inject: [injectedScript, '<!-- test:inject-body-end -->'] },
        });
        await page.goto('/csp-test-allowed');
        // Wait for the 50ms setTimeout template script to fire
        await page.waitForFunction(
            () => (window as unknown as Record<string, unknown>).__csp_timer !== undefined,
            { timeout: 2000 }
        );
        const result = await page.evaluate(() => {
            const w = window as unknown as Record<string, unknown>;
            return {
                cspInline1: w.__csp_inline_1,
                cspTimer: w.__csp_timer,
                rscChunks: w.__rsc_chunks,
                bypassExecuted: w.__bypass_executed,
                injectedRan: w.__injectedRan,
            };
        });
        expect(result.cspInline1).toBe('script-1-ran');
        expect(result.cspTimer).toBe('timer-ran');
        expect(result.rscChunks).toEqual([
            [0, { value: 42 }],
            [0, '<!--<script>'],
        ]);
        expect(result.bypassExecuted).toBe(true);
        expect(result.injectedRan).toBeUndefined();
    });

    // TODO(MutationObserver): update this test once the client-side Observer is implemented.
    // The Observer will detect the blocked RSC push, validate its JSON structure, and call
    // self.__next_f.push() safely — so rscChunks should then include [0, { value: 99 }].
    test('injected RSC push script is blocked by CSP when its hash is not in the manifest', async ({
        page,
        swHelper,
    }) => {
        // Template scripts on /csp-test-allowed have hashes in the manifest — RSC emulator runs.
        // The injected push has no hash — CSP blocks it, so value:99 never lands in rscChunks.
        const injectedPush = '<script>self.__next_f.push([0, { value: 99 }]);</script>';
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-allowed',
            formula: 'remap',
            args: { file: 'index.html', inject: [injectedPush, '<!-- test:inject-body-end -->'] },
        });
        await page.goto('/csp-test-allowed');
        await page.waitForFunction(
            () => Array.isArray((window as unknown as Record<string, unknown>).__rsc_chunks),
            { timeout: 2000 }
        );
        const chunks = await page.evaluate(
            () => (window as unknown as Record<string, unknown>).__rsc_chunks
        );
        // Only the two template RSC pushes ran; the injected value:99 push was blocked.
        expect(chunks).toEqual([
            [0, { value: 42 }],
            [0, '<!--<script>'],
        ]);
    });

    test('all inline scripts are blocked when the manifest has no hashes for the page', async ({
        page,
        swHelper,
    }) => {
        const injectedScript = '<script>window.__cspAllowedScriptRan = true;</script>';
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-rsc',
            formula: 'remap',
            args: { file: 'index.html', inject: [injectedScript, '<!-- test:inject-body-end -->'] },
        });
        await page.goto('/csp-test-rsc');
        const result = await page.evaluate(() => {
            const w = window as unknown as Record<string, unknown>;
            return {
                bypass_executed: w.__bypass_executed,
                cspInline1: w.__csp_inline_1,
                cspTimer: w.__csp_timer,
                rscChunks: w.__rsc_chunks,
                cspAllowedScriptRan: w.__cspAllowedScriptRan,
            };
        });
        expect(result.bypass_executed).toBeUndefined();
        expect(result.cspInline1).toBeUndefined();
        expect(result.cspTimer).toBeUndefined();
        expect(result.rscChunks).toBeUndefined();
        expect(result.cspAllowedScriptRan).toBeUndefined();
    });

    test('CSP is always emitted on document navigations, even without a csp.pages entry', async ({
        page,
    }) => {
        // Navigate to '/' → resolves to '/index.html'. The manifest has no
        // csp.pages entry for '/index.html' (only '/csp-test-allowed'), so the
        // CSP header emits with just the nonce + '*' — no inline script hashes.
        // All inline scripts on the page are blocked by the browser as a result;
        // this is the forcing-function property (see docs/csp-injection-strategy.md).
        const response = await page.goto('/');
        expect(response.fromServiceWorker()).toBeTruthy();
        const csp = response.headers()['content-security-policy'];
        expect(csp).toBeDefined();
        expect(csp).toContain('script-src-elem');
        expect(csp).toContain('nonce-');
        expect(csp).not.toContain('sha256-');

        const result = await page.evaluate(() => {
            const w = window as unknown as Record<string, unknown>;
            return {
                cspInline1: w.__csp_inline_1,
                cspTimer: w.__csp_timer,
                rscChunks: w.__rsc_chunks,
                bypassExecuted: w.__bypass_executed,
            };
        });
        expect(result.cspInline1).toBeUndefined();
        expect(result.cspTimer).toBeUndefined();
        expect(result.rscChunks).toBeUndefined();
        expect(result.bypassExecuted).toBeUndefined();
    });

    test('report-uri from manifest.csp.reportUri is emitted as the last directive', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-denied',
            formula: 'remap',
            args: { file: 'index.html' },
        });
        const response = await page.goto('/csp-test-denied');
        expect(response.fromServiceWorker()).toBeTruthy();
        const headers = response.headers();

        // Enforce header carries the report-uri; no Report-Only header is emitted
        // since csp-report-manifest.json does not set csp.reportOnly.
        const csp = headers['content-security-policy'];
        expect(csp).toBeDefined();
        expect(headers['content-security-policy-report-only']).toBeUndefined();

        // Kept last so consumers extracting the URI with a `\S+`-style regex
        // don't accidentally capture the `; ` separator and a following directive.
        const directives = csp.split('; ');
        expect(directives[directives.length - 1]).toBe(`report-uri ${REPORT_URI}`);
    });
});

test('report-only manifest: violating script executes AND report POSTs to /capture/csp', async ({
    page,
    request,
    swHelper,
}) => {
    await page.goto('/csp-report-only.html');
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    await swHelper.waitForServiceWorkerActivation();

    await installCspListener(page);
    await swHelper.setServerTestParameters({
        saveResponses: true,
        intercept: {
            pattern: '/csp-test-denied',
            formula: 'remap',
            args: {
                file: 'index.html',
                inject: [
                    '<script>window.__violation = true;</script>',
                    '<!-- test:inject-body-end -->',
                ],
            },
        },
    });

    await page.goto('/csp-test-denied');
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

    const ran = await page.evaluate(
        () => (window as unknown as Record<string, unknown>).__violation
    );
    expect(ran).toBe(true);

    const listenerHits = await page.evaluate(
        () => (window as unknown as Record<string, unknown>).__cspViolations as ViolationHit[]
    );
    expect(listenerHits.length).toBeGreaterThan(0);
    for (const v of listenerHits) {
        expect(v.effectiveDirective).toBe('script-src-elem');
        expect(v.blockedURI).toBe('inline');
        expect(v.disposition).toBe('report');
    }
    expect(listenerHits.find((v) => v.sample.includes('__violation'))).toBeDefined();

    const posted = await readCapturedReports(request, listenerHits.length);
    for (const r of posted) {
        expect(r['effective-directive']).toBe('script-src-elem');
        expect(r['blocked-uri']).toBe('inline');
        expect(r['document-uri']).toContain('/csp-test-denied');
        expect(r.disposition).toBe('report');
    }
    expect(posted.find((r) => (r['script-sample'] ?? '').includes('__violation'))).toBeDefined();
});
