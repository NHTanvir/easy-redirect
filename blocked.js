// blocked.js — populates blocked.html with settings from chrome.storage (feature #13).
//
// URL parameters:
//   from=<encoded-url>  — the URL the user was blocked from (optional)
//   msg=<text>          — per-redirect custom message override (optional)

(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('from') || '';

    // Fix up the settings link — replace the PLACEHOLDER extension ID with the real one.
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) {
        settingsBtn.href = `chrome-extension://${chrome.runtime.id}/options.html`;
    }

    // "Go back" navigates to browser history or falls back to the blocklist redirect target.
    const goBackBtn = document.getElementById('goBackBtn');
    if (goBackBtn) {
        goBackBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (history.length > 1) {
                history.back();
            } else {
                // No history — close the tab or stay put.
                window.close();
            }
        });
    }

    // Show the blocked URL in the subtitle.
    const fromEl = document.getElementById('blockedFrom');
    if (fromEl && fromUrl) {
        try {
            fromEl.textContent = `Blocked: ${new URL(fromUrl).hostname}`;
        } catch (_) {
            fromEl.textContent = `Blocked: ${fromUrl}`;
        }
    }

    // Load all display settings from chrome.storage.sync + local.
    chrome.storage.sync.get(
        ['blockedPageTitle', 'blockedMessage', 'motivationEnabled', 'motivationQuotes'],
        syncResult => {
            // Title
            const titleEl = document.getElementById('blockedTitle');
            if (titleEl) {
                titleEl.textContent = (typeof syncResult.blockedPageTitle === 'string' && syncResult.blockedPageTitle.trim())
                    ? syncResult.blockedPageTitle.trim()
                    : 'Site Blocked';
            }

            // Message
            const msgEl = document.getElementById('blockedMessage');
            if (msgEl) {
                // A per-redirect ?msg= param takes precedence over the stored default.
                const overrideMsg = params.get('msg');
                const storedMsg = typeof syncResult.blockedMessage === 'string' ? syncResult.blockedMessage.trim() : '';
                msgEl.textContent = overrideMsg || storedMsg ||
                    'This site has been blocked by Easy Redirect to help you stay focused.';
            }

            // Motivation quote (feature #15 compatible — optional).
            const quoteEl = document.getElementById('motivationQuote');
            if (quoteEl && syncResult.motivationEnabled) {
                const quotes = Array.isArray(syncResult.motivationQuotes) && syncResult.motivationQuotes.length > 0
                    ? syncResult.motivationQuotes
                    : ['Stay focused. Every blocked visit is a small win.'];
                // Seeded rotation: pick quote by day-of-year + seconds-of-minute so it changes
                // every minute but is consistent across refreshes within the same minute.
                const now = new Date();
                const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
                const idx = (doy * 60 + now.getMinutes()) % quotes.length;
                quoteEl.textContent = `"${quotes[idx]}"`;
                quoteEl.classList.add('visible');
            }

            // Custom image — stored as a data URL in chrome.storage.local.
            chrome.storage.local.get(['blockedImageDataUrl'], localResult => {
                const imgEl = document.getElementById('blockedImage');
                if (imgEl && localResult.blockedImageDataUrl) {
                    imgEl.src = localResult.blockedImageDataUrl;
                    imgEl.classList.add('visible');
                }
            });
        }
    );
})();
