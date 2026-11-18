/**
 * Logger with context detection (Client / SW), console emission + SW-only
 * in-memory buffer for telemetry drain. The buffer is drained by the log stream;
 * on the client it is skipped entirely since nothing consumes it there.
 */
const BUFFER_CAP = 500;
const LEVEL_ORDER = { debug: 0, log: 1, warn: 2, error: 3 };

const isClient = typeof window !== 'undefined';
const context = isClient ? 'DappFence Client' : 'DappFence SW';

let logger = null;
let buffer = [];
let bufferSkipDepth = 0;
let currentMinLevel = 'log';

/** Current wall-clock time as `HH:MM:SS.mmm`. */
function ts() {
    return new Date().toISOString().slice(11, 23);
}

/**
 * Prefix `args` with `[timestamp] [context]` (and `pageId` on the client). If
 * the first arg is a `%c` style string, fold the prefix into it so console
 * styling still applies.
 * @param {...unknown} args
 * @returns {unknown[]}
 */
function formatArgs(...args) {
    const extra = isClient && window.pageId ? [`(${window.pageId})`] : [];
    if (args.length > 0 && typeof args[0] === 'string' && args[0].startsWith('%c')) {
        const [format, color, ...rest] = args;
        return [`%c[${ts()}] [${context}] ${format.slice(2)}`, color, ...extra, ...rest];
    }
    return [`[${ts()}] [${context}]`, ...extra, ...args];
}

/**
 * Resolve the effective level, gate on `currentMinLevel`, emit to console, and
 * (SW realm only) admit to the buffer with dedup + cap. Dedup collapses
 * consecutive identical entries via `count`; `ts` is the first-occurrence
 * timestamp.
 * @param {'debug'|'log'|'warn'|'error'} level
 * @param {unknown[]} args
 */
function emit(level, args) {
    const effective = level === 'log' && bufferSkipDepth > 0 ? 'debug' : level;
    if (LEVEL_ORDER[effective] < LEVEL_ORDER[currentMinLevel]) {
        return;
    }

    console[effective](...formatArgs(...args));
    if (isClient) {
        return;
    }

    const last = buffer[buffer.length - 1];
    if (last && last.level === effective && JSON.stringify(last.args) === JSON.stringify(args)) {
        last.count = (last.count ?? 1) + 1;
        return;
    }
    if (buffer.length >= BUFFER_CAP) {
        buffer.shift();
    }
    buffer.push({ ts: Date.now(), level: effective, args });
}

/**
 * Demote `.log` to `.debug` for the duration of `fn` — used around work on the
 * log-stream flush path so its own log output doesn't feed the same buffer that
 * it's draining. Reentrant via `bufferSkipDepth`.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withDebugLog(fn) {
    bufferSkipDepth++;
    try {
        return await fn();
    } finally {
        bufferSkipDepth = Math.max(0, bufferSkipDepth - 1);
    }
}

/**
 * Raise/lower the floor for both console and buffer admission. Takes `string`
 * because the caller is typically untrusted config; unknown names are silently
 * ignored.
 * @param {string} level
 */
function setMinLevel(level) {
    if (level in LEVEL_ORDER) {
        currentMinLevel = level;
    }
}

export function createLogger() {
    if (!logger) {
        logger = {
            /** @param {...unknown} args */
            debug: (...args) => emit('debug', args),
            /** @param {...unknown} args */
            log: (...args) => emit('log', args),
            /** @param {...unknown} args */
            warn: (...args) => emit('warn', args),
            /** @param {...unknown} args */
            error: (...args) => emit('error', args),
            withDebugLog,
            setMinLevel,
            formatArgs,
            /**
             * Returns the pending buffer and resets it. Caller takes ownership
             * of the returned array — the next admitted entry starts a fresh
             * buffer.
             * @returns {Array<{ts: number, level: 'debug'|'log'|'warn'|'error', args: unknown[], count?: number}>}
             */
            getPendingLogs: () => {
                const snapshot = buffer;
                buffer = [];
                return snapshot;
            },
        };
    }
    return logger;
}
