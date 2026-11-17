/**
 * Create a logger scoped to a module name.
 * Context (Client / SW) is detected automatically.
 *
 */
const BUFFER_CAP = 500;

const isClient = typeof window !== 'undefined';
const context = isClient ? 'DappFence Client' : 'DappFence SW';
let logger = null;
let buffer = [];

function ts() {
    return new Date().toISOString().slice(11, 23);
}

function formatArgs(...args) {
    const extra = isClient && window.pageId ? [`(${window.pageId})`] : [];
    if (args.length > 0 && typeof args[0] === 'string' && args[0].startsWith('%c')) {
        const [format, color, ...rest] = args;
        return [`%c[${ts()}] [${context}] ${format.slice(2)}`, color, ...extra, ...rest];
    }
    return [`[${ts()}] [${context}]`, ...extra, ...args];
}

function callSink(level, args) {
    const last = buffer[buffer.length - 1];
    if (last && last[0] === level && JSON.stringify(last[1]) === JSON.stringify(args)) {
        last[2] = (last[2] ?? 1) + 1;
        return;
    }
    if (buffer.length >= BUFFER_CAP) {
        buffer.shift();
    }
    buffer.push([level, args]);
}

export function createLogger() {
    if (!logger) {
        logger = {
            log: (...args) => {
                console.log(...formatArgs(...args));
                callSink('log', args);
            },
            warn: (...args) => {
                console.warn(...formatArgs(...args));
                callSink('warn', args);
            },
            error: (...args) => {
                console.error(...formatArgs(...args));
                callSink('error', args);
            },
            formatArgs,
            getPendingLogs: () => {
                const snapshot = buffer;
                buffer = [];
                return snapshot;
            },
        };
    }
    return logger;
}
