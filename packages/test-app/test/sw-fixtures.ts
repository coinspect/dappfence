import {
    APIRequestContext,
    Browser,
    BrowserContext,
    ConsoleMessage,
    Frame,
    Page,
    Request,
    test as base,
    TestInfo,
    Worker,
} from '@playwright/test';
import { PageFunction } from 'playwright-core/types/structs';
import * as fs from 'node:fs';

declare global {
    interface Window {
        // unique identifier used to log messages
        pageId: string;
        // set by the Netlify CDP stub script; used to assert MATCH vs MISMATCH in filter tests
        __cdnScriptLoaded?: string;
    }
}

declare module '@playwright/test' {
    // TypeScript will merge this with the existing definition
    interface Browser {
        fakeTimeFile: string;
        isValidFakeTimeLib: boolean;
    }
}

export type ServiceWorkerWithClose = {
    url: () => string;
    evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg?: Arg): Promise<R>;
    waitUntilClosed: (timeout?: number) => Promise<ServiceWorkerWithClose>;
    closed: boolean;
};
export type InterceptPattern =
    | {
          pattern: string;
          formula?: 'default';
          args?: never;
          contentType?: string;
          statusCode?: number;
      }
    | {
          pattern: string;
          formula: 'unchanged';
          args?: never;
          contentType?: string;
          statusCode?: number;
      }
    | {
          pattern: string;
          formula: 'replace';
          args: string;
          contentType?: string;
          statusCode?: number;
      }
    | { pattern: string; formula: 'empty'; args?: never; contentType?: string; statusCode?: number }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | { pattern: string; formula: 'inject'; args: any; contentType?: string; statusCode?: number };

export type ServerTestParameters = {
    appName?: string;
    appVersion?: string;
    responseHeaders?: { match: string; headers: Record<string, string> }[];
    saveResponses?: boolean;
    intercept?: InterceptPattern | InterceptPattern[];
};
export type ServerTestResponse = {
    testId: string;
    url: string;
    appName: string;
    appVersion: string;
    requestPath: string;
    filePath: string;
    result: string;
};
export type SWHelper = {
    shortTestId: string;
    newPage: (pageName?: string) => Promise<Page>;
    storageGet: (onPage: Page, key: string) => Promise<string>;
    sendHardReload: (onPage?: Page) => Promise<void>;
    waitForServiceWorkers: (length: number) => Promise<ServiceWorkerWithClose[]>;
    consoleLogRegistration(registration: ServiceWorkerRegistration): void;
    getServiceWorkerState(serviceWorker: ServiceWorkerWithClose): Promise<string>;
    waitForServiceWorkerActivation: (onPage?: Page) => Promise<string>;
    waitForServiceWorkerMessage: (msg: string) => Promise<{ worker: Worker; msg: ConsoleMessage }>;
    interceptAndModifyPageContent: {
        (pattern: InterceptPattern | InterceptPattern[]): Promise<void>;
        // Flat params are intentionally unchecked — use InterceptPattern[] for type safety
        (pattern: string, formula?: string, args?: string): Promise<void>;
    };
    clearIntercept(): Promise<void>;
    consoleLogDebug: (onPage?: Page) => void;
    playwrightDebug: (onPage?: Page) => void;
    requestDebug: (onPage?: Page) => Promise<void>;
    setVersion: (version: string, projectName?: string) => Promise<void>;
    setFakeTime: (time: string) => Promise<void>;
    setServerTestParameters: (testParameters?: ServerTestParameters) => Promise<void>;
    getServerResponses: () => Promise<ServerTestResponse[]>;
};

// Define the type for your new fixture
export type SWFixtures = { swHelper: SWHelper; swNoRoute: SWHelper };

