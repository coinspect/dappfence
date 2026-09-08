/* eslint-disable no-undef, no-unused-vars */
// Concatenated as text into astro/dist/runtime/server/render/server-islands.js
// by the Vite plugin in ../index.js. Do not import — the identifiers referenced
// below (SERVER_ISLAND_REPLACER, markHTMLString, encryptString, createThinHead,
// generateCspDigest, renderSlotToString, createSearchParams, isWithinURLLimit,
// internalProps, ServerIslandComponent) exist only inside the target module.

const DF_ISLAND_LISTENER = `(() => {
  const hydrate = async (n) => {
    if (n.dataset.dfDone) return;
    n.dataset.dfDone = '1';
    const { hostId, url, method, headers, body } = JSON.parse(n.textContent);
    const response = await fetch(url, { method, headers, body });
    replaceServerIsland(hostId, response);
  };
  const scan = (r) => r.querySelectorAll && r.querySelectorAll(
    'script[type="application/json"][data-df-island]:not([data-df-done])'
  ).forEach(hydrate);
  scan(document);
  new MutationObserver((ms) => {
    for (const m of ms) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) scan(n);
      }
    }
  }).observe(document, { subtree: true, childList: true });
})();`;

class DfServerIslandComponent extends ServerIslandComponent {
    // Compute the same fetch parameters the parent bakes into its inline script,
    // but return them structured so we can serialise as inert JSON. Duplicates
    // the parent's encryption/URL logic (~25 lines) rather than parsing its
    // output — the /_server-islands/* route contract is enforced upstream, so
    // drift breaks loudly there instead of silently here.
    async getIslandSpec() {
        if (this._dfSpec) {
            return this._dfSpec;
        }
        const componentPath = this.getComponentPath();
        const componentExport = this.getComponentExport();
        const serverIslandNameMap = await this.result.getServerIslandNameMap();
        const componentId = serverIslandNameMap.get(componentPath);
        if (!componentId) {
            throw new Error(`Could not find server component name ${componentPath}`);
        }

        for (const key of Object.keys(this.props)) {
            if (internalProps.has(key)) {
                delete this.props[key];
            }
        }

        const renderedSlots = {};
        for (const name in this.slots) {
            if (name === 'fallback') {
                continue;
            }
            const content = await renderSlotToString(this.result, this.slots[name]);
            let slotHtml = content.toString();
            if (Array.isArray(content.instructions)) {
                for (const instr of content.instructions) {
                    if (instr.type === 'script') {
                        slotHtml += instr.content;
                    }
                }
            }
            renderedSlots[name] = slotHtml;
        }

        const key = await this.result.key;
        const componentExportEncrypted = await encryptString(
            key,
            componentExport,
            `export:${componentId}`
        );
        const propsEncrypted =
            Object.keys(this.props).length === 0
                ? ''
                : await encryptString(key, JSON.stringify(this.props), `props:${componentId}`);
        const slotsEncrypted =
            Object.keys(renderedSlots).length === 0
                ? ''
                : await encryptString(key, JSON.stringify(renderedSlots), `slots:${componentId}`);

        const hostId = await this.getHostId();
        const slash = this.result.base.endsWith('/') ? '' : '/';
        let url = `${this.result.base}${slash}_server-islands/${componentId}${
            this.result.trailingSlash === 'always' ? '/' : ''
        }`;

        const params = createSearchParams(componentExportEncrypted, propsEncrypted, slotsEncrypted);
        const useGET = isWithinURLLimit(url, params);
        const adapterHeaders = this.result.internalFetchHeaders || {};

        let spec;
        if (useGET) {
            url += '?' + params.toString();
            this.result._metadata.extraHead.push(
                markHTMLString(
                    `<link rel="preload" as="fetch" href="${url}" crossorigin="anonymous">`
                )
            );
            spec = { hostId, url, method: 'GET', headers: adapterHeaders };
        } else {
            spec = {
                hostId,
                url,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...adapterHeaders },
                body: JSON.stringify({
                    encryptedComponentExport: componentExportEncrypted,
                    encryptedProps: propsEncrypted,
                    encryptedSlots: slotsEncrypted,
                }),
            };
        }

        this._dfSpec = spec;
        return spec;
    }

    // Called by Astro's head-propagation buffer before <head> is flushed.
    // Precomputes the fetch spec (so getIslandSpec's preload-link push lands in
    // head) and emits the two static scripts + their CSP hashes once per page.
    async init() {
        await this.getIslandSpec();
        const meta = this.result._metadata;
        if (!meta.dfIslandBootEmitted) {
            meta.dfIslandBootEmitted = true;
            meta.extraHead.push(markHTMLString(`<script>${SERVER_ISLAND_REPLACER}</script>`));
            meta.extraHead.push(markHTMLString(`<script>${DF_ISLAND_LISTENER}</script>`));
            if (this.result.cspDestination) {
                meta.extraScriptHashes.push(
                    await generateCspDigest(SERVER_ISLAND_REPLACER, this.result.cspAlgorithm)
                );
                meta.extraScriptHashes.push(
                    await generateCspDigest(DF_ISLAND_LISTENER, this.result.cspAlgorithm)
                );
            }
        }
        return createThinHead();
    }

    async render(destination) {
        const spec = await this.getIslandSpec();
        destination.write('<!--[if astro]>server-island-start<![endif]-->');
        for (const name in this.slots) {
            if (name === 'fallback') {
                await renderChild(destination, this.slots.fallback(this.result));
            }
        }
        // data-island-id is required by Astro's SERVER_ISLAND_REPLACER, which
        // looks up the anchor via `script[data-island-id="${id}"]` to walk
        // previousSiblings and replace the skeleton. data-df-island is our own
        // marker so the listener's selector can't false-positive on any future
        // Astro-emitted <script type="application/json" data-island-id>.
        const json = JSON.stringify(spec).replace(/</g, '\\u003c');
        destination.write(
            `<script type="application/json" data-df-island data-island-id="${spec.hostId}">${json}</script>`
        );
    }
}
