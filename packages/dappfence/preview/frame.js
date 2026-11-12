// Full-page view: replaces this document with the rendered page, so it is a
// top-level document exactly as the service worker would serve it. Vite's
// client keeps running in this window and reloads it after template edits.
//
// With `view=source` it shows the rendered HTML string as text instead, since
// view-source of this URL only shows the empty shell (markup in frame.html).
import { readSelection, renderScenario } from './pages.js';

const { pageName, scenario, theme } = readSelection(location.search);
const html = await renderScenario(pageName, scenario, theme);

if (new URLSearchParams(location.search).get('view') === 'source') {
    showSource(html);
} else {
    document.open();
    document.write(html);
    document.close();
}

function showSource(source) {
    document.title = `${pageName} / ${scenario} (HTML)`;
    const view = document.getElementById('source-view').content.firstElementChild.cloneNode(true);
    const copy = view.querySelector('[data-slot="copy"]');
    copy.onclick = async () => {
        await navigator.clipboard.writeText(source);
        copy.textContent = 'Copied';
    };
    view.querySelector('[data-slot="code"]').textContent = source;
    document.body.replaceChildren(view);
}