export function formatRequestLogMessage(r: Request) {
    const redirected = r.redirectedFrom();

    // We prefer to try instead of just checking if !r.serviceWorker()
    let frame: Frame;
    try {
        frame = r.frame();
    } catch (_e) {
        // frame() may throw for SW requests — ignore
    }

    return [
        r.serviceWorker() ? 'SW-Request' : '          ',
        r.isNavigationRequest() ? 'Navigation' : '          ',
        frame ? 'frame: ' + frame.url() : 'No-Frame',
        redirected ? 'redirect: ' + redirected.url() : 'No-Redirect',
        r.method(),
        r.url(),
    ];
}
function initScript({ page_key, sw_url }) {
    console.log(`${page_key} init script for page ${window.location.href} ${sw_url}`);
    // Sometimes we are too early, and we get an empty registration, so we loop over and wait (only use it for debug)
    (async () => {
        const states = ['waiting', 'installing', 'active'];
        const registrationInstances = [];
        const swInstances = new Set<ServiceWorker>();
        const swXRegistration = new Map<number, ServiceWorker[]>();
        if (!navigator.serviceWorker) {
            console.log(`${page_key} no navigator.serviceWorker`);
            return;
        }
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            const controller = navigator.serviceWorker.controller;
            console.log(`${page_key} controllerchange ${controller?.scriptURL}`);
            // TODO: search it in the swXRegistration
        });
        while (true) {
            const registrations = await window.navigator.serviceWorker.getRegistrations();
            for (const registration of registrations) {
                let rIdx = registrationInstances.indexOf(registration);
                if (rIdx < 0) {
                    registrationInstances.push(registration);
                    rIdx = registrationInstances.length - 1;
                    swXRegistration[rIdx] = [];
                    console.log(
                        `${page_key} got new registration ${rIdx} for scope ${registration.scope}`
                    );
                }
                for (const state of states) {
                    if (!registration[state]) {
                        continue;
                    }
                    const sw = registration[state];

                    const swIdx = swXRegistration[rIdx].indexOf(sw);
                    if (swIdx < 0) {
                        console.log(
                            `${page_key} found new service worker ${sw.scriptURL} in registration ${rIdx} and state ${state}`
                        );
                        swXRegistration[rIdx].push(sw);
                    }

                    if (!swInstances.has(sw)) {
                        console.log(
                            `${page_key} new service worker ${sw.scriptURL} state ${state}, current state ${sw.state}`
                        );
                        swInstances.add(sw);
                        sw.addEventListener('statechange', (e: unknown) => {
                            const ev = e as { target: { state: string; scriptURL: string } };
                            console.log(
                                `${page_key} statechange ${ev.target.scriptURL}, current ${ev.target.state}`
                            );
                        });
                    }
                }
            }
        }
    })();
}

async function writeAndSync(file: string, content: string) {
    fs.writeFileSync(file, content, { flush: true });
}

