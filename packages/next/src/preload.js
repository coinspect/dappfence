// Preload entry — invoked via `node --import=@dappfence/next/preload`.
// Installs the compile hook before Next's runtime is required so that
// `next build` prerender workers (and dev/start) rewrite the RSC emission
// templates as they load. See ./patch-runtime.js for the mechanics.

import('./patch-runtime.js').then((m) => m.installCompileHook());
