// Content script for in-page keyword detection.
//
// DNR's urlFilter catches keywords that appear in the URL, but it cannot see
// the page <title> or rendered body text. This script runs in every page,
// reads the user's keyword rules from chrome.storage.sync, and if a match is
// found in the title or visible body it asks the background worker to
// navigate the tab to the configured redirectUrl.
//
// Matching honours each rule's caseSensitive and wholeWord toggles, and
// suppresses the redirect when any of the rule's allowed-keyword exceptions
// also appears in the same title/body (so a "tutorial" exception keeps a
// "javascript" rule from firing on a JS tutorial page).
(function () {
    'use strict';

    function escapeRegExp(str) {
        return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Build a haystack of "things on the page a keyword can hit". document.title
    // is cheap; document.body.innerText is the only DOM read we make, and only
    // when the title doesn't already match.
    function getTitleHaystack() {
        try {
            return document.title || '';
        } catch (e) {
            return '';
        }
    }

    function getBodyHaystack() {
        try {
            return document.body && document.body.innerText ? document.body.innerText : '';
        } catch (e) {
            return '';
        }
    }

    function keywordMatches(haystack, keyword, opts) {
        if (!haystack || !keyword) return false;
        const flags = opts && opts.caseSensitive ? '' : 'i';
        if (opts && opts.wholeWord) {
            const re = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, flags);
            return re.test(haystack);
        }
        if (opts && opts.caseSensitive) {
            return haystack.indexOf(keyword) !== -1;
        }
        return haystack.toLowerCase().indexOf(String(keyword).toLowerCase()) !== -1;
    }

    function ruleMatchesPage(rule, title, body) {
        if (!rule || rule.type !== 'keyword' || rule.enabled === false) return false;
        const opts = {
            caseSensitive: rule.caseSensitive === true,
            wholeWord: rule.wholeWord === true
        };
        const hitInTitle = keywordMatches(title, rule.pattern, opts);
        const hitInBody = hitInTitle ? true : keywordMatches(body, rule.pattern, opts);
        if (!hitInTitle && !hitInBody) return false;

        // Allowed-keyword exceptions: if any exception term also appears on the
        // page, the rule does not fire. Exceptions inherit the parent rule's
        // case-sensitivity but never the whole-word toggle — they are
        // intentionally permissive so "tutorial" matches "Tutorials" too.
        const exceptions = Array.isArray(rule.exceptions) ? rule.exceptions : [];
        for (const ex of exceptions) {
            const term = String(ex || '').trim();
            if (!term) continue;
            if (
                keywordMatches(title, term, { caseSensitive: opts.caseSensitive, wholeWord: false }) ||
                keywordMatches(body, term, { caseSensitive: opts.caseSensitive, wholeWord: false })
            ) {
                return false;
            }
        }
        return true;
    }

    async function evaluatePage() {
        try {
            const settings = await chrome.storage.sync.get(['rules', 'redirectUrl', 'extensionEnabled']);
            if (settings.extensionEnabled === false) return;
            const rules = Array.isArray(settings.rules) ? settings.rules : [];
            const keywordRules = rules.filter(r => r && r.type === 'keyword' && r.enabled !== false);
            if (keywordRules.length === 0) return;

            const title = getTitleHaystack();
            const body = getBodyHaystack();

            for (const rule of keywordRules) {
                if (ruleMatchesPage(rule, title, body)) {
                    chrome.runtime.sendMessage({
                        action: 'keywordHit',
                        ruleId: rule.id,
                        pattern: rule.pattern,
                        from: location.href
                    });
                    return;
                }
            }
        } catch (e) {
            // Storage access may fail during extension reload; swallow so the
            // page isn't disrupted by a thrown error from the content script.
        }
    }

    // Initial pass once the document has parsed enough to expose a title.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', evaluatePage, { once: true });
    } else {
        evaluatePage();
    }
})();