async function swHelper(
    {
        request,
        page,
        context,
        browser,
    }: {
        request: APIRequestContext;
        context: BrowserContext;
        page: Page;
        browser: Browser;
    },
    use: (arg0: SWHelper) => Promise<void>,
    testInfo: TestInfo
) {
    const { fakeTimeFile, isValidFakeTimeLib } = browser;
    const shortTestId = testInfo.testId.slice(-5);
    const swList = [];
    const resolvers = [];
    const messageResolvers = [];

    let consoleLogDebug = false;
    // Custom HTTP headers injected into all requests to control server-side versioning and test identification
    let testParametersCache: ServerTestParameters = {};
    context.on('serviceworker', (s: Worker) => {
        s.on('console', (msg: ConsoleMessage) => {
            for (const r of messageResolvers) {
                if (msg.text().includes(r.msg)) {
                    r.done = true;
                    r.resolve({ worker: s, msg });
                }
            }
        });
        const swWithClose: ServiceWorkerWithClose = {
            url: () => s.url(),
            evaluate: (pageFunction, arg) => s.evaluate(pageFunction, arg),
            closed: false,
            waitUntilClosed: async (timeout = 30000) => {
                if (swWithClose.closed) {
                    return swWithClose;
                }
                await s.waitForEvent('close', { timeout });
                swWithClose.closed = true;
                return swWithClose;
            },
        };
        s.on('close', () => {
            swWithClose.closed = true;
        });
        swList.push(swWithClose);
        for (const r of resolvers) {
            if (swList.length >= r.desiredLength) {
                r.done = true;
                r.resolve([...swList]);
            }
        }
    });
    const swHelper: SWHelper = {
        shortTestId,
        newPage: async (pageName?: string) => {
            const pagePromise = context.waitForEvent('page');
            const page = await context.newPage();
            await pagePromise;
            if (!pageName) {
                pageName = 'unnamed-' + Math.random().toString(36).substring(2);
            }
            await page.addInitScript((pageName) => {
                window.pageId = pageName;
            }, pageName);
            return page;
        },
        storageGet: async (onPage: Page, key: string): Promise<string> => {
            return await onPage.evaluate(async (key) => {
                return await new Promise((resolve, reject) => {
                    const dbRequest = indexedDB.open('AppSecurity', 1);
                    dbRequest.onerror = () => reject(dbRequest.error);
                    dbRequest.onsuccess = () => {
                        const db = dbRequest.result;
                        const transaction = db.transaction(['data'], 'readonly');
                        const request: IDBRequest<string> = transaction
                            .objectStore('data')
                            .get(key);
                        request.onerror = () => reject(request.error);
                        request.onsuccess = () => resolve(request.result);
                    };
                });
            }, key);
        },
        consoleLogRegistration: (registration: ServiceWorkerRegistration) => {
            console.log(
                `[SW-STATE] Waiting for service worker activation...`,
                'installing',
                registration.installing ? registration.installing.scriptURL : ' is null',
                'waiting',
                registration.waiting ? registration.waiting.scriptURL : ' is null',
                'active',
                registration.active ? registration.active.scriptURL : ' is null'
            );
        },
        getServiceWorkerState: async (serviceWorker: ServiceWorkerWithClose) => {
            return await serviceWorker.evaluate(() => {
                // @ts-expect-error: TypeScript doesn't recognize 'registration' on ServiceWorkerGlobalScope
                const registration = self.registration;
                if (!registration) {
                    throw new Error('No registration found');
                }
                swHelper.consoleLogRegistration(registration);
                const serviceWorker =
                    registration.active || registration.waiting || registration.installing;
                if (!serviceWorker) {
                    throw new Error('No service worker found');
                }
                return serviceWorker.state;
            });
        },
        sendHardReload: async (onPage: Page = page) => {
            // Send a hard/force refresh
            const client = await onPage.context().newCDPSession(onPage);
            await client.send('Page.reload', { ignoreCache: true });
            await client.detach();
        },
        waitForServiceWorkers: async (desiredLength: number): Promise<ServiceWorkerWithClose[]> => {
            if (swList.length >= desiredLength) {
                return Promise.resolve([...swList]);
            }
            return new Promise((resolve, reject) =>
                resolvers.push({ desiredLength, resolve, reject })
            );
        },
        waitForServiceWorkerMessage: async (
            msg: string
        ): Promise<{ worker: Worker; msg: ConsoleMessage }> => {
            return new Promise((resolve, reject) =>
                messageResolvers.push({ msg, resolve, reject })
            );
        },
        waitForServiceWorkerActivation: async (onPage: Page = page): Promise<string> => {
            // Verifies that a service worker is installed and reaches the 'activated' state.
            // This requires evaluating code within the page context since Playwright's context.waitForEvent('serviceworker')
            // only detects when the service worker is loaded, not when it becomes active.
            return await onPage.evaluate(async () => {
                const registration = await navigator.serviceWorker.ready;
                // swHelper.consoleLogRegistration(registration);

                // The 'controllerchange' event fires when the service worker is 'activating',
                // so waiting for it is insufficient to confirm the 'activated' state.
                // Similarly, 'statechange' events may not fire reliably in all scenarios.
                // Therefore, we poll the state until it reaches 'activated'.
                let serviceWorker = registration.active;
                while (serviceWorker.state !== 'activated') {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                    serviceWorker = registration.active;
                }
                return serviceWorker.scriptURL;
            });
        },
        interceptAndModifyPageContent: async (
            pattern: string | InterceptPattern | InterceptPattern[],
            formula?: string,
            args?: string
        ) => {
            const intercept: InterceptPattern | InterceptPattern[] =
                typeof pattern === 'string'
                    ? ({ pattern, formula, args } as InterceptPattern)
                    : pattern;
            await swHelper.setServerTestParameters({ intercept });
        },
        clearIntercept: async () => {
            await swHelper.setServerTestParameters({ intercept: [] });
        },
        playwrightDebug: (onPage = page) => {
            const DEBUG_KEY = '------->';
            const SCRIPT_DEBUG_KEY = 'script debug --->';
            function log(...args: unknown[]) {
                console.log(shortTestId, DEBUG_KEY, ...args);
            }
            context.on('request', (r) => log('Request intercepted', ...formatRequestLogMessage(r)));
            context.on('serviceworker', (s) => {
                log(`SW detected: ${s.url()}`);
                log(
                    'current service workers',
                    context.serviceWorkers().map((sw) => sw.url())
                );
            });
            context.on('page', (p) => {
                log(`page detected ${p.url()}`);
            });
            onPage.on('console', (msg: ConsoleMessage) => {
                const t = msg.text();
                if (!consoleLogDebug && t.startsWith(SCRIPT_DEBUG_KEY)) {
                    log(t.substring(SCRIPT_DEBUG_KEY.length).trim());
                }
            });
            // This runs too early, and we don't get any registration in the initial page, so we also call it on serviceworker
            context.addInitScript(initScript, { page_key: SCRIPT_DEBUG_KEY, sw_url: '' });
            onPage.on('framenavigated', (data) => {
                log('framenavigated', data.page().url());
            });
            log('current page', onPage.url());
        },
        consoleLogDebug: (onPage = page) => {
            consoleLogDebug = true;
            onPage.on('console', (msg: ConsoleMessage) => {
                console.log(shortTestId, msg);
            });
            context.on('serviceworker', (s: Worker) => {
                s.on('console', (msg: ConsoleMessage) => {
                    console.log(shortTestId, `---> SW ${msg.type()}:`, msg);
                });
            });
        },
        requestDebug: async (onPage: Page = page) => {
            const client = await onPage.context().newCDPSession(onPage);
            await client.send('Network.enable');
            client.on('Network.responseReceived', (params) => {
                console.log({
                    url: params.response.url,
                    fromDiskCache: params.response.fromDiskCache,
                    fromPrefetchCache: params.response.fromPrefetchCache,
                    fromEarlyHints: params.response.fromEarlyHints,
                    requestTime: new Date(params.response.responseTime).toISOString(),
                    headers: params.response.headers,
                });
            });
        },
        setFakeTime: async (time: string) => {
            if (!fakeTimeFile) {
                throw new Error('[SWFakeTimeHelper] fake time file not configured');
            }
            // Validate libfaketime format: absolute (YYYY-MM-DD [hh:mm:ss]) or relative (+/-Nd, +/-Nh, +/-Nm, +/-Ns, @TIMESTAMP)
            const absoluteDateRegex = /^\d{4}-\d{2}-\d{2}(\s\d{2}:\d{2}:\d{2})?$/;
            const relativeRegex = /^[+-]\d+([.,]\d+)?[dhms]?(\s+x\d+(\.\d+)?)?$/;
            const timestampRegex = /^@\d+(\.\d+)?$/;

            if (
                !absoluteDateRegex.test(time) &&
                !relativeRegex.test(time) &&
                !timestampRegex.test(time)
            ) {
                throw new Error(
                    `[SWFakeTimeHelper] Invalid fake time format: "${time}". ` +
                        `Expected formats: YYYY-MM-DD [hh:mm:ss], +/-Nd/h/m/s [xSPEED], or @TIMESTAMP`
                );
            }
            await writeAndSync(fakeTimeFile, time);
        },
        async setVersion(version: string, projectName: string) {
            await swHelper.setServerTestParameters({
                appName: projectName || testInfo.project.name,
                appVersion: version || 'latest',
            });
        },
        setServerTestParameters: async (testParameters?: ServerTestParameters) => {
            testParametersCache = { ...testParametersCache, ...testParameters };
            await request.post('/api/test-config', {
                data: {
                    testId: testInfo.testId,
                    testTitle: testInfo.title,
                    appName: testInfo.project.name,
                    appVersion: 'latest',
                    ...testParametersCache,
                },
            });
        },
        getServerResponses: async () => {
            const res = await request.get('/api/test-responses');
            return await res.json();
        },
    };

    if (testInfo.project.name.startsWith('fake-time') && !isValidFakeTimeLib) {
        test.skip(true, `skipping the test fake time library libFakeTime not found`);
    }
    if (fakeTimeFile) {
        // Set current time
        await writeAndSync(fakeTimeFile, '+0');
    }
    // We don't use playwrite route interception because:
    // Playwright disables the cache when we use context.route, see:https://github.com/microsoft/playwright/issues/7220
    // https://developer.chrome.com/docs/devtools/overrides: "Cache is disabled when Local overrides are enabled."
    await swHelper.setServerTestParameters();
    await use(swHelper);
    await request.delete('/api/test-clear');

    // Teardown logic, resolve all my promises just in case.
    for (const r of resolvers) {
        if (!r.done) {
            r.reject(new Error('Test was aborted'));
        }
    }
    for (const r of messageResolvers) {
        if (!r.done) {
            r.resolve(new Error('Test was aborted'));
        }
    }
}

