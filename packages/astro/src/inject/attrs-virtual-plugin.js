const VIRTUAL_ID = 'virtual:dappfence/attrs';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

export function dappfenceAttrsPlugin(scriptTag) {
    return {
        name: 'dappfence:attrs-virtual',
        resolveId(id) {
            if (id === VIRTUAL_ID) {
                return RESOLVED_ID;
            }
            return null;
        },
        load(id) {
            if (id === RESOLVED_ID) {
                return `export const scriptTag = ${JSON.stringify(scriptTag)};`;
            }
            return null;
        },
    };
}
