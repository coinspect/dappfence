// Template preview catalog: every page × scenario as a live thumbnail. Clicking
// a thumbnail opens the full page (frame.html). Width and theme live in the URL
// (?width=&theme=), so Vite's reload after a template edit keeps them, and
// every link carries the theme, so the full page opens in the same one.
import { PAGES, THEMES, WIDTHS, readSelection, renderScenario, viewQuery } from './pages.js';

const THUMB_WIDTH = 320;
const THUMB_VIEWPORT_HEIGHT = 900;

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
    const next = { ...readSelection(location.search), ...change };
    const query = viewQuery({ width: next.width, theme: next.theme });
    history.replaceState(null, '', query ? '?' + query : location.pathname);
    renderCatalog(next.width, next.theme);
}

async function renderCatalog(width, theme) {
    const viewport = WIDTHS[width];
    const scale = THUMB_WIDTH / viewport;
    controls.replaceChildren(
        segmented(
            'Thumbnail viewport width',
            Object.entries(WIDTHS).map(([name, px]) => [name, `${name} ${px}`]),
            width,
            (value) => pick({ width: value })
        ),
        segmented(
            'Theme: auto follows this browser; light / dark force it',
            THEMES.map((name) => [name, name]),
            theme,
            (value) => pick({ theme: value })
        ),
        el('span', { className: 'hint', textContent: 'Click a page to open it full size' })
    );

    const section = el('div', { className: 'catalog' });
    const renders = [];
    for (const [pageName, page] of Object.entries(PAGES)) {
        const grid = el('div', { className: 'grid' });
        for (const scenario of Object.keys(page.scenarios)) {
            const fullPage = 'frame.html?' + viewQuery({ page: pageName, scenario, theme });
            // Sandboxed without allow-modals: the pages' scripts still run, but
            // they can't open dialogs (a beforeunload prompt in a thumbnail
            // would otherwise fire whenever this page navigates).
            const frame = el('iframe', { title: `${pageName} / ${scenario}`, tabIndex: -1 });
            frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
            frame.style.width = `${viewport}px`;
            frame.style.height = `${THUMB_VIEWPORT_HEIGHT}px`;
            frame.style.transform = `scale(${scale})`;
            const thumb = el('a', { className: 'thumb', href: fullPage }, [frame]);
            thumb.style.height = `${THUMB_VIEWPORT_HEIGHT * scale}px`;
            grid.append(
                el('div', { className: 'card' }, [
                    thumb,
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
            renders.push(
                renderScenario(pageName, scenario, theme).then((html) => (frame.srcdoc = html))
            );
        }
        section.append(el('h2', { textContent: page.title }), grid);
    }
    app.replaceChildren(section);
    await Promise.all(renders);
}

const initial = readSelection(location.search);
renderCatalog(initial.width, initial.theme);
