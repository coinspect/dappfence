import { describe, expect, it } from 'vitest';
import securityWarningHtml from '../../templates/pages/security-warning.html?template';
import securityWarningCss from '../../templates/styles/pages/security-warning.css?inline';
import emergencyPanelHtml from '../../templates/pages/emergency-panel.html?template';
import emergencyPanelCss from '../../templates/styles/pages/emergency-panel.css?inline';
import { STYLES_MARKER, renderTemplate } from '../template.js';

const PAGES = {
    'security-warning': [securityWarningHtml, securityWarningCss],
    'emergency-panel': [emergencyPanelHtml, emergencyPanelCss],
};

describe.each(Object.entries(PAGES))('%s template', (_name, [html, css]) => {
    it('has every include expanded', () => {
        expect(html).not.toMatch(/@include/);
        expect(html).not.toMatch(/\{\{/);
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
