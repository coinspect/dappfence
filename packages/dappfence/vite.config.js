import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import obfuscator from 'vite-plugin-bundle-obfuscator';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
    // Build configuration for single file output
    build: {
        // Output to src/ so the existing dev server can serve it
        outDir: resolve(__dirname, 'dist'),

        // Don't clean the src directory (has other files)
        emptyOutDir: false,

        // Library mode for single file output
        lib: {
            entry: resolve(__dirname, 'src/main.js'),
            name: 'DappFence',
            fileName: () => (mode === 'development' ? 'dappfence.dev.js' : 'dappfence.js'),
            formats: ['iife'], // Single IIFE format
        },

        // Rollup options
        rollupOptions: {
            external: [],

            output: {
                // Banner comment
                banner: `/**
 * DappFence Security Framework v${process.env.npm_package_version || '0.1.0'}
 * A unified client/service worker security layer for web applications
 * 
 * ${mode === 'development' ? 'Development build with console logging + sourcemaps' : 'Production build - console logging removed'}
 * Built with Vite from modular source
 */`,

                // Single file output
                inlineDynamicImports: true,
            },
        },

        // Source maps for development only
        sourcemap: mode === 'development',

        // Minification and console removal
        minify: mode === 'production' ? 'terser' : false,

        terserOptions:
            mode === 'production'
                ? {
                      compress: {
                          pure_funcs: mode === 'production' ? ['logger.log', 'logger.warn'] : [],
                          drop_console: false, // we want to log some things even in prod
                          drop_debugger: true,
                      },
                  }
                : undefined,

        // Target modern browsers
        target: 'es2020',
    },

    // Define environment variables
    define: {
        __VERSION__: JSON.stringify(process.env.npm_package_version || '0.1.0'),
        __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
        __DEV__: mode !== 'production',
    },

    // Vite cache (avoid node_modules inside this package)
    cacheDir: resolve(__dirname, '../../node_modules/.vite'),

    // Unit tests (vitest)
    test: {
        root: __dirname,
        include: ['src/**/*.test.js'],
        onConsoleLog: () => false, // Silence production logger output during tests
        coverage: {
            provider: 'v8',
            all: true,
            include: ['src/**/*.js'],
            exclude: ['src/**/*.test.js'],
        },
    },

    // Plugins (none needed - using built-in ?raw imports)
    plugins: [
        {
            name: 'watch-feature-flags',
            buildStart() {
                this.addWatchFile(resolve(__dirname, 'feature_flag.json'));
            },
            renderChunk(code) {
                if (!code.includes('__FEATURES__')) return null;
                const flags = JSON.parse(
                    readFileSync(resolve(__dirname, 'feature_flag.json'), 'utf-8')
                );
                return {
                    code: code.replace(/__FEATURES__/g, JSON.stringify(flags[mode])),
                    map: null,
                };
            },
        },
        obfuscator({
            // Options for javascript-obfuscator
            enable: mode === 'production',
            compact: true,
            controlFlowFlattening: true,
            deadCodeInjection: true,
            debugProtection: true,
            splitStrings: true,
            identifierNamesGenerator: 'mangled-shuffled',
        }),
    ],
}));
