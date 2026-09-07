import { expect, test } from '../sw-fixtures';

type CspViolation = Pick<
    SecurityPolicyViolationEvent,
    Exclude<keyof SecurityPolicyViolationEvent, keyof Event>
>;
declare global {
    interface Window {
        __cspViolations: CspViolation[];
    }
}

test.describe('Browser CSP behavior (no DappFence)', () => {
    // page.addInitScript serializes the callback via .toString(); Node closures
    // don't cross, so snapshotEventFields must live inside.
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            const snapshotEventFields = <T extends Event>(e: T): Record<string, unknown> => {
                const proto = Object.getPrototypeOf(e);
                const out: Record<string, unknown> = {};
                for (const k of Object.getOwnPropertyNames(proto)) {
                    if (typeof Object.getOwnPropertyDescriptor(proto, k)?.get === 'function') {
                        out[k] = (e as unknown as Record<string, unknown>)[k];
                    }
                }
                return out;
            };
            window.__cspViolations = [];
            document.addEventListener('securitypolicyviolation', (e) => {
                window.__cspViolations.push(snapshotEventFields(e));
            });
        });
    });

    test('Subresource CSP headers are ignored — only navigation CSP applies', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            responseHeaders: [
                {
                    match: '/csp-tests/nav-and-fetch.html',
                    headers: {
                        'Content-Security-Policy': "script-src 'self'",
                        'Cache-Control': 'no-store',
                    },
                },
                {
                    match: '/csp-tests/probe-a.js',
                    headers: {
                        'Content-Security-Policy': "script-src 'none'",
                        'Cache-Control': 'no-store',
                    },
                },
            ],
        });

        await page.goto('/csp-tests/nav-and-fetch.html');

        const flags = await page.evaluate(() => {
            const w = window as unknown as Record<string, unknown>;
            return {
                inlineNoCsp: w.__inlineNoCspRan,
                a: w.__probeA,
                b: w.__probeB,
            };
        });

        expect(flags.inlineNoCsp).toBeUndefined();
        expect(flags.a).toBe('ran');
        expect(flags.b).toBe('ran');

        const violations = await page.evaluate(() => window.__cspViolations);
        expect(violations).toHaveLength(1);
        expect(violations[0].effectiveDirective).toBe('script-src-elem');
        expect(violations[0].blockedURI).toBe('inline');
        expect(violations[0].disposition).toBe('enforce');
        expect(violations[0].originalPolicy).toContain("script-src 'self'");
    });

    test('nonce + wildcard without strict-dynamic — wildcard still permits external scripts', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            responseHeaders: [
                {
                    match: '/csp-tests/nonce-page.html',
                    headers: {
                        // 'report-sample' tells Chrome to populate SecurityPolicyViolationEvent.sample
                        // with a snippet of the blocked inline body — used below to pin which script tripped.
                        'Content-Security-Policy':
                            "script-src 'nonce-csptest123' 'report-sample' *",
                        'Cache-Control': 'no-store',
                    },
                },
            ],
        });

        await page.goto('/csp-tests/nonce-page.html');

        const flags = await page.evaluate(() => {
            const w = window as unknown as Record<string, unknown>;
            return {
                nonced: w.__inlineNonceRan,
                noNonce: w.__inlineNoNonceRan,
                wrongNonce: w.__inlineWrongNonceRan,
                externalProbe: w.__probeA,
            };
        });

        expect(flags.nonced).toBe('ran');
        expect(flags.externalProbe).toBe('ran');
        expect(flags.noNonce).toBeUndefined();
        expect(flags.wrongNonce).toBeUndefined();

        const violations = await page.evaluate(() => window.__cspViolations);
        expect(violations).toHaveLength(2);
        for (const v of violations) {
            expect(v.effectiveDirective).toBe('script-src-elem');
            expect(v.blockedURI).toBe('inline');
        }
        // Violations fire in document order; sample carries a snippet of the
        // blocked inline body so we can pin exactly which <script> tripped each.
        expect(violations[0].sample).toContain('__inlineNoNonceRan');
        expect(violations[1].sample).toContain('__inlineWrongNonceRan');
    });

    test('DappFence-style CSP (no strict-dynamic): nonced/hashed and wildcard-external run; every other vector fires the right violation', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            responseHeaders: [
                {
                    match: '/csp-tests/dappfence-csp.html',
                    headers: {
                        'Content-Security-Policy': [
                            "default-src 'none'",
                            "script-src-elem 'nonce-boot' *",
                            "style-src 'self' 'unsafe-inline'",
                            "img-src 'self' data:",
                            "connect-src 'self'",
                            "object-src 'none'",
                            "base-uri 'none'",
                            'report-uri /noop',
                        ].join('; '),
                        'Cache-Control': 'no-store',
                    },
                },
            ],
        });

        await page.goto('/csp-tests/dappfence-csp.html');

        await page.waitForFunction(
            () => (window as unknown as { __c?: { bootDone?: number } }).__c?.bootDone === 1,
            { timeout: 2000 }
        );

        const positive = await page.evaluate(() => {
            const w = window as unknown as {
                __c?: Record<string, unknown>;
                __probeA?: string;
            };
            return {
                c: w.__c,
                probeA: w.__probeA,
                canaryStyle: getComputedStyle(document.documentElement)
                    .getPropertyValue('--canary-style')
                    .trim(),
            };
        });

        expect(positive.c?.bootRan).toBe(1);
        expect(positive.c?.bootDone).toBe(1);
        expect(positive.c?.evalError).toBe(1);
        expect(positive.c?.funcError).toBe(1);
        expect(positive.c?.fetchError).toBe(1);
        expect(positive.probeA).toBe('ran');
        expect(positive.canaryStyle).toBe('applied');

        expect(positive.c?.inlineNoNonce).toBeUndefined();
        expect(positive.c?.onerror).toBeUndefined();
        expect(positive.c?.jsurl).toBeUndefined();
        expect(positive.c?.evalRan).toBeUndefined();
        expect(positive.c?.funcRan).toBeUndefined();
        expect(positive.c?.fetchStatus).toBeUndefined();
        expect(positive.c?.innerHtmlScript).toBeUndefined();
        expect(positive.c?.dataUri).toBeUndefined();

        const violations = await page.evaluate(() => window.__cspViolations);

        // data: URI is blocked because `*` excludes data:/blob:/filesystem: per CSP3.
        expect(
            violations.some(
                (e) => e.effectiveDirective === 'script-src-elem' && e.blockedURI === 'data'
            )
        ).toBe(true);

        const directives = Array.from(new Set(violations.map((e) => e.effectiveDirective)));
        expect(directives.sort()).toEqual(
            [
                'base-uri',
                'connect-src',
                'img-src',
                'object-src',
                'script-src',
                'script-src-attr',
                'script-src-elem',
            ].sort()
        );
    });
});
