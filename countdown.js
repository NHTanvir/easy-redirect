// countdown.js — drives the countdown interstitial page (feature #12).
//
// URL parameters accepted (all required when served by background.js):
//   from=<encoded-original-url>  — the URL the user was trying to visit
//   to=<encoded-redirect-url>    — the final redirect destination
//   delay=<seconds>              — how many seconds to count down
//   window=<seconds>             — allow-window length (0 = no window)
//   ruleId=<rule-id>             — identifies the matching rule for allow tracking
//   groupId=<group-id>           — identifies the matching group
//
// Storage key used to track the allow window:
//   chrome.storage.local key: 'allowedUntil:<ruleId>'
//   Value: epoch ms timestamp after which the rule redirects again.

(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    const fromUrl   = params.get('from')    || '';
    const toUrl     = params.get('to')      || 'https://www.google.com';
    const delaySecs = Math.max(1, parseInt(params.get('delay') || '10', 10));
    const windowSecs = Math.max(0, parseInt(params.get('window') || '0', 10));
    const ruleId    = params.get('ruleId')  || '';
    const groupId   = params.get('groupId') || '';

    const allowKey  = ruleId ? `allowedUntil:${ruleId}` : null;

    // DOM references
    const targetDisplay   = document.getElementById('targetDisplay');
    const countdownNumber = document.getElementById('countdownNumber');
    const statusText      = document.getElementById('statusText');
    const statusSecs      = document.getElementById('statusSecs');
    const progressArc     = document.getElementById('progressArc');
    const allowBtn        = document.getElementById('allowBtn');
    const goBackBtn       = document.getElementById('goBackBtn');
    const warningBox      = document.getElementById('warningBox');
    const windowDisplay   = document.getElementById('windowDisplay');

    // Show the target domain in the subtitle.
    try {
        targetDisplay.textContent = new URL(fromUrl).hostname || fromUrl;
    } catch (_) {
        targetDisplay.textContent = fromUrl;
    }

    // SVG arc constants (r=52 → circumference ≈ 326.73).
    const CIRCUMFERENCE = 2 * Math.PI * 52;
    progressArc.setAttribute('stroke-dasharray', String(CIRCUMFERENCE));

    function setArc(fraction) {
        // fraction 1 = full ring; 0 = empty ring.
        progressArc.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - fraction)));
    }

    // Format seconds as human-readable string (e.g. "5 minutes 30 seconds").
    function fmtSecs(s) {
        if (s <= 0) return '0 seconds';
        const m = Math.floor(s / 60);
        const sec = s % 60;
        const parts = [];
        if (m > 0) parts.push(`${m} minute${m > 1 ? 's' : ''}`);
        if (sec > 0) parts.push(`${sec} second${sec > 1 ? 's' : ''}`);
        return parts.join(' ');
    }

    // Show the allow-window duration in the warning box.
    if (windowSecs > 0) {
        warningBox.style.display = '';
        windowDisplay.textContent = fmtSecs(windowSecs);
    }

    const endsAt = Date.now() + delaySecs * 1000;
    let finished = false;

    function tick() {
        const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
        countdownNumber.textContent = String(remaining);
        statusSecs.textContent = String(remaining);
        setArc(remaining / delaySecs);

        if (remaining === 0 && !finished) {
            finished = true;
            statusText.textContent = 'Countdown complete. You may continue or go back.';
            allowBtn.classList.add('active');
            // Auto-redirect to the original destination (not the blocked redirect).
            // The user gets to where they were going — but if they close the tab and
            // come back the countdown will reset (unless allowWindowSecs > 0).
            scheduleAutoRedirect();
        }
    }

    const tickInterval = setInterval(tick, 500);
    tick(); // paint immediately

    function scheduleAutoRedirect() {
        // After the delay the page navigates automatically to fromUrl (the
        // user's intended page). We do NOT navigate to `toUrl` because they
        // already waited — the wait IS the friction. The allow window (if any)
        // starts from this moment.
        if (allowKey && windowSecs > 0) {
            const allowUntil = Date.now() + windowSecs * 1000;
            chrome.storage.local.set({ [allowKey]: allowUntil }, () => {
                navigateToFrom();
            });
        } else {
            navigateToFrom();
        }
    }

    function navigateToFrom() {
        clearInterval(tickInterval);
        if (fromUrl) {
            location.replace(fromUrl);
        } else {
            location.replace(toUrl);
        }
    }

    // "Continue anyway" button — also navigates to the original page.
    allowBtn.addEventListener('click', () => {
        clearInterval(tickInterval);
        if (allowKey && windowSecs > 0) {
            const allowUntil = Date.now() + windowSecs * 1000;
            chrome.storage.local.set({ [allowKey]: allowUntil }, navigateToFrom);
        } else {
            navigateToFrom();
        }
    });

    // "Go back" navigates to history.back() or the blocked-page redirect target.
    goBackBtn.addEventListener('click', () => {
        clearInterval(tickInterval);
        if (history.length > 1) {
            history.back();
        } else {
            location.replace(toUrl);
        }
    });
})();
