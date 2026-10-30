// Template preview catalog: every page × scenario as a live thumbnail. Clicking
// a thumbnail opens the full page (frame.html). The width lives in the URL
// (?width=), so Vite's reload after a template edit keeps it.
import { PAGES, WIDTHS, readSelection, renderScenario } from './pages.js';

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

function widthToggle(current, onPick) {
    return el(
        'div',
        { className: 'segmented', title: 'Thumbnail viewport width' },
        Object.entries(WIDTHS).map(([name, px]) =>
            el('button', {
                textContent: `${name} ${px}`,
                ariaPressed: String(name === current),
                onclick: () => onPick(name),
            })
        )
    );
}

function pickWidth(width) {
    // Re-render in place instead of navigating, so nothing unloads.
    history.replaceState(null, '', '?' + new URLSearchParams({ width }));
    renderCatalog(width);
}

async function renderCatalog(width) {
    const viewport = WIDTHS[width];
    const scale = THUMB_WIDTH / viewport;
    controls.replaceChildren(
        widthToggle(width, pickWidth),
        el('span', { className: 'hint', textContent: 'Click a page to open it full size' })
    );

    const section = el('div', { className: 'catalog' });
    const renders = [];
    for (const [pageName, page] of Object.entries(PAGES)) {
        const grid = el('div', { className: 'grid' });
        for (const scenario of Object.keys(page.scenarios)) {
            const fullPage = 'frame.html?' + new URLSearchParams({ page: pageName, scenario });
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
            renders.push(renderScenario(pageName, scenario).then((html) => (frame.srcdoc = html)));
        }
        section.append(el('h2', { textContent: page.title }), grid);
    }
    app.replaceChildren(section);
    await Promise.all(renders);
}

renderCatalog(readSelection(location.search).width);
