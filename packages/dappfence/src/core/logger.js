/**
 * Create a logger scoped to a module name.
 * Context (Client / SW) is detected automatically.
 *
 */
const isClient = typeof window !== 'undefined';
const context = isClient ? 'DappFence Client' : 'DappFence SW';
function formatArgs(...args) {
    const extra = isClient && window.pageId ? [`(${window.pageId})`] : [];
    if (args.length > 0 && typeof args[0] === 'string' && args[0].startsWith('%c')) {
        const [format, color, ...rest] = args;
        return [`%c[${context}] ${format.slice(2)}`, color, ...extra, ...rest];
    }
    return [`[${context}]`, ...extra, ...args];
}

let logger = null;
export function createLogger() {
    if (!logger) {
        logger = {
            log: (...args) => console.log(...formatArgs(...args)),
            warn: (...args) => console.warn(...formatArgs(...args)),
            error: (...args) => console.error(...formatArgs(...args)),
            formatArgs,
        };
    }
    return logger;
}
