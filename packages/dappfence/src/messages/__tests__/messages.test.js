import { describe, expect, it } from 'vitest';
import {
    BUILTIN_CATALOGS,
    MAX_MESSAGE_LENGTH,
    MESSAGE_KEYS,
    candidateLocales,
    formatMessage,
    resolveMessages,
    validateMessages,
} from '../index.js';

describe('built-in catalogs', () => {
    it('English defines every key with non-empty plain text', () => {
        for (const key of MESSAGE_KEYS) {
            expect(typeof BUILTIN_CATALOGS.en[key], key).toBe('string');
            expect(BUILTIN_CATALOGS.en[key].length, key).toBeGreaterThan(0);
            expect(BUILTIN_CATALOGS.en[key], key).not.toMatch(/<[a-z/]/i);
        }
    });

    // A translation may lag English (missing keys fall back), but must never
    // carry a key English doesn't define, nor something manifest overrides
    // couldn't carry either.
    it.each(Object.entries(BUILTIN_CATALOGS))('%s passes the override validation', (locale, c) => {
        expect(validateMessages({ [locale]: c }).errors).toEqual([]);
    });
});

describe('validateMessages', () => {
    it('keeps known keys with string values, lowercasing the locale', () => {
        const { messages, errors } = validateMessages({ 'es-AR': { 'emergency.title': 'Hola' } });
        expect(errors).toEqual([]);
        expect(messages['es-ar']['emergency.title']).toBe('Hola');
    });

    it('treats a missing field as no overrides', () => {
        expect(validateMessages(undefined)).toEqual({ messages: {}, errors: [] });
    });

    it.each([
        ['an array', []],
        ['a string', 'x'],
    ])('rejects messages that are %s', (_what, raw) => {
        expect(validateMessages(raw).errors).toHaveLength(1);
    });

    it('drops unknown keys, non-strings and over-long values', () => {
        const { messages, errors } = validateMessages({
            en: {
                'emergency.title': 'ok',
                'no.such.key': 'x',
                'emergency.intro': 42,
                'emergency.contact': 'x'.repeat(MAX_MESSAGE_LENGTH + 1),
            },
        });
        expect(Object.keys(messages.en)).toEqual(['emergency.title']);
        expect(errors).toHaveLength(3);
    });

    it.each(['english', 'e', 'en_US', '../en', '__proto__', 'en-'])(
        'rejects locale tag %j',
        (tag) => {
            const { messages, errors } = validateMessages({ [tag]: { 'emergency.title': 'x' } });
            expect(Object.keys(messages)).toEqual([]);
            expect(errors).toHaveLength(1);
        }
    );

    it('cannot pollute prototypes through a __proto__ key', () => {
        const raw = JSON.parse('{"en": {"__proto__": {"polluted": 1}}}');
        const { messages } = validateMessages(raw);
        expect(Object.getPrototypeOf(messages.en)).toBeNull();
        expect({}.polluted).toBeUndefined();
    });
});

describe('candidateLocales', () => {
    it('adds base languages and ends with English', () => {
        expect(candidateLocales(['es-AR', 'pt'])).toEqual(['es-ar', 'es', 'pt', 'en']);
    });

    it('skips malformed tags', () => {
        expect(candidateLocales(['', '*', 'EN-gb'])).toEqual(['en-gb', 'en']);
    });
});

describe('resolveMessages', () => {
    const contact = 'emergency.contact';

    it('defaults every key to English', () => {
        const messages = resolveMessages([]);
        expect(Object.keys(messages)).toEqual([...MESSAGE_KEYS]);
        expect(messages[contact]).toBe(BUILTIN_CATALOGS.en[contact]);
        expect(Object.isFrozen(messages)).toBe(true);
    });

    it('prefers an override for the exact locale, then its base language', () => {
        const overrides = validateMessages({
            es: { [contact]: 'base' },
            'es-ar': { [contact]: 'exact' },
        }).messages;
        expect(resolveMessages(['es-AR'], overrides)[contact]).toBe('exact');
        expect(resolveMessages(['es-MX'], overrides)[contact]).toBe('base');
    });

    it('falls back to English for keys an override locale lacks', () => {
        const overrides = validateMessages({ es: { [contact]: 'Contacto' } }).messages;
        const messages = resolveMessages(['es'], overrides);
        expect(messages[contact]).toBe('Contacto');
        expect(messages['emergency.title']).toBe(BUILTIN_CATALOGS.en['emergency.title']);
    });

    it('applies English overrides for viewers whose language has no text', () => {
        const overrides = validateMessages({ en: { [contact]: 'Mail us' } }).messages;
        expect(resolveMessages(['ja'], overrides)[contact]).toBe('Mail us');
    });
});

describe('formatMessage', () => {
    it('fills known placeholders and leaves others', () => {
        expect(formatMessage('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    });

    it('does not read inherited properties', () => {
        expect(formatMessage('{constructor}', {})).toBe('{constructor}');
    });
});
