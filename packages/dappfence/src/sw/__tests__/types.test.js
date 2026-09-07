import { describe, it, expect } from 'vitest';
import { VERIFICATION_STATUS } from '../../core/constants.js';

describe('VERIFICATION_STATUS', () => {
    it('exposes a description and isViolation flag for each verdict', () => {
        expect(VERIFICATION_STATUS.MATCH.description).toBe('MATCH');
        expect(VERIFICATION_STATUS.MATCH.isViolation).toBe(false);
        expect(VERIFICATION_STATUS.SKIPPED.isViolation).toBe(false);
        expect(VERIFICATION_STATUS.REWRITE.description).toBe('REWRITE');
        expect(VERIFICATION_STATUS.REWRITE.isViolation).toBe(false);
        expect(VERIFICATION_STATUS.MISMATCH.isViolation).toBe(true);
        expect(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST.isViolation).toBe(true);
        expect(VERIFICATION_STATUS.DENIED_BY_RULE.description).toBe('DENIED_BY_RULE');
        expect(VERIFICATION_STATUS.DENIED_BY_RULE.isViolation).toBe(true);
        expect(VERIFICATION_STATUS.ERROR.description).toBe('ERROR');
        expect(VERIFICATION_STATUS.ERROR.isViolation).toBe(true);
        expect(VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE.isViolation).toBe(true);
        expect(VERIFICATION_STATUS.CONFIG_ERROR.isViolation).toBe(true);
    });

    it('all violation statuses have isViolation=true', () => {
        const violations = [
            VERIFICATION_STATUS.MISMATCH,
            VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST,
            VERIFICATION_STATUS.DENIED_BY_RULE,
            VERIFICATION_STATUS.ERROR,
            VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE,
            VERIFICATION_STATUS.CONFIG_ERROR,
        ];
        for (const s of violations) {
            expect(s.isViolation).toBe(true);
        }
    });

    it('non-violation statuses have isViolation=false', () => {
        const nonViolations = [
            VERIFICATION_STATUS.MATCH,
            VERIFICATION_STATUS.SKIPPED,
            VERIFICATION_STATUS.REWRITE,
        ];
        for (const s of nonViolations) {
            expect(s.isViolation).toBe(false);
        }
    });
});
