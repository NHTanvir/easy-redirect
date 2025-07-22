// countdown.js — drives the countdown interstitial page (feature #12).
//
// URL parameters accepted (all set by background.js at redirect time):
//   from=<encoded-original-url>  — the URL the user was trying to visit
//   to=<encoded-redirect-url>    — the final redirect destination (blocked page)
//   delay=<seconds>              — how many seconds to count down
//   window=<seconds>             — allow-window length (0 = no window)
//   ruleId=<rule-id>             — identifies the matching rule for allow tracking
//
// Storage key used to track the allow window:
//   chrome.storage.local key: 'allowedUntil:<ruleId>'
//   Value: epoch ms timestamp; while Date.now() < value the user skips the countdown.

(function () {
    'use strict';

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const m = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
        if (m) el.textContent = m;
    });

    const params = new URLSearchParams(location.search);
    const fromUrl    = params.get('from')   || '';
    const toUrl      = params.get('to')     || 'https://www.google.com';
    const delaySecs  = Math.max(1, parseInt(params.get('delay')  || '10', 10));
    const windowSecs = Math.max(0, parseInt(params.get('window') || '0',  10));
    const ruleId     = params.get('ruleId') || '';
    const allowKey   = ruleId ? `allowedUntil:${ruleId}` : null;

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
        targetDisplay.textContent = fromUrl || '(unknown)';
    }

    // Show the allow-window duration in the warning box.
    function fmtSecs(s) {
        if (s <= 0) return '0 seconds';
        const m = Math.floor(s / 60);
        const sec = s % 60;
        const parts = [];
        if (m > 0) parts.push(`${m} minute${m !== 1 ? 's' : ''}`);
        if (sec > 0) parts.push(`${sec} second${sec !== 1 ? 's' : ''}`);
        return parts.join(' ');
    }
    if (windowSecs > 0) {
        warningBox.style.display = '';
        windowDisplay.textContent = fmtSecs(windowSecs);
    }

    // Navigate to the original URL the user wanted, optionally recording
    // the start of the allow window so future visits skip the countdown.
    function navigateToFrom() {
        if (allowKey && windowSecs > 0) {
            const allowUntil = Date.now() + windowSecs * 1000;
            chrome.storage.local.set({ [allowKey]: allowUntil }, () => {
                location.replace(fromUrl || toUrl);
            });
        } else {
            location.replace(fromUrl || toUrl);
        }
    }

    // Check the allow window — if still active, skip the countdown entirely.
    function checkAllowWindowThenStart() {
        if (!allowKey) { startCountdown(); return; }
        chrome.storage.local.get([allowKey], result => {
            const allowedUntil = result[allowKey];
            if (typeof allowedUntil === 'number' && Date.now() < allowedUntil) {
                // Still inside the allow window — go straight to the target.
                location.replace(fromUrl || toUrl);
            } else {
                startCountdown();
            }
        });
    }

    // SVG arc constants (r=52 → circumference ≈ 326.73).
    const CIRCUMFERENCE = 2 * Math.PI * 52; // ≈ 326.726
    progressArc.setAttribute('stroke-dasharray', String(CIRCUMFERENCE.toFixed(2)));

    function setArc(fraction) {
        progressArc.setAttribute('stroke-dashoffset',
            String((CIRCUMFERENCE * (1 - fraction)).toFixed(2)));
    }

    function startCountdown() {
        const endsAt = Date.now() + delaySecs * 1000;
        let finished = false;

        function tick() {
            const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
            countdownNumber.textContent = String(remaining);
            if (statusSecs) statusSecs.textContent = String(remaining);
            setArc(remaining / delaySecs);

            if (remaining === 0 && !finished) {
                finished = true;
                clearInterval(tickInterval);
                statusText.textContent = 'Countdown complete. Continuing…';
                allowBtn.classList.add('active');
                // Auto-navigate to the original URL after a short grace period.
                setTimeout(navigateToFrom, 1500);
            }
        }

        const tickInterval = setInterval(tick, 500);
        tick(); // paint immediately

        // "Continue anyway" button appears immediately and navigates.
        allowBtn.addEventListener('click', () => {
            clearInterval(tickInterval);
            navigateToFrom();
        });
    }

    // "Go back" navigates to history or the redirect target (blocked page).
    goBackBtn.addEventListener('click', () => {
        if (history.length > 1) {
            history.back();
        } else {
            location.replace(toUrl);
        }
    });

    // Entry point — check allow window before starting the timer.
    checkAllowWindowThenStart();
})();
