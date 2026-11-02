// blocked.js — populates blocked.html with settings from chrome.storage (feature #13).
//
// URL parameters:
//   from=<encoded-url>  — the URL the user was blocked from (optional)
//   msg=<text>          — per-redirect custom message override (optional)

(function () {
    'use strict';

    // Built-in motivational quotes (feature #15). Used when the user has enabled
    // "Show motivational quote" but left the custom quotes box empty. blocked.js
    // rotates through these the same way it rotates custom quotes.
    const BUILTIN_MOTIVATION_QUOTES = [
        'Stay focused. Every blocked visit is a small win.',
        'Your future self will thank you.',
        'Discipline is choosing between what you want now and what you want most.',
        'Small steps every day add up to big results.',
        'The distraction will still be there later. Your focus won’t.',
        'You don’t have to be extreme, just consistent.',
        'Focus is a muscle. Every time you resist, it grows stronger.',
        'The best time to start was yesterday. The next best time is now.',
        'Done is better than perfect. Start now.',
        'Motivation gets you started. Habit keeps you going.',
        'What you do today can improve all your tomorrows.',
        'A little progress each day adds up to big results.',
        'Don’t watch the clock; do what it does. Keep going.',
        'The secret of getting ahead is getting started.',
        'You are what you repeatedly do. Excellence is a habit.',
        'The pain of discipline weighs ounces; the pain of regret weighs tons.',
        'Success is the sum of small efforts repeated day in and day out.',
        'Great things never came from comfort zones.',
        'Every minute you stay focused is a minute invested in who you’re becoming.',
        'The only way to do great work is to not get distracted from it.',
        'Direction is so much more important than speed.',
        'Fall in love with the process and the results will come.',
        'You will never always be motivated. Learn to be disciplined.',
        'One day or day one. You decide.',
        'Starve your distractions, feed your focus.',
        'The future depends on what you do today.',
        'Work hard in silence; let your success be your noise.',
        'Energy and persistence conquer all things.',
        'Little by little, one travels far.',
        'The expert in anything was once a beginner.',
        'Don’t count the days; make the days count.',
        'Your only limit is the amount of focus you’re willing to give.',
        'Deep work is the superpower of the 21st century.',
        'Protect your attention. It is the most valuable thing you own.',
        'Progress, not perfection.',
        'The things you do today are the stories you tell tomorrow.',
        'Stay patient and trust your journey.',
        'A goal without focus is just a wish.',
        'What consumes your attention consumes your life.',
        'Choose the discomfort of discipline over the discomfort of regret.',
        'Quitting the distraction is a victory in itself.',
        'Every no to distraction is a yes to your goals.',
        'Hard choices, easy life. Easy choices, hard life.',
        'The reward for focus is more of what matters.',
        'You can do anything, but not everything. Focus.',
        'Make each day your masterpiece.',
        'The distance between dreams and reality is called action.',
        'Be stronger than your strongest excuse.',
        'Keep going. Everything you need will come to you at the perfect time.',
        'This moment of focus is a gift to the person you’re becoming.'
    ];

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const m = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
        if (m) el.textContent = m;
    });

    const params = new URLSearchParams(location.search);
    // ?from= is set by the countdown interstitial when it chains to blocked.html.
    // When blocked.html is the direct DNR redirect target, DNR cannot inject the
    // matched URL into the redirect, so we fall back to document.referrer (the
    // last page the browser visited before this one).
    const fromUrl = params.get('from') || document.referrer || '';

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

    // Focus streak: a reminder of what a pause would cost.
    chrome.runtime.sendMessage({ action: 'getFocusState' }, state => {
        const el = document.getElementById('focusStreak');
        if (chrome.runtime.lastError || !el || !state || !state.streak.current) return;
        if (state.settings && state.settings.streakOnBlockedPage === false) return;
        const n = state.streak.current;
        el.textContent = `\u{1F525} ${n}-day focus streak. Don't break it.`;
    });

    // Load all display settings from chrome.storage.sync + local.
    chrome.storage.sync.get(
        ['blockedPageTitle', 'blockedMessage', 'motivationEnabled', 'motivationQuotes'],
        syncResult => {
            // Title
            const titleEl = document.getElementById('blockedTitle');
            if (titleEl) {
                const i18nTitle = chrome.i18n.getMessage('blockedPageTitle');
                titleEl.textContent = (typeof syncResult.blockedPageTitle === 'string' && syncResult.blockedPageTitle.trim())
                    ? syncResult.blockedPageTitle.trim()
                    : (i18nTitle || 'Site Blocked');
            }

            // Message
            const msgEl = document.getElementById('blockedMessage');
            if (msgEl) {
                // A per-redirect ?msg= param takes precedence over the stored default.
                const overrideMsg = params.get('msg');
                const storedMsg = typeof syncResult.blockedMessage === 'string' ? syncResult.blockedMessage.trim() : '';
                const i18nMsg = chrome.i18n.getMessage('blockedPageMessage');
                msgEl.textContent = overrideMsg || storedMsg || i18nMsg ||
                    'This site has been blocked by Easy Redirect to help you stay focused.';
            }

            // Motivation quote (feature #15 compatible — optional).
            const quoteEl = document.getElementById('motivationQuote');
            if (quoteEl && syncResult.motivationEnabled) {
                const quotes = Array.isArray(syncResult.motivationQuotes) && syncResult.motivationQuotes.length > 0
                    ? syncResult.motivationQuotes
                    : BUILTIN_MOTIVATION_QUOTES;
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
