// Rewrites Next.js's compiled RSC emission templates at load time so the
// per-request inline scripts (`<script>self.__next_f.push(...)</script>`)
// become inert `<script type="application/json" data-nfp>` payloads plus a
// single static reader/init script. That makes the flight machinery
// hash-stable at build time.

const RUNTIME_PATH_RE =
    /\/next\/dist\/compiled\/next-server\/app-page[a-z-]*\.runtime\.(prod|dev)\.js$/;

const READER_INIT_MINIFIED = `(()=>{self.__next_f=self.__next_f||[];const S='script[type="application/json"][data-nfp]:not([data-dfp])';const p=n=>{if(n.dataset.dfp)return;n.dataset.dfp='1';self.__next_f.push(JSON.parse(n.textContent))};const s=r=>{if(r.matches?.(S))p(r);r.querySelectorAll?.(S).forEach(p)};s(document);new MutationObserver(m=>{for(const x of m)for(const n of x.addedNodes)if(n.nodeType===1)s(n)}).observe(document,{subtree:true,childList:true})})();`;

// Templates observed in Next 15.5.18 (identifier names are single chars in
// prod, full names in dev — anchor on the RSC-protocol strings, not names):
//   1. `${VAR}(self.__next_f=self.__next_f||[]).push(${E1});self.__next_f.push(${E2})</script>`
//   2. `${VAR}(self.__next_f=self.__next_f||[]).push(${E})</script>`
//   3. `${VAR}self.__next_f.push(${E})</script>`
// Order matters: (1) must run before (2) and (3), otherwise (3) rewrites
// the tail of (1)'s payload before (1) can capture it whole.
const IDENT = '[a-zA-Z_$][a-zA-Z_$0-9]*';
const EXPR = '[^}]+';
const BOOTSTRAP_COMBINED_RE = new RegExp(
    '`\\$\\{' +
        IDENT +
        '\\}\\(self\\.__next_f=self\\.__next_f\\|\\|\\[\\]\\)\\.push\\(\\$\\{(' +
        EXPR +
        ')\\}\\);self\\.__next_f\\.push\\(\\$\\{(' +
        EXPR +
        ')\\}\\)</script>`',
    'g'
);
const BOOTSTRAP_ONLY_RE = new RegExp(
    '`\\$\\{' +
        IDENT +
        '\\}\\(self\\.__next_f=self\\.__next_f\\|\\|\\[\\]\\)\\.push\\(\\$\\{(' +
        EXPR +
        ')\\}\\)</script>`',
    'g'
);
const CHUNK_RE = new RegExp(
    '`\\$\\{' + IDENT + '\\}self\\.__next_f\\.push\\(\\$\\{(' + EXPR + ')\\}\\)</script>`',
    'g'
);

const READER_TAG = '<script>' + READER_INIT_MINIFIED + '</script>';
const JSON_TAG_OPEN = '<script type="application/json" data-nfp>';
const JSON_TAG_CLOSE = '</script>';

export function rewriteSource(source) {
    if (source.includes('data-nfp')) {
        return source;
    }
    let out = source;
    out = out.replace(
        BOOTSTRAP_COMBINED_RE,
        '`' +
            READER_TAG +
            JSON_TAG_OPEN +
            '${$1}' +
            JSON_TAG_CLOSE +
            JSON_TAG_OPEN +
            '${$2}' +
            JSON_TAG_CLOSE +
            '`'
    );
    out = out.replace(
        BOOTSTRAP_ONLY_RE,
        '`' + READER_TAG + JSON_TAG_OPEN + '${$1}' + JSON_TAG_CLOSE + '`'
    );
    out = out.replace(CHUNK_RE, '`' + JSON_TAG_OPEN + '${$1}' + JSON_TAG_CLOSE + '`');
    return out;
}

export async function installCompileHook() {
    // webpackIgnore keeps the Next.js webpack server-compiler from trying to
    // bundle Node's builtin `module` — Node resolves it natively at runtime.
    const Module = (await import(/* webpackIgnore: true */ 'module')).default;

    if (Module.prototype._compile.__dappfencePatched) {
        return;
    }
    const orig = Module.prototype._compile;

    function patched(content, filename) {
        if (RUNTIME_PATH_RE.test(filename) && process.env.DAPPFENCE_PATCH_RSC !== 'false') {
            content = rewriteSource(content);
        }
        return orig.call(this, content, filename);
    }
    patched.__dappfencePatched = true;
    Module.prototype._compile = patched;
}

export const __internals = {
    RUNTIME_PATH_RE,
    READER_INIT_MINIFIED,
    BOOTSTRAP_COMBINED_RE,
    BOOTSTRAP_ONLY_RE,
    CHUNK_RE,
};
