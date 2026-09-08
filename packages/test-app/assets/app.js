function log(...args) {
    // window.pageId is injected by playwright fixtures
    if (args.length > 0 && typeof args[0] === 'string' && args[0].startsWith('%c')) {
        const [format, color, ...rest] = args;
        console.log('%c[SimpleApp]', color, `(${window.pageId})`, format.slice(2), ...rest);
        return;
    }
    console.log('[SimpleApp]', `(${window.pageId})`, ...args);
}
log.error = (...args) => console.error('[SimpleApp]', `(${window.pageId})`, ...args);
//Simple app demonstration of DappFence protection!
log('%c App JavaScript loaded', 'color:green');

// Import utilities
import { formatTimestamp } from './utils.js';

// Simple greeting module functionality (replacing the old greet.js)
function greet(name) {
    log(` Hello, ${name}!`);
    return `Hello, ${name}!`;
}

let registrationAttempt = 0;
// Wait for a service worker to be ready and controlling the page
async function waitForServiceWorkerReady(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Service worker ready timeout'));
        }, timeoutMs);

        const checkReady = () => {
            // Check if we have an active service worker controlling this page
            if (navigator.serviceWorker.controller) {
                log(
                    'Found controller:',
                    navigator.serviceWorker.controller.scriptURL,
                    navigator.serviceWorker.controller.state
                );

                // Double-check by testing the /sw-api/status endpoint
                fetch('/sw-api/status')
                    .then((response) => response.ok)
                    .then((isOk) => {
                        if (isOk) {
                            clearTimeout(timeout);
                            log('Service worker is ready and responding');
                            resolve();
                        } else {
                            // Endpoint doesn't ready yet, try again
                            log('Service worker controller is not responding yet');
                            setTimeout(checkReady, 200);
                        }
                    })
                    .catch((err) => {
                        // Endpoint doesn't ready yet, try again
                        log.error('Service worker controller error', err);
                        setTimeout(checkReady, 200);
                    });
                return;
            }

            // TODO: This can end up adding a lot of background jobs
            log('Trying to get the registration, attempt:', registrationAttempt++, '...');
            // Check for active registration
            navigator.serviceWorker.getRegistrations().then((registrations) => {
                for (let j = 0; j < registrations.length; j++) {
                    const r = registrations[j];
                    log(
                        'Checking registration:',
                        j,
                        r.waiting && [r.waiting.scriptURL, r.waiting.state],
                        r.installing && [r.installing.scriptURL, r.installing.state],
                        r.active && [r.active.scriptURL, r.active.state]
                    );
                }
                const activeReg = registrations.find(
                    (reg) => reg.active && reg.active.scriptURL.includes('dappfence.js')
                );

                if (activeReg) {
                    log(
                        'DappFence service worker is active:',
                        activeReg.active && activeReg.active.scriptURL,
                        'testing endpoint, attempt:',
                        registrationAttempt
                    );
                    // Test if the endpoint is actually working
                    fetch('/sw-api/status')
                        .then((response) => response.ok)
                        .then((isOk) => {
                            try {
                                if (isOk) {
                                    clearTimeout(timeout);
                                    log('Service worker registration is responding');
                                    resolve();
                                } else {
                                    log('Service worker registration is not responding yet');
                                    setTimeout(checkReady, 1000);
                                }
                            } catch (e) {
                                log.error('Error checking service worker status:', e);
                            }
                        })
                        .catch((err) => {
                            log(
                                'Service worker status fetch error, attempt:',
                                registrationAttempt,
                                err
                            );
                            setTimeout(checkReady, 1000);
                        });
                    return;
                }

                // If not ready, check again in a bit
                log('Service worker not ready yet, retry');
                setTimeout(checkReady, 200);
            });
        };

        // Start checking
        checkReady();

        // Also listen for controllerchange events
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (navigator.serviceWorker.controller) {
                clearTimeout(timeout);
                log('Service worker took control');
                resolve();
            }
        });
    });
}

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
    log('DOM loaded, initializing app');
    // Wait for a service worker to be ready before trying to fetch status
    waitForServiceWorkerReady()
        .then(() => {
            log('Service worker ready, loading manifest status for demo');
            window.checkManifestStatus();
        })
        .catch((error) => {
            log.error('Service worker failed to become ready:', error);
            const output = document.getElementById('output');
            if (output) {
                output.innerHTML = `
                <div class="alert alert--warn">
                    <div class="alert__body">
                        <h4>⚠️ Service Worker is not ready</h4>
                        <p>DappFence service worker is not active yet. Try refreshing the page or check the browser console for errors.</p>
                        <button class="btn btn--secondary" onclick="window.checkManifestStatus()">Retry</button>
                    </div>
                </div>
            `;
            }
        });

    // Add an event listener to the test button (less prominent now)
    const testBtn = document.getElementById('test-btn');
    if (testBtn) {
        testBtn.addEventListener('click', () => {
            const greeting = greet('DappFence User');
            log('Demo button clicked:', greeting);

            // Just show a small notification instead of taking over the output area
            const notification = document.createElement('div');
            notification.className = 'toast';
            notification.textContent = `✅ ${greeting}`;
            document.body.appendChild(notification);

            setTimeout(() => {
                document.body.removeChild(notification);
            }, 3000);
        });
    }
});

