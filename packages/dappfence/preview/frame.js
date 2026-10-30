// Full-page view: replaces this document with the rendered page, so it is a
// top-level document exactly as the service worker would serve it. Vite's
// client keeps running in this window and reloads it after template edits.
//
// With `view=source` it shows the rendered HTML string as text instead, since
// view-source of this URL only shows the empty shell below.
import { readSelection, renderScenario } from './pages.js';

const { pageName, scenario } = readSelection(location.search);
const html = await renderScenario(pageName, scenario);

if (new URLSearchParams(location.search).get('view') === 'source') {
    showSource(html);
} else {
    document.open();
    document.write(html);
    document.close();
}

function showSource(source) {
    document.title = `${pageName} / ${scenario} (HTML)`;
    document.body.style.cssText = 'margin: 0; font: 13px/1.5 ui-monospace, monospace';

    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.style.cssText = 'position: fixed; top: 12px; right: 12px; padding: 4px 12px';
    copy.onclick = async () => {
        await navigator.clipboard.writeText(source);
        copy.textContent = 'Copied';
    };

    const pre = document.createElement('pre');
    pre.style.cssText = 'margin: 0; padding: 16px; white-space: pre-wrap; overflow-wrap: anywhere';
    pre.textContent = source;

    document.body.replaceChildren(copy, pre);
}
