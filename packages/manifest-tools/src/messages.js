/**
 * Integrator text overrides for the DappFence warning page and emergency
 * panel.
 *
 * Overrides live in plain JSON files, one per locale (`es.json`, `pt-BR.json`,
 * …), each a flat object of message key → text. They are merged into the
 * manifest payload *before* signing, so the SW only shows them once the
 * signature verifies — the same protection the file hashes get. Valid keys and
 * the English defaults are in @dappfence/core's src/messages/en.json.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateMessages } from '@dappfence/core/messages';
import { resolveContained } from './manifest.js';

/**
 * Validate an overrides object, throwing on anything the SW would drop. A
 * typo'd key must fail the build, not silently fall back to English.
 *
 * @param {unknown} raw - `{ [locale]: { [key]: string } }`
 * @returns {Record<string, Record<string, string>>}
 */
export function assertValidMessages(raw) {
    const { messages, errors } = validateMessages(raw);
    if (errors.length > 0) {
        throw new Error(`DappFence: invalid messages:\n  - ${errors.join('\n  - ')}`);
    }
    // Plain objects (validateMessages returns prototype-less ones) so the
    // payload serializes and signs like every other manifest field.
    return JSON.parse(JSON.stringify(messages));
}

/**
 * Read every `<locale>.json` in `dir` into a validated overrides object.
 *
 * @param {string} root - project root `dir` must stay inside
 * @param {string} dir - messages directory, relative to root
 * @returns {Promise<Record<string, Record<string, string>>>}
 */
export async function loadMessages(root, dir) {
    const absDir = await resolveContained(root, dir, 'messages');
    let entries;
    try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
        throw new Error(`DappFence: cannot read messages directory "${dir}": ${err.message}`);
    }
    const raw = {};
    for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name) !== '.json') {
            continue;
        }
        const locale = path.basename(entry.name, '.json');
        const file = path.join(absDir, entry.name);
        try {
            raw[locale] = JSON.parse(await fs.readFile(file, 'utf8'));
        } catch (err) {
            throw new Error(
                `DappFence: cannot parse ${path.join(dir, entry.name)}: ${err.message}`
            );
        }
    }
    return assertValidMessages(raw);
}
