export interface DappfenceOptions {
    secretKey?: string;
    scriptSrc?: string;
    manifestUrl?: string;
    manifestSignatureType?: string;
    manifestSignatureIdentity?: string;
    mode?: string;
    appSW?: string | null;
    warningUrl?: string | null;
    manifestPath?: string;
    extensions?: string[] | null;
    exclude?: string[];
}

export const ATTRS_ENV_KEY: string;

export function withDappfence(options?: DappfenceOptions): <C extends object>(config?: C) => C;

export function getDappfenceScriptAttrs(
    overrides?: Partial<DappfenceOptions>
): Record<string, string>;
