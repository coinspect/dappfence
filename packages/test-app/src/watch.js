#!/usr/bin/env node
/**
 * Watches @dappfence/core dist output, templates, and assets for changes
 * and rebuilds manifests automatically.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEBOUNCE_MS = 1000;
const WATCH_RETRY_MS = 1000;
const dappfenceFiles = new Set(['dappfence.js', 'dappfence.dev.js']);
const watchDirs = [path.resolve(ROOT, 'template'), path.resolve(ROOT, 'assets')];

let debounce = null;
let parentWatcher = null;

function rebuild() {
    try {
        console.log('[watch] change detected, rebuilding manifests...');
        execSync('node src/build.js --quiet', { stdio: 'inherit', cwd: ROOT });
        console.log('[watch] manifests rebuilt');
    } catch (error) {
        console.error('[watch] manifest build failed:', error.toString());
    }
}

function onChange() {
    if (debounce) {
        clearTimeout(debounce);
    }
    debounce = setTimeout(rebuild, DEBOUNCE_MS);
}

function watchDappfence() {
    try {
        const dappfenceDist = path.dirname(require.resolve('@dappfence/core'));

        if (!parentWatcher) {
            parentWatcher = fs.watch(path.dirname(dappfenceDist), (event, filename) => {
                if (filename === 'dist') {
                    console.log('[watch] dappfence dist folder changed, restarting watcher...');
                    watchDappfence();
                }
            });
        }

        const watcher = fs.watch(dappfenceDist, (event, filename) => {
            if (filename && dappfenceFiles.has(filename)) {
                onChange();
            }
        });
        watcher.on('error', (err) => {
            console.error(`[watch] dappfence watcher error: ${err.message}, retrying...`);
            watcher.close();
        });
        console.log(`[watch] watching ${dappfenceDist} (${[...dappfenceFiles].join(', ')})`);
        onChange();
    } catch {
        if (!parentWatcher) {
            console.log(
                `[watch] failed to watch dappfence, retrying in ${WATCH_RETRY_MS / 1000}s...`
            );
        }
        setTimeout(() => watchDappfence(true), WATCH_RETRY_MS);
    }
}

watchDappfence();
for (const dir of watchDirs) {
    console.log(`[watch] watching ${dir}`);
    fs.watch(dir, { recursive: true }, onChange);
}