// Extend the base test with custom fixtures for Service Worker testing.
// This creates an enhanced test object that includes:
// - swHelper: A fixture providing utility methods for interacting with Service Workers in tests
// - browser: A worker-scoped fixture that configures libfaketime for time manipulation in tests
//
// The test object can be imported and used in test files to access these fixtures automatically.
// Example: import { test, expect } from './sw-fixtures';
export const test = base.extend<SWFixtures, { browser: Browser }>({
    // Define the fixture
    swHelper: [swHelper, { scope: 'test', auto: true }],
    baseURL: async ({ baseURL }, use, testInfo) => {
        const newBaseUrl = new URL(baseURL);
        // To use the hostname, we must switch to ssl, and for that we need a valid
        // certificate (ignoreHTTPSErrors doesn't work with service workers and importScripts)
        // ret.hostname = `playwright_test_${testInfo.testId}`;
        newBaseUrl.port = (parseInt(newBaseUrl.port) + testInfo.workerIndex).toString();
        // This overrides the baseURL for all tests using this fixture
        await use(newBaseUrl.toString());
    },
    browser: [
        async ({ playwright, browserName, launchOptions }, use) => {
            const launchOptionsEnv = launchOptions && launchOptions.env;

            const fakeTimeLib = launchOptionsEnv && launchOptionsEnv.LD_PRELOAD;
            const isValidFakeTimeLib =
                fakeTimeLib && fs.existsSync(fakeTimeLib) && fs.statSync(fakeTimeLib).isFile();

            const fakeTimeFile = launchOptionsEnv && launchOptionsEnv.FAKETIME_TIMESTAMP_FILE;
            if (fakeTimeFile) {
                await writeAndSync(fakeTimeFile, '+0');
            }

            const browser = await playwright[browserName].launch();
            await use(
                Object.assign(browser, {
                    fakeTimeFile,
                    isValidFakeTimeLib,
                })
            );
            await browser.close();

            if (fakeTimeFile) {
                fs.rmSync(fakeTimeFile, { force: true });
            }
        },
        { scope: 'worker' },
    ],
});

// Re-export built-in expect
export { expect } from '@playwright/test';
