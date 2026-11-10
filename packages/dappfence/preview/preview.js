// Template preview catalog: every page × scenario as a live thumbnail. Clicking
// a thumbnail opens the full page (frame.html). Width and theme live in the URL
// (?width=&theme=), so Vite's reload after a template edit keeps them, and
// every link carries the theme, so the full page opens in the same one.
import { PAGES, THEMES, WIDTHS, readSelection, renderScenario, viewQuery } from './pages.js';

const THUMB_WIDTH = 320;
// In `both` mode a card holds a light and a dark thumbnail side by side.
const PAIR_THUMB_WIDTH = 240;
const THUMB_VIEWPORT_HEIGHT = 900;

// The catalog adds `both` to the page themes: every scenario in light and dark.
const CATALOG_THEMES = [...THEMES, 'both'];
const PAIR_THEMES = ['light', 'dark'];

/** Width and theme for the catalog, which (unlike the full page) accepts `both`. */
function catalogSelection(search) {
    const { width, theme } = readSelection(search);
    const both = new URLSearchParams(search).get('theme') === 'both';
    return { width, theme: both ? 'both' : theme };
}

const app = document.getElementById('app');
const controls = document.getElementById('controls');

function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
}

function scenarioLabel(pageName, scenario) {
    const data = PAGES[pageName].scenarios[scenario];
    if (!Array.isArray(data)) {
        return scenario;
    }
    return `${scenario} (${data.length} block${data.length === 1 ? '' : 's'})`;
}

function segmented(title, options, current, onPick) {
    return el(
        'div',
        { className: 'segmented', title },
        options.map(([value, label]) =>
            el('button', {
                textContent: label,
                ariaPressed: String(value === current),
                onclick: () => onPick(value),
            })
        )
    );
}

function pick(change) {
    // Re-render in place instead of navigating, so nothing unloads.
    const next = { ...catalogSelection(location.search), ...change };
    const query = viewQuery({ width: next.width, theme: next.theme });
    history.replaceState(null, '', query ? '?' + query : location.pathname);
    renderCatalog(next.width, next.theme);
}

/**
 * One live thumbnail: the page rendered in `theme`, scaled down, linking to
 * the full page in that theme. Returns the link and the pending render.
 */
function thumbnail(pageName, scenario, theme, viewport, thumbWidth) {
    const scale = thumbWidth / viewport;
    const href = 'frame.html?' + viewQuery({ page: pageName, scenario, theme });
    // Sandboxed without allow-modals: the pages' scripts still run, but
    // they can't open dialogs (a beforeunload prompt in a thumbnail
    // would otherwise fire whenever this page navigates).
    const frame = el('iframe', { title: `${pageName} / ${scenario} / ${theme}`, tabIndex: -1 });
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.style.width = `${viewport}px`;
    frame.style.height = `${THUMB_VIEWPORT_HEIGHT}px`;
    frame.style.transform = `scale(${scale})`;
    const link = el('a', { className: 'thumb', href, title: `Open in ${theme} theme` }, [frame]);
    link.style.height = `${THUMB_VIEWPORT_HEIGHT * scale}px`;
    const render = renderScenario(pageName, scenario, theme).then((html) => (frame.srcdoc = html));
    return { link, render };
}

function pairOrSingle(links, pair) {
    const box = el('div', { className: pair ? 'thumbs thumbs--pair' : 'thumbs' }, links);
    if (pair) {
        box.style.setProperty('--pair-thumb-width', `${PAIR_THUMB_WIDTH}px`);
    }
    return box;
}

async function renderCatalog(width, theme) {
    const viewport = WIDTHS[width];
    const pair = theme === 'both';
    controls.replaceChildren(
        segmented(
            'Thumbnail viewport width',
            Object.entries(WIDTHS).map(([name, px]) => [name, `${name} ${px}`]),
            width,
            (value) => pick({ width: value })
        ),
        segmented(
            'Theme: auto follows this browser; light / dark force it; both shows each side by side',
            CATALOG_THEMES.map((name) => [name, name]),
            theme,
            (value) => pick({ theme: value })
        ),
        el('span', { className: 'hint', textContent: 'Click a page to open it full size' })
    );

    const section = el('div', { className: 'catalog' });
    const renders = [];
    for (const [pageName, page] of Object.entries(PAGES)) {
        const grid = el('div', { className: pair ? 'grid grid--pair' : 'grid' });
        for (const scenario of Object.keys(page.scenarios)) {
            const thumbs = (pair ? PAIR_THEMES : [theme]).map((t) =>
                thumbnail(pageName, scenario, t, viewport, pair ? PAIR_THUMB_WIDTH : THUMB_WIDTH)
            );
            renders.push(...thumbs.map((t) => t.render));
            // In `both` mode the label links open the page as shipped (auto).
            const fullPage =
                'frame.html?' +
                viewQuery({ page: pageName, scenario, theme: pair ? 'auto' : theme });
            grid.append(
                el('div', { className: 'card' }, [
                    pairOrSingle(
                        thumbs.map((t) => t.link),
                        pair
                    ),
                    el('div', { className: 'card__label' }, [
                        el('a', { href: fullPage, textContent: scenarioLabel(pageName, scenario) }),
                        el('a', {
                            href: fullPage + '&view=source',
                            textContent: 'HTML',
                            title: 'Show the rendered HTML as text',
                        }),
                    ]),
                ])
            );
        }
        section.append(el('h2', { textContent: page.title }), grid);
    }
    app.replaceChildren(section);
    await Promise.all(renders);
}

const initial = catalogSelection(location.search);
renderCatalog(initial.width, initial.theme);
