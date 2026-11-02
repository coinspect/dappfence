/**
 * User-facing text for the security warning page and the emergency panel.
 *
 * Text may only come from two places, both of which an attacker serving the
 * site cannot change:
 *
 *   1. The catalogs below, compiled into dappfence.js (covered by the
 *      reproducible build and the signed release hashes).
 *   2. The `messages` field of an integrity manifest whose signature verified
 *      against the pinned signer (integrator overrides).
 *
 * Never read text from window.DappFenceConfig, data-* attributes or URL
 * params: the page controls those and nothing authenticates them. A warning
 * whose "contact support" line an attacker can rewrite works for the attacker.
 *
 * See docs/templates.md § Text and translations.
 */
import en from './en.json' with { type: 'json' };

/** Built-in catalogs, keyed by lowercase BCP 47 tag. Add a locale by adding its file here. */
export const BUILTIN_CATALOGS = Object.freeze({ en });

/** Every key a catalog or manifest override may define. `en` is the reference catalog. */
export const MESSAGE_KEYS = Object.freeze(Object.keys(en));

const KEY_SET = new Set(MESSAGE_KEYS);

export const MAX_MESSAGE_LENGTH = 500;

const LOCALE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

const FALLBACK_LOCALE = 'en';

const normalizeLocale = (tag) => (typeof tag === 'string' ? tag.toLowerCase() : '');

/**
 * Validate a `{ [locale]: { [key]: string } }` overrides object, as found in a
 * manifest's `messages` field. Keeps only well-formed locales, known keys and
 * plain-string values up to MAX_MESSAGE_LENGTH; everything else is reported
 * in `errors`. The returned maps have no prototype, so `__proto__` and friends
 * are inert.
 *
 * The SW drops what fails and logs it; manifest-tools fails the build instead.
 *
 * @param {unknown} raw
 * @returns {{ messages: Record<string, Record<string, string>>, errors: string[] }}
 */
export function validateMessages(raw) {
    const messages = Object.create(null);
    const errors = [];
    if (raw === undefined || raw === null) {
        return { messages, errors };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push('messages must be an object keyed by locale');
        return { messages, errors };
    }
    for (const [rawLocale, entries] of Object.entries(raw)) {
        const locale = normalizeLocale(rawLocale);
        if (!LOCALE_PATTERN.test(locale)) {
            errors.push(`invalid locale tag "${rawLocale}"`);
            continue;
        }
        if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
            errors.push(`${rawLocale}: expected an object of key → text`);
            continue;
        }
        const catalog = Object.create(null);
        for (const [key, value] of Object.entries(entries)) {
            if (!KEY_SET.has(key)) {
                errors.push(`${rawLocale}: unknown message key "${key}"`);
            } else if (typeof value !== 'string') {
                errors.push(`${rawLocale}.${key}: value must be a string`);
            } else if (value.length > MAX_MESSAGE_LENGTH) {
                errors.push(`${rawLocale}.${key}: longer than ${MAX_MESSAGE_LENGTH} characters`);
            } else {
                catalog[key] = value;
            }
        }
        messages[locale] = Object.assign(messages[locale] ?? Object.create(null), catalog);
    }
    return { messages, errors };
}

/**
 * Locales to try, most preferred first: each requested tag, then its base
 * language, then English. `['es-AR', 'pt']` → `['es-ar', 'es', 'pt', 'en']`.
 *
 * @param {readonly string[]} languages - e.g. navigator.languages
 */
export function candidateLocales(languages) {
    const out = [];
    const add = (tag) => {
        if (LOCALE_PATTERN.test(tag) && !out.includes(tag)) {
            out.push(tag);
        }
    };
    for (const raw of languages ?? []) {
        const tag = normalizeLocale(raw);
        add(tag);
        add(tag.split('-')[0]);
    }
    add(FALLBACK_LOCALE);
    return out;
}

/**
 * Resolve every key to one string. For each candidate locale (see
 * candidateLocales) a verified override wins over the built-in text; the first
 * locale that has the key wins, and built-in English always has it.
 *
 * `languages` only chooses among trusted catalogs, so it's fine for it to
 * come from navigator.languages.
 *
 * @param {readonly string[]} languages
 * @param {Record<string, Record<string, string>>} [overrides] - output of validateMessages
 * @returns {Readonly<Record<string, string>>}
 */
export function resolveMessages(languages, overrides = {}) {
    const sources = [];
    for (const locale of candidateLocales(languages)) {
        if (Object.hasOwn(overrides, locale)) {
            sources.push(overrides[locale]);
        }
        if (Object.hasOwn(BUILTIN_CATALOGS, locale)) {
            sources.push(BUILTIN_CATALOGS[locale]);
        }
    }
    const resolved = Object.create(null);
    for (const key of MESSAGE_KEYS) {
        const source = sources.find((catalog) => Object.hasOwn(catalog, key));
        resolved[key] = source[key];
    }
    return Object.freeze(resolved);
}

/**
 * Fill `{name}` placeholders. Unknown placeholders are left as-is.
 *
 * @param {string} text
 * @param {Record<string, string | number>} [params]
 */
export function formatMessage(text, params = {}) {
    return text.replace(/\{(\w+)\}/g, (match, name) =>
        Object.hasOwn(params, name) ? String(params[name]) : match
    );
}
