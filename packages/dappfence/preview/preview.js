// Template preview catalog: every page × scenario as a live thumbnail. Clicking
// a thumbnail opens the full page (frame.html). Width and theme live in the URL
// (?width=&theme=), so Vite's reload after a template edit keeps them, and
// every link carries the theme, so the full page opens in the same one.
//
// The markup lives in index.html as <template> elements; this file only clones
// them and fills their data-slot elements.
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
const widthControl = document.getElementById('width-control');
const themeControl = document.getElementById('theme-control');

/** A fresh copy of the <template id="…"> element's root. */
function fromTemplate(id) {
    return document.getElementById(id).content.firstElementChild.cloneNode(true);
}

/** The element marked data-slot="name" inside a cloned template. */
function slot(node, name) {
    return node.querySelector(`[data-slot="${name}"]`);
}

function scenarioLabel(pageName, scenario) {
    const page = PAGES[pageName];
    const data = page.scenarios[scenario];
    const label = Array.isArray(data)
        ? `${scenario} (${data.length} block${data.length === 1 ? '' : 's'})`
        : scenario;
    if (!page.group) {
        return label;
    }
    // In a shared row the card names its page; a lone `default` adds nothing.
    return Object.keys(page.scenarios).length === 1 ? page.title : `${page.title} · ${label}`;
}

/**
 * The catalog's rows: consecutive pages with the same `group` share one
 * section titled by the group; any other page gets its own.
 * @returns {{ title: string, pageNames: string[] }[]}
 */
function catalogRows() {
    const rows = [];
    for (const [pageName, page] of Object.entries(PAGES)) {
        const last = rows[rows.length - 1];
        if (page.group && last?.group === page.group) {
            last.pageNames.push(pageName);
        } else {
            rows.push({
                title: page.group ?? page.title,
                group: page.group,
                pageNames: [pageName],
            });
        }
    }
    return rows;
}

/** Fill a segmented control with one button per [value, label] option. */
function fillSegmented(control, options, current, onPick) {
    control.replaceChildren(
        ...options.map(([value, label]) => {
            const button = fromTemplate('segment-button');
            button.textContent = label;
            button.ariaPressed = String(value === current);
            button.onclick = () => onPick(value);
            return button;
        })
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
    const link = fromTemplate('thumbnail');
    link.href = 'frame.html?' + viewQuery({ page: pageName, scenario, theme });
    link.title = `Open in ${theme} theme`;
    link.style.height = `${THUMB_VIEWPORT_HEIGHT * scale}px`;

    const frame = link.querySelector('iframe');
    frame.title = `${pageName} / ${scenario} / ${theme}`;
    frame.style.width = `${viewport}px`;
    frame.style.height = `${THUMB_VIEWPORT_HEIGHT}px`;
    frame.style.transform = `scale(${scale})`;

    const render = renderScenario(pageName, scenario, theme).then((html) => (frame.srcdoc = html));
    return { link, render };
}

/** One scenario card: its thumbnail(s) plus links to the full page and its HTML. */
function scenarioCard(pageName, scenario, theme, viewport, renders) {
    const pair = theme === 'both';
    const card = fromTemplate('scenario-card');

    const thumbs = (pair ? PAIR_THEMES : [theme]).map((t) =>
        thumbnail(pageName, scenario, t, viewport, pair ? PAIR_THUMB_WIDTH : THUMB_WIDTH)
    );
    renders.push(...thumbs.map((t) => t.render));
    const box = slot(card, 'thumbs');
    box.append(...thumbs.map((t) => t.link));
    if (pair) {
        box.classList.add('thumbs--pair');
        box.style.setProperty('--pair-thumb-width', `${PAIR_THUMB_WIDTH}px`);
    }

    // In `both` mode the label links open the page as shipped (auto).
    const fullPage =
        'frame.html?' + viewQuery({ page: pageName, scenario, theme: pair ? 'auto' : theme });
    const open = slot(card, 'open');
    open.href = fullPage;
    open.textContent = scenarioLabel(pageName, scenario);
    slot(card, 'source').href = fullPage + '&view=source';

    return card;
}

async function renderCatalog(width, theme) {
    const viewport = WIDTHS[width];
    fillSegmented(
        widthControl,
        Object.entries(WIDTHS).map(([name, px]) => [name, `${name} ${px}`]),
        width,
        (value) => pick({ width: value })
    );
    fillSegmented(
        themeControl,
        CATALOG_THEMES.map((name) => [name, name]),
        theme,
        (value) => pick({ theme: value })
    );

    const renders = [];
    const sections = catalogRows().map((row) => {
        const section = fromTemplate('page-section');
        slot(section, 'title').textContent = row.title;
        const grid = slot(section, 'cards');
        grid.classList.toggle('grid--pair', theme === 'both');
        grid.append(
            ...row.pageNames.flatMap((pageName) =>
                Object.keys(PAGES[pageName].scenarios).map((scenario) =>
                    scenarioCard(pageName, scenario, theme, viewport, renders)
                )
            )
        );
        return section;
    });
    app.replaceChildren(...sections);
    await Promise.all(renders);
}

const initial = catalogSelection(location.search);
renderCatalog(initial.width, initial.theme);
