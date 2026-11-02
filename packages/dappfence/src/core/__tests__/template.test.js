import { describe, expect, it } from 'vitest';
import securityWarningHtml from '../../templates/pages/security-warning.html?template';
import securityWarningCss from '../../templates/styles/pages/security-warning.css?inline';
import emergencyPanelHtml from '../../templates/pages/emergency-panel.html?template';
import emergencyPanelCss from '../../templates/styles/pages/emergency-panel.css?inline';
import {
    MESSAGE_MARKER_PATTERN,
    STYLES_MARKER,
    escapeHtml,
    renderMessages,
    renderTemplate,
} from '../template.js';
import { MESSAGE_KEYS, resolveMessages } from '../../messages/index.js';

const PAGES = {
    'security-warning': [securityWarningHtml, securityWarningCss],
    'emergency-panel': [emergencyPanelHtml, emergencyPanelCss],
};

describe.each(Object.entries(PAGES))('%s template', (_name, [html, css]) => {
    it('has every include expanded', () => {
        expect(html).not.toMatch(/@include/);
        // Only runtime text markers survive the build.
        expect(html.replace(MESSAGE_MARKER_PATTERN, '')).not.toMatch(/\{\{/);
    });

    it('has text only in {{t:key}} markers that the catalog defines', () => {
        const keys = [...html.matchAll(MESSAGE_MARKER_PATTERN)].map(([, key]) => key);
        expect(keys.length).toBeGreaterThan(0);
        expect(keys.filter((key) => !MESSAGE_KEYS.includes(key))).toEqual([]);
    });

    it('renders every marker with the built-in text', () => {
        const rendered = renderMessages(html, resolveMessages([]));
        expect(rendered).not.toMatch(MESSAGE_MARKER_PATTERN);
    });

    // renderTemplate silently does nothing without the marker, which would
    // ship an unstyled page; pin it here instead of checking at runtime.
    it('contains the styles marker exactly once', () => {
        expect(html.split(STYLES_MARKER)).toHaveLength(2);
    });

    it('bundles its stylesheet with @imports inlined', () => {
        expect(css).not.toMatch(/@import/);
        expect(css).toMatch(/--df-red-600/);
    });

    it('renders with the stylesheet in place of the marker', () => {
        const rendered = renderTemplate(html, css);
        expect(rendered).not.toContain(STYLES_MARKER);
        expect(rendered).toContain(css);
    });
});

describe('renderTemplate', () => {
    it('inserts CSS literally, without String.replace substitution patterns', () => {
        expect(renderTemplate(`<style>${STYLES_MARKER}</style>`, "a::after{content:'$&'}")).toBe(
            "<style>a::after{content:'$&'}</style>"
        );
    });
});

describe('renderMessages', () => {
    it('escapes message text so it can never add markup', () => {
        const html = '<p title="{{t:a}}">{{t:a}}</p>';
        const out = renderMessages(html, { a: `<script>x</script>"'&{{t:a}}` });
        expect(out).toBe(
            '<p title="&lt;script&gt;x&lt;/script&gt;&quot;&#39;&amp;{{t:a}}">' +
                '&lt;script&gt;x&lt;/script&gt;&quot;&#39;&amp;{{t:a}}</p>'
        );
    });

    it('throws on a marker with no message', () => {
        expect(() => renderMessages('{{t:missing}}', {})).toThrow(/missing/);
    });

    it('ignores inherited properties', () => {
        expect(() => renderMessages('{{t:constructor}}', {})).toThrow();
    });
});

describe('escapeHtml', () => {
    it('escapes the five HTML-special characters', () => {
        expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    });
});

describe('security-warning page script', () => {
    // t('key') calls in the inline script must name real keys; a typo would
    // show the raw key to the user.
    it('only uses message keys the catalog defines', () => {
        const keys = [...securityWarningHtml.matchAll(/\bt\(\s*'([\w.]+)'/g)].map(([, k]) => k);
        const ternary = [...securityWarningHtml.matchAll(/'(warning\.[\w.]+)'/g)].map(([, k]) => k);
        expect(keys.length).toBeGreaterThan(0);
        expect([...keys, ...ternary].filter((key) => !MESSAGE_KEYS.includes(key))).toEqual([]);
    });
});

describe('security-warning block templates', () => {
    // The page script clones these by id and fills them by data-slot.
    it.each(['df-tpl-block', 'df-tpl-file', 'df-tpl-info-row', 'df-tpl-chip'])(
        'defines <template id="%s"> and clones it',
        (id) => {
            expect(securityWarningHtml).toContain(`<template id="${id}">`);
            expect(securityWarningHtml).toContain(`cloneTemplate('${id}')`);
        }
    );

    it.each(['title', 'name', 'hash', 'count', 'body', 'label', 'value'])(
        'defines and fills data-slot="%s"',
        (name) => {
            expect(securityWarningHtml).toContain(`data-slot="${name}"`);
            expect(securityWarningHtml).toMatch(new RegExp(`slot\\(\\w+, '${name}'\\)`));
        }
    );
});
