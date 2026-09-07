import { createLogger } from '../../../core/logger.js';
import { calculateHash } from '../../../core/crypto.js';
import { VERIFICATION_STATUS } from '../../../core/constants.js';

const logger = createLogger();

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HEX = '[0-9a-f]+';

export const TRANSFORMS = {
    'netlify-cdp': {
        // Only whitespace is allowed between the opening tag and the script tag, so
        // extra content cannot be hidden inside the filtered block.
        findStripRanges(text) {
            const pattern = new RegExp(
                `<div data-netlify-deploy-id="${HEX}" data-netlify-site-id="${UUID}" data-vcs="github" style="position:fixed">` +
                    '\\s*<script async src="/.netlify/scripts/cdp"></script>\\s*</div>',
                'g'
            );
            const ranges = [];
            let match;
            while ((match = pattern.exec(text)) !== null) {
                ranges.push([match.index, match.index + match[0].length]);
            }
            return ranges;
        },
    },
};

/**
 * Apply a named transform to the response body, hash the result, and compare
 * against the manifest. Returns a result object on MATCH, or null to fall
 * through to the next contentRule action.
 *
 * @param {string} fileKey
 * @param {{ getBodyBytes(): Promise<Uint8Array> }} wrappedResponse
 * @param {{ appVersion: string, manifest: object }} manifestInfo
 * @param {object} action - contentRule action with `transform` name
 * @returns {Promise<object|null>}
 */
export const handleTransform = async (fileKey, wrappedResponse, manifestInfo, action) => {
    const rule = TRANSFORMS[action.transform];
    if (!rule) {
        logger.warn(`Unknown transform: ${action.transform}`);
        return null;
    }
    const bytes = await wrappedResponse.getBodyBytes();
    if (bytes.status) {
        return bytes;
    }
    const { appVersion, manifest } = manifestInfo;
    const text = new TextDecoder().decode(bytes.value);
    const ranges = rule.findStripRanges(text);
    let stripped = text;
    for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
        stripped = stripped.slice(0, start) + stripped.slice(end);
    }
    const transformed = new TextEncoder().encode(stripped);
    const fileHash = await calculateHash(transformed);
    const expectedHashes = manifest.files[fileKey] ?? [];
    logger.log(
        `Using manifest ${appVersion} for ${fileKey} hash ${fileHash} expected: ${expectedHashes.join(', ')}`
    );
    if (expectedHashes.includes(fileHash)) {
        return { status: VERIFICATION_STATUS.MATCH, expectedHashes, actualHash: fileHash };
    }
    return null;
};
