import { describe, it, expect } from 'vitest';
import { decodePathname, toPathname, verifyManifestSignature } from '../manifest/verification.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

describe('decodePathname', () => {
    it('decodes safe reserved chars', () => {
        expect(decodePathname('/api/%5Bid%5D')).toBe('/api/[id]');
    });

    it('leaves %2F encoded', () => {
        expect(decodePathname('/api%2Fitem')).toBe('/api%2Fitem');
    });

    it('returns raw pathname on malformed input (lone %)', () => {
        expect(decodePathname('/%')).toBe('/%');
    });
});

describe('toPathname', () => {
    const baseUrl = 'https://example.com/dappfence.js';

    it('returns pathname for same-origin URLs', () => {
        expect(toPathname('https://example.com/app.js', baseUrl)).toBe('/app.js');
    });

    it('returns pathname for relative URLs', () => {
        expect(toPathname('/app.js', baseUrl)).toBe('/app.js');
    });

    it('returns full href for cross-origin URLs', () => {
        expect(toPathname('https://cdn.other.com/lib.js', baseUrl)).toBe(
            'https://cdn.other.com/lib.js'
        );
    });

    it('prepends / for bare relative paths', () => {
        expect(toPathname('app.js', 'not-a-valid-url')).toBe('/app.js');
    });

    it('returns absolute URL as-is on parse failure', () => {
        expect(toPathname('https://cdn.com/lib.js', 'bad-base')).toBe('https://cdn.com/lib.js');
    });

    it('percent-decodes safe reserved chars in pathname (Next dynamic-route keys)', () => {
        expect(toPathname('https://example.com/api/%5Bid%5D', baseUrl)).toBe('/api/[id]');
    });

    it("keeps %2F encoded so segments aren't merged", () => {
        expect(toPathname('https://example.com/api%2Fitem', baseUrl)).toBe('/api%2Fitem');
    });
});

describe('verifyManifestSignature', () => {
    it('returns MANIFEST_UNTRUSTED with UNSUPPORTED_SIGNATURE reason for unknown signature types', () => {
        const result = verifyManifestSignature('unknown-type', '0xABC', { pay: {}, sig: 'sig' });
        expect(result.status).toBe(VERIFICATION_STATUS.MANIFEST_UNTRUSTED);
        expect(result.reason).toBe('UNSUPPORTED_SIGNATURE');
    });
});
