#!/usr/bin/env node
// Run an npm script sequentially across all workspaces, stopping on first failure.
// Usage: node scripts/run-ws.js <script>
//
// Replaces `npm run --ws` in the root test script. `--ws` always runs all
// workspaces before reporting failures, which buries earlier errors under
// later output. This script exits immediately on the first failing workspace.
import { execSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = process.argv[2];

if (!script) {
    console.error('Usage: node scripts/run-ws.js <script>');
    process.exit(1);
}

const packagesDir = resolve(root, 'packages');
const dirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => resolve(packagesDir, d.name));

for (const dir of dirs) {
    const pkgPath = resolve(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (!pkg.scripts?.[script]) continue;
    try {
        execSync(`npm run ${script} -w ${pkg.name}`, { stdio: 'inherit', cwd: root });
    } catch {
        process.exit(1);
    }
}