// Global functions for button clicks
window.showAlert = function () {
    alert('🔒 This alert is shown from a DappFence-protected application!');
};

window.loadContent = function () {
    const output = document.getElementById('output');
    output.innerHTML = `
        <div class="alert alert--info">
            <div class="alert__body">
                <h4>📊 Security monitoring active</h4>
                <p>DappFence is monitoring all network requests and content changes.</p>
                <p>Check the browser console to see security logs.</p>
                <p><small>Timestamp: ${new Date().toISOString()}</small></p>
            </div>
        </div>
    `;
};

// Trusted Manifest testing functions
window.checkManifestStatus = async function () {
    try {
        log('Checking manifest status...');

        // Check if a service worker is ready
        const registrations = await navigator.serviceWorker.getRegistrations();
        const activeReg = registrations.find(
            (reg) => reg.active && reg.active.scriptURL.includes('dappfence.js')
        );

        if (!activeReg && !navigator.serviceWorker.controller) {
            throw new Error('Service worker not ready - please wait or refresh the page');
        }

        const response = await fetch('/sw-api/status');
        if (!response.ok) {
            throw new Error(
                `Service worker status endpoint returned ${response.status}: ${response.statusText}`
            );
        }

        const status = await response.json();
        log('Manifest Status:', status);

        const statusVariant = (status) =>
            status === 'MATCH' ? 'match' : status === 'MISMATCH' ? 'mismatch' : 'unknown';
        const statusLabel = (status) =>
            status === 'MATCH' ? 'MATCH' : status === 'MISMATCH' ? 'MISMATCH' : 'UNKNOWN';

        const createFileList = (manifest, isVerificationResults = false) => {
            if (isVerificationResults) {
                if (!manifest || manifest.length === 0) {
                    return `<p class="empty">No verification results yet.</p>`;
                }

                const now = new Date();
                const sortedManifest = [...manifest].sort(
                    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
                );

                let html = '<div class="file-list">';
                sortedManifest.forEach((result) => {
                    const variant = statusVariant(result.status);
                    const typeIcon = result.isExternal ? '🌐' : '📄';
                    let fileName;
                    if (result.isExternal) {
                        try {
                            const urlStr = result.fullUrl || result.fileKey;
                            const urlObj = new URL(urlStr);
                            fileName = urlObj.hostname + urlObj.pathname;
                        } catch (e) {
                            fileName = result.fileKey;
                        }
                    } else {
                        fileName = result.fileKey;
                    }

                    const verificationTime = new Date(result.timestamp);
                    const isRecent = now - verificationTime < 30000;
                    const recentClass = isRecent ? ' file-row--recent' : '';
                    const hash = result.actualHash ? result.actualHash : 'No hash';
                    const expected =
                        result.status === 'MISMATCH'
                            ? `<span class="file-row__expected">expected ${result.expectedHashes?.join(', ')}</span>`
                            : '';

                    html += `
                        <div class="file-row file-row--${variant}${recentClass}">
                            <span class="file-row__icon" aria-hidden="true">${typeIcon}</span>
                            <div class="file-row__body">
                                <div class="file-row__name" title="${fileName}">${fileName}</div>
                                <small class="file-row__hash" title="${hash}">${hash}</small>
                                ${expected}
                                <small class="file-row__time">🕒 ${formatTimestamp(verificationTime)}</small>
                            </div>
                            <div class="file-row__aside">
                                ${isRecent ? '<span class="badge badge--info">just verified</span>' : ''}
                                <span class="badge badge--${variant}">${statusLabel(result.status)}</span>
                            </div>
                        </div>
                    `;
                });
                html += '</div>';
                return html;
            }

            const manifestFiles = manifest.files || manifest;
            if (!manifestFiles || Object.keys(manifestFiles).length === 0) {
                return `<p class="empty">No files yet.</p>`;
            }

            let html = '<div class="file-list">';
            Object.entries(manifestFiles).forEach(([fileKey, fileData]) => {
                const isExternal = !fileKey.startsWith('/');
                const typeIcon = isExternal ? '🌐' : '📄';
                let fileName;
                if (isExternal) {
                    try {
                        const urlObj = new URL(fileKey);
                        fileName = urlObj.hostname + urlObj.pathname;
                    } catch (e) {
                        fileName = fileKey;
                    }
                } else {
                    fileName = fileKey;
                }
                const hash = typeof fileData === 'string' ? fileData : fileData.hash || 'unknown';

                html += `
                    <div class="file-row">
                        <span class="file-row__icon" aria-hidden="true">${typeIcon}</span>
                        <div class="file-row__body">
                            <div class="file-row__name" title="${fileName}">${fileName}</div>
                            <small class="file-row__hash" title="${hash}">${hash}</small>
                        </div>
                        <div class="file-row__aside">
                            <span class="badge badge--muted">${isExternal ? 'external' : 'local'}</span>
                        </div>
                    </div>
                `;
            });
            html += '</div>';
            return html;
        };

        // Calculate failed verification count
        const failedVerifications = status.verificationResults.filter(
            (r) => r.status === 'MISMATCH' || r.status === 'NOT_IN_MANIFEST'
        ).length;

        const matchCount = status.verificationResults.filter((r) => r.status === 'MATCH').length;
        const mismatchCount = status.verificationResults.filter(
            (r) => r.status === 'MISMATCH'
        ).length;
        const unknownCount = status.verificationResults.filter(
            (r) => r.status === 'NOT_IN_MANIFEST'
        ).length;

        const output = document.getElementById('output');
        output.innerHTML = `
            <div class="card">
                <div class="card__header">
                    <h4 class="card__title">📋 Trusted manifest status</h4>
                    <button class="btn btn--secondary" onclick="checkManifestStatus()">Refresh</button>
                </div>
                <div class="stats-grid">
                    <div class="stat stat--brand">
                        <span class="stat__label">App version</span>
                        <span class="stat__value"><code>${status.appVersion ? status.appVersion : 'Not set'}</code></span>
                    </div>
                    <div class="stat stat--success">
                        <span class="stat__label">Trusted files</span>
                        <span class="stat__value">${status.stats.trustedFiles}</span>
                    </div>
                    <div class="stat stat--brand">
                        <span class="stat__label">Total verifications</span>
                        <span class="stat__value">${status.stats.totalVerifications}</span>
                    </div>
                    <div class="stat ${failedVerifications > 0 ? 'stat--danger' : 'stat--success'}">
                        <span class="stat__label">Failed verifications</span>
                        <span class="stat__value">${failedVerifications}</span>
                    </div>
                </div>
                ${
                    status.stats.trustedFiles > 0
                        ? `
                    <details class="collapsible">
                        <summary>
                            🔒 Trusted files
                            <span class="summary-meta"><span class="badge badge--muted">${status.stats.trustedFiles}</span></span>
                        </summary>
                        ${createFileList(status.trustedManifest)}
                    </details>
                `
                        : ''
                }

                ${
                    status.verificationResults && status.verificationResults.length > 0
                        ? `
                    <details class="collapsible">
                        <summary>
                            🔍 Verifications
                            <span class="summary-meta">
                                <span class="badge badge--match">${matchCount} match</span>
                                <span class="badge badge--mismatch">${mismatchCount} mismatch</span>
                                <span class="badge badge--unknown">${unknownCount} unknown</span>
                            </span>
                        </summary>
                        ${
                            status.verificationResults.length > 20
                                ? '<p class="empty">Showing latest first. Recent verifications (last 30s) are highlighted.</p>'
                                : ''
                        }
                        ${createFileList(status.verificationResults, true)}
                    </details>
                `
                        : ''
                }

                <details class="collapsible">
                    <summary>🔧 Raw JSON</summary>
                    <pre class="pre-json">${JSON.stringify(status, null, 2)}</pre>
                </details>
            </div>
        `;
    } catch (error) {
        log.error('Error fetching manifest status:', error);

        const output = document.getElementById('output');
        if (output) {
            output.innerHTML = `
                <div class="alert alert--error">
                    <div class="alert__body">
                        <h4>❌ Error loading status</h4>
                        <p><strong>Error:</strong> ${error.message}</p>
                        <p>This usually means the DappFence service worker is not ready yet.</p>
                        <div class="btn-row">
                            <button class="btn" onclick="window.checkManifestStatus()">Retry</button>
                            <button class="btn btn--secondary" onclick="location.reload()">Refresh page</button>
                        </div>
                    </div>
                </div>
            `;
        }
    }
};

// Export for potential module usage
export { greet };
