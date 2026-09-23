import { describe, it, expect } from 'vitest';
import { VERIFICATION_STATUS } from '../../core/constants.js';

describe('VERIFICATION_STATUS', () => {
    it('exposes a description and isViolation flag for each verdict', () => {
        expect(VERIFICATION_STATUS.MATCH.description).toBe('MATCH');
        expect(VERIFICATION_STATUS.MATCH.isViolation).toBe(false);
        expect(VERIFICATION_STATUS.SKIPPED.isViolation).toBe(false);
        expect(VERIFICATION_STATUS.MISMATCH.isViolation).toBe(true);
        expect(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST.isViolation).toBe(true);
        expect(VERIFICATION_STATUS.ERROR.description).toBe('ERROR');
        expect(VERIFICATION_STATUS.ERROR.isViolation).toBe(true);
        expect(VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE.isViolation).toBe(true);
        expect(VERIFICATION_STATUS.CONFIG_ERROR.isViolation).toBe(true);
    });
});
