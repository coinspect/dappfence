/*
 * CDP-less chrome harness + Playwright fixture.
 *
 * Spawns a SECOND Chrome subprocess (bypassing Playwright entirely) and drives
 * it via raw CDP without ever calling Target.setAutoAttach. Because that chrome
 * has no CDP debugger attached to its SW target, Chromium's
 * StopIfNotAttachedToDevTools() inhibition does NOT fire, and the SW
 * idle-terminates after ~30s the way it would in a real user's browser.
 *
 * Target.setDiscoverTargets gives us targetCreated / targetDestroyed lifecycle
 * events for ALL targets without ever attaching a debugger to any of them —
 * that's how we observe SW cold-restart without triggering the inhibition.
 *
 * The LD_PRELOAD + FAKETIME_* env vars from Playwright's launchOptions
 * (configured in playwright.config.ts for the fake-time-* project) are
 * forwarded into the spawned chrome so libfaketime takes effect there too.
 */
import { spawn, ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { SWHelper, test as baseTest } from '../sw-fixtures';

const CDP_PORT_BASE = 9333;

/**
 * Timeouts for the CDP-less probe, sized for the fake-time project — libfaketime
 * intercepts every clock syscall, so chrome startup, SW install/activate, and
 * target lifecycle events all run multiples slower than bare-metal.
 */
const TIMEOUTS = {
    cdpEndpointReady: 240_000,
    pollInterval: 1000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `fn` until it returns a truthy value or the timeout elapses.
 * Uses performance.now() (CLOCK_MONOTONIC) not Date.now() so this poll loop
 * is immune to any libfaketime leak into the Node process and to wall-clock
 * jumps from setFakeTime (FAKETIME_DONT_FAKE_MONOTONIC=1 keeps monotonic real).
 * @param {() => Promise<T>|T} fn
 * @param {number} timeoutMs
 * @param {string} label used in the timeout error
 * @returns {Promise<T>}
 */
async function waitFor<T>(fn: () => Promise<T> | T, timeoutMs: number, label: string): Promise<T> {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
        try {
            const v = await fn();
            if (v) {
                return v;
            }
        } catch {
            /* keep polling */
        }
        await sleep(TIMEOUTS.pollInterval);
    }
    throw new Error(`waitFor timeout: ${label}`);
}

/**
 * Minimal CDP client over a raw WebSocket. Mirrors the small slice of
 * Playwright's CDPSession API we need (send / on / once / close) without
 * attaching via Target.setAutoAttach.
 */
export class CDPSession {
    private nextId = 0;
    private pending = new Map<
        number,
        { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    private events = new Map<string, Array<(params: unknown) => void>>();

    constructor(private ws: WebSocket) {
        ws.addEventListener('message', (ev: MessageEvent) => {
            const msg = JSON.parse(ev.data as string);
            if (msg.id !== undefined) {
                const slot = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (!slot) {
                    return;
                }
                if (msg.error) {
                    slot.reject(new Error(msg.error.message));
                } else {
                    slot.resolve(msg.result);
                }
                return;
            }
            const handlers = this.events.get(msg.method) ?? [];
            for (const h of handlers) {
                h(msg.params);
            }
        });
    }

    send(method: string, params: object = {}): Promise<unknown> {
        const id = ++this.nextId;
        const p = new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        this.ws.send(JSON.stringify({ id, method, params }));
        return p;
    }

    on(method: string, handler: (params: unknown) => void) {
        if (!this.events.has(method)) {
            this.events.set(method, []);
        }
        this.events.get(method)!.push(handler);
    }

    once(method: string): Promise<unknown> {
        return new Promise((resolve) => {
            const handler = (params: unknown) => {
                const handlers = this.events.get(method) ?? [];
                this.events.set(
                    method,
                    handlers.filter((h) => h !== handler)
                );
                resolve(params);
            };
            this.on(method, handler);
        });
    }

    close() {
        try {
            this.ws.close();
        } catch {
            /* ignore */
        }
    }
}

export type SWTargetEvent = { targetId: string; url: string };

export type CdpLessChromeHandle = {
    session: CDPSession;
    swTargetsCreated: SWTargetEvent[];
    swTargetsDestroyed: Set<string>;
    chromeLogs: string[];
    evalExpr: <T = unknown>(expression: string) => Promise<T>;
    waitFor: typeof waitFor;
    sleep: typeof sleep;
    waitForMessage: (substring: string, timeoutMs: number) => Promise<string>;
    cleanup: () => Promise<void>;
};

export type IdleProbeChrome = {
    launch: (log: (m: string) => void) => Promise<CdpLessChromeHandle>;
} & SWHelper;

/**
 * Spawn a chrome subprocess with --remote-debugging-port and return a raw-CDP
 * client bound to its first page target, plus live SW target lifecycle lists.
 * @param {(m: string) => void} log
 * @param {NodeJS.ProcessEnv} extraEnv env overlayed on process.env — carries LD_PRELOAD + FAKETIME_* when run under the fake-time project
 * @param {number} port CDP remote-debugging port — shifted per worker so parallel workers don't clash
 * @returns {Promise<CdpLessChromeHandle>}
 */
async function launchCdpLessChrome(
    log: (m: string) => void,
    extraEnv: NodeJS.ProcessEnv,
    port: number
): Promise<CdpLessChromeHandle> {
    const chromeBin = chromium.executablePath();
    if (!existsSync(chromeBin)) {
        throw new Error(`chrome binary not found: ${chromeBin}`);
    }

    const userDataDir = mkdtempSync(join(tmpdir(), 'cdp-less-probe-'));

    // Always --enable-logging=stderr so JS console output (SW + page) reaches us;
    // --vmodule is only bumped under CDP_PROBE_VERBOSE since it adds C++ noise.
    const verboseArgs = process.env.CDP_PROBE_VERBOSE
        ? [
              '--v=0',
              '--vmodule=*service_worker*=2,*script_update*=2,*update_checker*=2,*cache_writer*=2',
          ]
        : [];
    const chrome: ChildProcess = spawn(
        chromeBin,
        [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${userDataDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--no-sandbox',
            '--headless',
            '--enable-logging=stderr',
            // Suppress Chromium's background phone-homes (CRX component updates
            // via edgedl.me.gvt1.com, Safe Browsing, CRLSet, …) — Playwright's
            // own chrome has these off by default; without them the probe spams
            // the dev-server with NOT FOUNDs that add noise and timing jitter.
            '--disable-background-networking',
            '--disable-component-update',
            // Mirror Playwright's chromium launch: route everything through the
            // dev-server at 3333, and `<-loopback>` subtracts Chromium's default
            // bypass of loopback so `localhost:${basePort+workerIndex}` goes via
            // proxy instead of direct to an unlistened port.
            '--proxy-server=http://localhost:3333',
            '--proxy-bypass-list=<-loopback>',
            ...verboseArgs,
            'about:blank',
        ],
        {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...extraEnv },
            // Own process group so cleanup can SIGKILL the whole chrome tree
            // (parent + zygote + renderer + GPU + network-service) in one call.
            // Without this, chrome.kill() sends SIGTERM to the parent only and
            // the network-service child briefly outlives it, flushing pending
            // fetches that land in the dev-server state of the NEXT test.
            detached: true,
        }
    );

    const chromeLogs: string[] = [];
    let stderrBuffer = '';
    chrome.stderr?.on('data', (buf: Buffer) => {
        stderrBuffer += buf.toString();
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
            if (line) {
                chromeLogs.push(line);
                if (process.env.CDP_PROBE_VERBOSE) {
                    log(`[chrome] ${line}`);
                }
            }
        }
    });

    const localCleanup = async () => {
        try {
            //chrome.kill();
            process.kill(-chrome.pid!, 'SIGKILL');
        } catch {
            /* already dead */
        }
        // Wait for the kernel to actually reap chrome before returning, so no
        // in-flight socket of a dying process can flush a request into the
        // next test's dev-server state slot. 5s cap in case the process is
        // already gone (then 'exit' never fires on an already-exited handle).
        await new Promise<void>((resolve) => {
            if (chrome.exitCode !== null || chrome.signalCode !== null) {
                resolve();
                return;
            }
            const timeout = setTimeout(resolve, 5000);
            chrome.once('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
        try {
            rmSync(userDataDir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    };

    try {
        await waitFor(
            async () => {
                const r = await fetch(`http://localhost:${port}/json/version`).catch(() => null);
                return r && r.ok;
            },
            TIMEOUTS.cdpEndpointReady,
            'CDP endpoint ready'
        );

        const targets = (await fetch(`http://localhost:${port}/json`).then((r) =>
            r.json()
        )) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const pageTarget = targets.find((t) => t.type === 'page');
        if (!pageTarget) {
            throw new Error('no page target in CDP /json');
        }

        log('connecting CDP to page target (no setAutoAttach)');
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => resolve());
            ws.addEventListener('error', (e) => reject(e as unknown as Error));
        });
        const session = new CDPSession(ws);

        await session.send('Page.enable');
        await session.send('Runtime.enable');

        const swTargetsCreated: SWTargetEvent[] = [];
        const swTargetsDestroyed = new Set<string>();
        session.on('Target.targetCreated', (params) => {
            const t = (params as { targetInfo: { targetId: string; type: string; url: string } })
                .targetInfo;
            if (t.type === 'service_worker' && t.url.includes('/dappfence.js')) {
                swTargetsCreated.push({ targetId: t.targetId, url: t.url });
                log(`SW target created: ${t.targetId.slice(0, 8)}…`);
            }
        });
        session.on('Target.targetDestroyed', (params) => {
            const targetId = (params as { targetId: string }).targetId;
            if (swTargetsCreated.some((t) => t.targetId === targetId)) {
                swTargetsDestroyed.add(targetId);
                log(`SW target destroyed: ${targetId.slice(0, 8)}…`);
            }
        });
        await session.send('Target.setDiscoverTargets', { discover: true });

        return {
            session,
            swTargetsCreated,
            swTargetsDestroyed,
            chromeLogs,
            evalExpr: async <T>(expression: string): Promise<T> => {
                const r = (await session.send('Runtime.evaluate', {
                    expression,
                    awaitPromise: true,
                    returnByValue: true,
                })) as { exceptionDetails?: object; result: { value: T } };
                if (r.exceptionDetails) {
                    throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails));
                }
                return r.result.value;
            },
            waitFor,
            sleep,
            waitForMessage: async (substring, timeoutMs) =>
                (await waitFor(
                    () => chromeLogs.find((line) => line.includes(substring)),
                    timeoutMs,
                    `chrome log containing "${substring}"`
                ))!,
            cleanup: async () => {
                session.close();
                await localCleanup();
            },
        };
    } catch (e) {
        await localCleanup();
        throw e;
    }
}

export const test = baseTest.extend<{ idleProbeChrome: IdleProbeChrome }>({
    // Declare swHelper as a dep (even though we don't call it) to pin the
    // teardown order: our probe cleanup (SIGKILL + await exit) runs BEFORE
    // swHelper's teardown (DELETE /api/test-clear). Without the explicit dep,
    // Playwright happens to give us that order via outer-extend-first unwinding,
    // but it's an unwritten assumption — one shift and chrome would still be
    // alive when the DELETE fires, leaking late requests into the next test.
    idleProbeChrome: async ({ launchOptions, swHelper }, use, testInfo) => {
        const handles: CdpLessChromeHandle[] = [];
        await use({
            ...swHelper,
            launch: async (log) => {
                const h = await launchCdpLessChrome(
                    log,
                    (launchOptions.env ?? {}) as NodeJS.ProcessEnv,
                    CDP_PORT_BASE + testInfo.workerIndex
                );
                handles.push(h);
                return h;
            },
        });
        for (const h of handles) {
            try {
                await h.cleanup();
            } catch (err) {
                console.error('ERROR DURING CLEANUP', err);
            }
        }
    },
});

export { expect } from '@playwright/test';
