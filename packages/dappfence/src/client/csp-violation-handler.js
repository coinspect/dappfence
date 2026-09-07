import { createLogger } from '../core/logger.js';

const logger = createLogger();

// WeakMap: script element → bare base64 SHA-256 hash of its textContent (null for empty scripts)
const processedScripts = new WeakMap();
// WeakMap: element → Set<attrName> of on* attributes already processed
const processedAttrs = new WeakMap();

async function computeHash(text) {
    const data = new TextEncoder().encode(text);
    const buffer = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

async function scanInlineScripts() {
    for (const script of document.querySelectorAll('script:not([src])')) {
        if (processedScripts.has(script)) {
            continue;
        }
        const content = script.textContent.trim();
        if (!content) {
            processedScripts.set(script, null);
            continue;
        }
        const hash = await computeHash(content);
        processedScripts.set(script, hash);
        // TODO: compare hash against allowed set; RSC validation; generate violation
        logger.log('[CSP] unrecognised inline script', { hash, sample: content.slice(0, 64) });
    }
}

async function scanEventHandlerAttributes() {
    for (const el of document.querySelectorAll('*')) {
        for (const attr of el.attributes) {
            if (!attr.name.startsWith('on')) {
                continue;
            }
            let seen = processedAttrs.get(el);
            if (seen?.has(attr.name)) {
                continue;
            }
            if (!seen) {
                seen = new Set();
                processedAttrs.set(el, seen);
            }
            seen.add(attr.name);
            const hash = await computeHash(attr.value);
            // TODO: compare hash against allowed set; generate violation
            logger.log('[CSP] unrecognised event handler attribute', {
                tag: el.tagName,
                attr: attr.name,
                hash,
            });
        }
    }
}

export function setupCspViolationListener() {
    document.addEventListener('securitypolicyviolation', async (e) => {
        logger.warn('[CSP] violation', {
            blockedURI: e.blockedURI,
            violatedDirective: e.violatedDirective,
            effectiveDirective: e.effectiveDirective,
            documentURI: e.documentURI,
            lineNumber: e.lineNumber,
            columnNumber: e.columnNumber,
            sample: e.sample,
        });
        await scanInlineScripts();
        await scanEventHandlerAttributes();
    });
    logger.log('CSP violation listener installed');
}
