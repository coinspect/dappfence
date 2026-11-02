import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { generateManifest } from '../manifest.js';
import { verifyManifest } from '../build.js';
import { assertValidMessages, loadMessages } from '../messages.js';

const LOGGER = { info: () => {}, warn: () => {}, error: () => {} };
// Throwaway key used only by tests.
const SECRET_KEY = '0x' + '11'.repeat(32);

let tmpDirs = [];
async function tmp() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-messages-test-'));
    tmpDirs.push(dir);
    return dir;
}

async function writeLocale(dir, locale, content) {
    await fs.mkdir(path.join(dir, 'messages'), { recursive: true });
    const body = typeof content === 'string' ? content : JSON.stringify(content);
    await fs.writeFile(path.join(dir, 'messages', `${locale}.json`), body, 'utf8');
}

afterEach(async () => {
    for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
    tmpDirs = [];
});

describe('loadMessages', () => {
    it('reads one <locale>.json per locale', async () => {
        const root = await tmp();
        await writeLocale(root, 'es', { 'emergency.contact': 'Escribinos' });
        await writeLocale(root, 'pt-BR', { 'emergency.title': 'Ação necessária' });
        await fs.writeFile(path.join(root, 'messages', 'README.md'), 'ignored', 'utf8');

        expect(await loadMessages(root, 'messages')).toEqual({
            es: { 'emergency.contact': 'Escribinos' },
            'pt-br': { 'emergency.title': 'Ação necessária' },
        });
    });

    it('fails on an unknown key, naming it', async () => {
        const root = await tmp();
        await writeLocale(root, 'es', { 'emergency.contcat': 'typo' });
        await expect(loadMessages(root, 'messages')).rejects.toThrow(/emergency\.contcat/);
    });

    it('fails on invalid JSON, naming the file', async () => {
        const root = await tmp();
        await writeLocale(root, 'es', '{ nope');
        await expect(loadMessages(root, 'messages')).rejects.toThrow(/es\.json/);
    });

    it('refuses a directory outside the project', async () => {
        const root = await tmp();
        await expect(loadMessages(root, '../elsewhere')).rejects.toThrow(/outside/);
    });
});

describe('assertValidMessages', () => {
    it.each([
        [{ en: { 'emergency.title': 42 } }, /must be a string/],
        [{ english: { 'emergency.title': 'x' } }, /invalid locale/],
        [{ en: { 'emergency.title': 'x'.repeat(501) } }, /longer than/],
    ])('rejects %j', (raw, error) => {
        expect(() => assertValidMessages(raw)).toThrow(error);
    });
});

describe('generateManifest — messages', () => {
    async function build(messages) {
        const outDir = await tmp();
        await fs.writeFile(path.join(outDir, 'main.js'), 'x', 'utf8');
        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            secretKey: SECRET_KEY,
            mode: 'protected',
            logger: LOGGER,
            messages,
        });
        return path.join(outDir, 'integrity-manifest.json');
    }

    it('signs the messages as part of the payload', async () => {
        const messages = { es: { 'emergency.contact': 'Escribinos' } };
        const file = await build(messages);
        const manifest = JSON.parse(await fs.readFile(file, 'utf8'));

        expect(manifest.pay.messages).toEqual(messages);
        expect(() => verifyManifest(file)).not.toThrow();
    });

    it('a changed message breaks the signature', async () => {
        const file = await build({ en: { 'emergency.contact': 'support@example.com' } });
        const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
        manifest.pay.messages.en['emergency.contact'] = 'attacker@example.com';
        await fs.writeFile(file, JSON.stringify(manifest), 'utf8');

        expect(() => verifyManifest(file)).toThrow(/mismatch/);
    });

    it('omits the field when there are no messages', async () => {
        const manifest = JSON.parse(await fs.readFile(await build(undefined), 'utf8'));
        expect(manifest.pay).not.toHaveProperty('messages');
    });

    it('fails the build on invalid messages', async () => {
        await expect(build({ en: { 'not.a.key': 'x' } })).rejects.toThrow(/not\.a\.key/);
    });
});
