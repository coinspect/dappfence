// Re-exported by the user's `instrumentation.ts`. Fires once per server
// instance before the first request. Runtime-gated to the Node runtime; the
// Edge runtime doesn't emit `__next_f.push` inline scripts and can't monkey
// patch `Module.prototype._compile` anyway.

export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') {
        return;
    }
    if (process.env.DAPPFENCE_PATCH_RSC === 'false') {
        return;
    }
    const { installCompileHook } = await import('./patch-runtime.js');
    await installCompileHook();
}
