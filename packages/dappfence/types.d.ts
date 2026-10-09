// Ambient declarations for @dappfence/core.
// Keeps the project zero-dep for type-checking: no @types/node, no @types/<framework>.

// --- Vite build-time defines (packages/dappfence/vite.config.js) ---

declare const __DEV__: boolean;
declare const __FEATURES__: Record<string, boolean> | null | undefined;
declare const __VERSION__: string;
declare const __COMMIT__: string;
declare const __BUILD_DATE__: string;
declare const __NODE_VERSION__: string;

// --- Vite ?raw and virtual-module imports ---

declare module '*.html?raw' {
    const content: string;
    export default content;
}
declare module '*.css?raw' {
    const content: string;
    export default content;
}
declare module 'virtual:dappfence/attrs' {
    const value: unknown;
    export default value;
}

// --- Window / Navigator extensions used by the SW registration + logger ---

interface Window {
    DappFenceConfig?: Record<string, unknown>;
    pageId?: string;
}

interface Navigator {
    __dappfencePatched?: boolean;
}
