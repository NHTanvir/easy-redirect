// blocked.js — populates blocked.html with settings from chrome.storage (feature #13).
//
// URL parameters:
//   from=<encoded-url>  — the URL the user was blocked from (optional)
//   msg=<text>          — per-redirect custom message override (optional)

(function () {
    'use strict';

    // BUILTIN_MOTIVATION_QUOTES comes from quotes.js (loaded before this script).
    const BUILTIN_QUOTES = (typeof BUILTIN_MOTIVATION_QUOTES !== 'undefined')
        ? BUILTIN_MOTIVATION_QUOTES
        : ['Stay focused. Every blocked visit is a small win.'];

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const m = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
        if (m) el.textContent = m;
    });

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

    // Focus streak: a reminder of what a pause would cost.
    chrome.runtime.sendMessage({ action: 'getFocusState' }, state => {
        const el = document.getElementById('focusStreak');
        if (chrome.runtime.lastError || !el || !state || !state.streak.current) return;
        if (state.settings && state.settings.streakOnBlockedPage === false) return;
        const n = state.streak.current;
        el.textContent = `\u{1F525} ${n}-day focus streak. Don't break it.`;
    });

    // Motivational quote (feature #15) — the only content on the page, always shown.
    chrome.storage.sync.get(
        ['motivationQuotes'],
        syncResult => {
            const quoteEl = document.getElementById('motivationQuote');
            if (quoteEl) {
                const quotes = Array.isArray(syncResult.motivationQuotes) && syncResult.motivationQuotes.length > 0
                    ? syncResult.motivationQuotes
                    : BUILTIN_QUOTES;
                // Seeded rotation: pick quote by day-of-year + minute-of-hour so it changes
                // every minute but is consistent across refreshes within the same minute.
                const now = new Date();
                const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
                const idx = (doy * 60 + now.getMinutes()) % quotes.length;
                quoteEl.textContent = `"${quotes[idx]}"`;
                quoteEl.classList.add('visible');
            }
        }
    );
})();
