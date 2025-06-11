// Background script for Website Redirector extension

// Bump SCHEMA_VERSION whenever the persisted shape of `rules` changes in a way
// that needs a one-shot migration. Code that reads from storage compares against
// settings.schemaVersion to decide whether to migrate before reading.
const SCHEMA_VERSION = 2;

// Rule.type values understood by createRedirectRules. Extended as later PRs land
// (regex). 'keyword' rules match either a URL substring (DNR-driven) or
// the page <title>/body (content-script-driven — DNR alone can't see titles).
// Anything not in this list is rejected by validation.
//
//   domain   - bare host like "example.com", emitted as a four-variant fan-out.
//   wildcard - user-supplied pattern containing '*', passed through verbatim.
//   path     - host+path like "reddit.com/r/funny" or "youtube.com/@channel";
//              matches main_frame requests under that exact path prefix.
//   keyword  - word/phrase matched in the page title or body via content script.
const RULE_TYPES = ['domain', 'wildcard', 'path', 'keyword'];

// Top-level matching mode. In 'blocklist' the rules[] array enumerates patterns
// to redirect; in 'allowlist' the same rules[] enumerates patterns to permit
// while everything else is redirected. Default stays 'blocklist' so existing
// installs keep their current semantics after upgrade. Mode is persisted like
// every other key in DEFAULTS so the local mirror tracks it via persist() and
// restoreFromLocalIfSyncEmpty(); switching modes must never delete rules.
const MODES = ['blocklist', 'allowlist'];

const DEFAULTS = {
    redirectUrl: 'https://www.google.com',
    blockedWebsites: [],
    rules: [],
    extensionEnabled: true,
    mode: 'blocklist',
    // Patterns that are always allowed regardless of mode. Pinned list lives in
    // its own array (not in rules[]) so it can survive Clear All and so the
    // extension page itself can stay reachable when allowlist mode is on.
    alwaysAllowed: [],
    schemaVersion: 1
};

// Stable opaque identifier for a Rule. Prefer crypto.randomUUID() (available in
// MV3 service workers) but fall back to a timestamp+random combo for unusual
// environments so rule creation never silently fails to assign an id.
function generateRuleId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Factory for the structured Rule object that replaces the bare `blockedWebsites`
// string. Every field has a sensible default so callers only need to supply a
// pattern and a type; `opts` can override anything (used by the legacy migration
// to backfill createdAt, for example).
function createRule(pattern, type, opts = {}) {
    const rule = {
        id: opts.id || generateRuleId(),
        pattern,
        type,
        enabled: opts.enabled !== undefined ? opts.enabled : true,
        groupId: opts.groupId || 'default',
        createdAt: opts.createdAt || Date.now(),
        hitCount: opts.hitCount || 0,
        lastHitAt: opts.lastHitAt || null
    };
    // Every rule type carries an exceptions[] list — URL patterns that should
    // NOT be redirected even though the parent rule would match. Exceptions are
    // emitted as higher-priority DNR allow rules at offsets 90..99 within the
    // rule's 100-ID block, so they shadow the parent redirect automatically.
    rule.exceptions = Array.isArray(opts.exceptions) ? opts.exceptions.slice() : [];
    // Keyword rules additionally carry matching toggles (case-sensitive, whole-word).
    if (type === 'keyword') {
        rule.caseSensitive = opts.caseSensitive === true;
        rule.wholeWord = opts.wholeWord === true;
    }
    return rule;
}

// Split a stored path-rule pattern into its host and tail halves. Patterns are
// stored canonically as either `host/path` or `host?query` (no scheme, no
// leading www, no trailing slash on the path). The returned `tail` includes
// the leading separator (`/` or `?`) so the matcher can splice it back into a
// urlFilter without re-deriving which form this was. Returns `{ host: '', tail:
// '' }` for an empty pattern, and `{ host, tail: '' }` for a host-only one.
function splitHostAndPath(pattern) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
        return { host: '', tail: '' };
    }
    const slash = pattern.indexOf('/');
    const question = pattern.indexOf('?');

    // Whichever separator appears first wins; if neither appears, the whole
    // pattern is a bare host.
    let split = -1;
    if (slash === -1 && question === -1) {
        return { host: pattern, tail: '' };
    } else if (slash === -1) {
        split = question;
    } else if (question === -1) {
        split = slash;
    } else {
        split = Math.min(slash, question);
    }
    return { host: pattern.slice(0, split), tail: pattern.slice(split) };
}

// One-shot migration from the legacy `blockedWebsites: string[]` shape to the
// structured `rules[]` array. Idempotent: returns the input untouched once
// schemaVersion has been bumped to 2. CRITICAL: never deletes blockedWebsites —
// it is COPIED, not moved, so we retain the legacy data as an untouchable
// rollback path. Only an explicit user action may clear blockedWebsites.
function migrateLegacyBlockedWebsites(settings) {
    if (settings && typeof settings.schemaVersion === 'number' && settings.schemaVersion >= 2) {
        return settings;
    }

    const legacy = Array.isArray(settings && settings.blockedWebsites) ? settings.blockedWebsites : [];
    const existingRules = Array.isArray(settings && settings.rules) ? settings.rules : [];
    const migratedRules = legacy.map(pattern => createRule(pattern, 'domain'));

    return {
        ...settings,
        rules: existingRules.length > 0 ? existingRules : migratedRules,
        schemaVersion: 2
    };
}

chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('Website Redirector onInstalled:', details.reason);

    // Order matters: restore from the local backup BEFORE filling in defaults,
    // otherwise a sync that came back empty would get DEFAULTS written over the
    // top of perfectly good local data. The schema migration runs after restore
    // (so it sees the user's real data) but before initializeMissingDefaults
    // (so it has the chance to populate rules[] before defaults would).
    await restoreFromLocalIfSyncEmpty();
    await runSchemaMigration();
    await initializeMissingDefaults();

    await ensureKeywordContentScriptRegistered();
    updateRedirectRules();
});

// Content script registration is dynamic instead of declared in manifest.json
// because we want a single source of truth for the script ID (so we can
// unregister cleanly on update) and because keyword matching is opt-in
// behaviour — if the user has no keyword rules we could skip injection
// entirely. For now we keep it always-registered; the script itself early-
// exits when there are no keyword rules, which is cheap.
const KEYWORD_CONTENT_SCRIPT_ID = 'easy-redirect-keyword-content';

async function ensureKeywordContentScriptRegistered() {
    if (!chrome.scripting || typeof chrome.scripting.getRegisteredContentScripts !== 'function') {
        return;
    }
    try {
        const existing = await chrome.scripting.getRegisteredContentScripts({
            ids: [KEYWORD_CONTENT_SCRIPT_ID]
        });
        if (Array.isArray(existing) && existing.length > 0) {
            return; // already registered from a previous startup
        }
        await chrome.scripting.registerContentScripts([
            {
                id: KEYWORD_CONTENT_SCRIPT_ID,
                js: ['content.js'],
                matches: ['<all_urls>'],
                runAt: 'document_idle',
                allFrames: false,
                persistAcrossSessions: true
            }
        ]);
    } catch (err) {
        console.error('Failed to register keyword content script:', err);
    }
}

// Read current settings, run the legacy→structured migration, and persist the
// result via persist() so both sync and local mirrors stay aligned. Logs a
// dry-run summary of what will change before writing anything so the migration
// is observable in the service-worker console.
async function runSchemaMigration() {
    const keys = Object.keys(DEFAULTS);
    const current = await chrome.storage.sync.get(keys);

    const next = migrateLegacyBlockedWebsites(current);
    if (next === current) {
        return;
    }

    const beforeRules = Array.isArray(current.rules) ? current.rules.length : 0;
    const afterRules = Array.isArray(next.rules) ? next.rules.length : 0;
    console.log(`Schema migration dry-run: rules ${beforeRules} -> ${afterRules}, schemaVersion -> ${next.schemaVersion}`);

    await persist({ rules: next.rules, schemaVersion: next.schemaVersion });
}

async function initializeMissingDefaults() {
    const existing = await chrome.storage.sync.get(Object.keys(DEFAULTS));
    const toSet = {};
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (existing[key] === undefined) {
            toSet[key] = value;
        }
    }
    if (Object.keys(toSet).length > 0) {
        await persist(toSet);
        console.log('Initialized missing storage defaults:', Object.keys(toSet));
    }
}

// Mirror writes to chrome.storage.local so we always have a per-device backup
// that survives sync quota errors, sync conflicts, and Chrome sign-out.
async function persist(data) {
    await Promise.all([
        chrome.storage.sync.set(data),
        chrome.storage.local.set(data)
    ]);
}

// On every service-worker startup, if sync lost data that local still has,
// copy local back into sync. This is the recovery path after a sync hiccup.
async function restoreFromLocalIfSyncEmpty() {
    const keys = Object.keys(DEFAULTS);
    const [sync, local] = await Promise.all([
        chrome.storage.sync.get(keys),
        chrome.storage.local.get(keys)
    ]);
    const restore = {};
    for (const key of keys) {
        if (sync[key] === undefined && local[key] !== undefined) {
            restore[key] = local[key];
        }
    }
    if (Object.keys(restore).length > 0) {
        await chrome.storage.sync.set(restore);
        console.log('Restored from local backup:', Object.keys(restore));
    }
}

chrome.runtime.onStartup.addListener(async () => {
    await restoreFromLocalIfSyncEmpty();
    await runSchemaMigration();
    await ensureKeywordContentScriptRegistered();
    updateRedirectRules();
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'updateRules') {
        const opts = {
            mode: MODES.includes(request.mode) ? request.mode : 'blocklist',
            alwaysAllowed: Array.isArray(request.alwaysAllowed) ? request.alwaysAllowed : []
        };
        updateRedirectRulesFromMessage(request.rules || [], request.redirectUrl, opts);
        sendResponse({ success: true });
        return;
    }
    if (request.action === 'keywordHit') {
        // The content script found a keyword in the page title/body. DNR can't
        // match those so we drive the redirect from here. We re-read storage
        // so the redirect URL reflects the very latest value, not whatever
        // shape the page was loaded with.
        handleKeywordHit(sender, request)
            .then(() => sendResponse({ success: true }))
            .catch(err => {
                console.error('keywordHit handler error:', err);
                sendResponse({ success: false, error: String(err && err.message || err) });
            });
        return true; // keep the message channel open for the async response
    }
});

async function handleKeywordHit(sender, request) {
    if (!sender || !sender.tab || typeof sender.tab.id !== 'number') return;
    const settings = await chrome.storage.sync.get(['redirectUrl', 'extensionEnabled']);
    if (settings.extensionEnabled === false) return;
    const target = settings.redirectUrl || 'https://www.google.com';
    await chrome.tabs.update(sender.tab.id, { url: target });
}

async function updateRedirectRules() {
    try {
        const result = await chrome.storage.sync.get([
            'rules', 'redirectUrl', 'extensionEnabled', 'mode', 'alwaysAllowed'
        ]);
        const rules = Array.isArray(result.rules) ? result.rules : [];
        const redirectUrl = result.redirectUrl || 'https://www.google.com';
        const isEnabled = result.extensionEnabled !== false;
        const mode = MODES.includes(result.mode) ? result.mode : 'blocklist';
        const alwaysAllowed = Array.isArray(result.alwaysAllowed) ? result.alwaysAllowed : [];

        if (!isEnabled) {
            // Clear all rules if extension is disabled
            await clearAllRules();
            return;
        }

        await createRedirectRules(rules, redirectUrl, { mode, alwaysAllowed });
    } catch (error) {
        console.error('Error updating redirect rules:', error);
    }
}

async function updateRedirectRulesFromMessage(rules, redirectUrl, opts) {
    try {
        await createRedirectRules(rules, redirectUrl, opts || {});
    } catch (error) {
        console.error('Error updating redirect rules from message:', error);
    }
}

/*
 * DNR rule-ID layout
 * ------------------
 * Each source Rule reserves a block of 100 IDs so different rule types can
 * coexist without colliding, and so future types can claim their own offset
 * without another renumber. Source-rule IDs start at 100 (sourceIndex 0 -> 100)
 * so the [1, 99] range is reserved for global allowlist-mode rules.
 *
 *     dnrId = (sourceIndex + 1) * 100 + typeOffset + variantOffset
 *
 * Type offsets (must stay stable — DNR persists IDs between worker restarts):
 *
 *     domain   : offset  0   variants 0..3 (subdomain, bare, exact, www-exact)
 *     wildcard : offset 10   variants 0     (single rule using pattern as urlFilter)
 *     path     : offset 20   variants 0..1  (bare-host and www-host path match)
 *     keyword  : offset 30   variants 0     (urlFilter is *<keyword>* — title
 *                                            and body matches are handled by
 *                                            content.js, not DNR)
 *     <future> : offset 40+  reserved for regex et al.
 *
 * If you add a new type, claim the next free offset and document it here. If a
 * type needs more than 10 variants, widen the offset spacing — never overlap.
 *
 * Reserved global IDs (allowlist mode):
 *
 *     1     catch-all redirect rule (priority 1)
 *     2..50 alwaysAllowed[] pinned allow rules (priority 3, sequential)
 *
 * In allowlist mode the catch-all redirect targets every URL; the per-rule
 * allow rules emitted from rules[] keep their normal (sourceIndex+1)*100 IDs
 * but switch action.type from 'redirect' to 'allow' and bump priority to 2 so
 * they win against the catch-all. alwaysAllowed entries win against both.
 */
const DNR_ID_STRIDE = 100;
const DNR_TYPE_OFFSETS = {
    domain: 0,
    wildcard: 10,
    path: 20,
    keyword: 30
};
const DNR_CATCH_ALL_ID = 1;
const DNR_ALWAYS_ALLOWED_ID_BASE = 2;
const DNR_ALWAYS_ALLOWED_MAX = 49; // IDs 2..50 inclusive

// Priority math (higher wins on DNR):
//   1 — catch-all redirect (allowlist mode only)
//   2 — per-Rule allow (allowlist mode)  / per-Rule redirect (blocklist mode)
//   3 — alwaysAllowed pinned allow (both modes; always-on)
const PRIORITY_CATCH_ALL = 1;
const PRIORITY_RULE = 2;
const PRIORITY_ALWAYS_ALLOWED = 3;

// Build the DNR condition variants for a domain pattern (matches the prior
// blocklist layout: subdomain, bare, exact, www-exact). Returned as an array so
// both 'redirect' and 'allow' emitters can share the urlFilter set.
function buildDomainConditions(website) {
    return [
        { urlFilter: `*://*.${website}/*`, resourceTypes: ['main_frame'] },
        { urlFilter: `*://${website}/*`, resourceTypes: ['main_frame'] },
        { urlFilter: `*://${website}`, resourceTypes: ['main_frame'] },
        { urlFilter: `*://www.${website}`, resourceTypes: ['main_frame'] }
    ];
}

async function createRedirectRules(rules, redirectUrl, opts = {}) {
    try {
        // Clear existing rules
        await clearAllRules();

        const mode = MODES.includes(opts.mode) ? opts.mode : 'blocklist';
        const alwaysAllowed = Array.isArray(opts.alwaysAllowed) ? opts.alwaysAllowed : [];

        // Build DNR rules. Disabled source rules are skipped here, not deleted —
        // toggling enabled back to true must restore behaviour without touching
        // storage. Unknown types log a warning so future contributors see they
        // need to wire a generator + reserve an offset above.
        const dnrRules = [];

        if (mode === 'allowlist') {
            // One catch-all redirect at the lowest priority. Per-rule allow
            // entries below override it for the user's permitted patterns.
            dnrRules.push({
                id: DNR_CATCH_ALL_ID,
                priority: PRIORITY_CATCH_ALL,
                action: { type: 'redirect', redirect: { url: redirectUrl } },
                condition: { urlFilter: '*', resourceTypes: ['main_frame'] }
            });
        }

        rules.forEach((rule, index) => {
            if (!rule || rule.enabled === false) {
                return;
            }

            const baseId = (index + 1) * DNR_ID_STRIDE;
            // In blocklist mode the rule redirects to the configured URL; in
            // allowlist mode the same pattern instead becomes a higher-priority
            // 'allow' rule that overrides the catch-all redirect.
            const ruleAction = mode === 'allowlist'
                ? { type: 'allow' }
                : { type: 'redirect', redirect: { url: redirectUrl } };

            if (rule.type === 'domain') {
                const conditions = buildDomainConditions(rule.pattern);
                const offset = baseId + DNR_TYPE_OFFSETS.domain;

                conditions.forEach((condition, variantIdx) => {
                    dnrRules.push({
                        id: offset + variantIdx,
                        priority: PRIORITY_RULE,
                        action: ruleAction,
                        condition
                    });
                });
            } else if (rule.type === 'wildcard') {
                // Wildcards forward the user's pattern straight to DNR. The DNR
                // urlFilter grammar already supports '*' so we don't need to
                // expand variants the way domain does.
                const offset = baseId + DNR_TYPE_OFFSETS.wildcard;
                dnrRules.push({
                    id: offset,
                    priority: PRIORITY_RULE,
                    action: ruleAction,
                    condition: { urlFilter: rule.pattern, resourceTypes: ['main_frame'] }
                });
            } else if (rule.type === 'path') {
                // Path rules block a specific path or query under a host (e.g.
                // "reddit.com/r/funny" or "example.com?v=foo"). We split the
                // stored pattern into host and tail, then emit two DNR rules
                // so the rule matches whether the user typed the bare host or
                // browsed via the www subdomain:
                //
                //   variant 0: *://<host><tail>*    (bare host)
                //   variant 1: *://www.<host><tail>* (www host)
                //
                // For path-form patterns the tail begins with `/` so the
                // resulting filter pins the path segment; for query-form
                // patterns the tail begins with `?` so the filter matches the
                // query right after the host. The trailing `*` keeps deeper
                // paths (or additional query params) under the segment matching
                // too, so reddit.com/r/funny also redirects /r/funny/comments,
                // and example.com?v=foo still matches example.com?v=foo&t=2.
                const offset = baseId + DNR_TYPE_OFFSETS.path;
                const { host, tail } = splitHostAndPath(rule.pattern);
                if (!host) {
                    console.warn(`Skipping malformed path rule "${rule.pattern}" (id=${rule.id}); no host segment.`);
                    return;
                }
                const filterTail = tail || '/';
                dnrRules.push({
                    id: offset,
                    priority: 1,
                    action: { type: 'redirect', redirect: { url: redirectUrl } },
                    condition: { urlFilter: `*://${host}${filterTail}*`, resourceTypes: ['main_frame'] }
                });
                dnrRules.push({
                    id: offset + 1,
                    priority: 1,
                    action: { type: 'redirect', redirect: { url: redirectUrl } },
                    condition: { urlFilter: `*://www.${host}${filterTail}*`, resourceTypes: ['main_frame'] }
                });
            } else if (rule.type === 'keyword') {
                // Keyword rules cover two cases: the keyword appears in the
                // URL (handled here by DNR with a *keyword* substring filter)
                // and the keyword appears in the page <title> or visible body
                // text (handled by content.js, which posts a message to this
                // worker that navigates the tab to redirectUrl). DNR alone
                // cannot inspect the rendered DOM so both paths are needed.
                const keyword = (rule.pattern || '').trim();
                if (!keyword) {
                    return;
                }
                const offset = baseId + DNR_TYPE_OFFSETS.keyword;
                dnrRules.push({
                    id: offset,
                    priority: 1,
                    action: { type: 'redirect', redirect: { url: redirectUrl } },
                    condition: { urlFilter: `*${keyword}*`, resourceTypes: ['main_frame'] }
                });
            } else {
                console.warn(`Skipping rule of unsupported type "${rule.type}" (id=${rule.id}); generator not yet wired.`);
            }
        });

        // alwaysAllowed patterns get the highest priority so they stay reachable
        // in either mode — especially in allowlist where they keep the options
        // page, chrome-extension:// URLs, etc. from being caught by the catch-all.
        const allowedPatterns = alwaysAllowed
            .filter(p => typeof p === 'string' && p.trim().length > 0)
            .slice(0, DNR_ALWAYS_ALLOWED_MAX);

        allowedPatterns.forEach((pattern, idx) => {
            dnrRules.push({
                id: DNR_ALWAYS_ALLOWED_ID_BASE + idx,
                priority: PRIORITY_ALWAYS_ALLOWED,
                action: { type: 'allow' },
                condition: { urlFilter: pattern.trim(), resourceTypes: ['main_frame'] }
            });
        });

        if (dnrRules.length === 0) {
            return;
        }

        // Add rules in batches to avoid hitting limits
        const batchSize = 50;
        for (let i = 0; i < dnrRules.length; i += batchSize) {
            const batch = dnrRules.slice(i, i + batchSize);
            await chrome.declarativeNetRequest.updateDynamicRules({
                addRules: batch
            });
        }

        console.log(
            `Created ${dnrRules.length} DNR rules in ${mode} mode ` +
            `(${rules.length} source rules, ${allowedPatterns.length} always-allowed)`
        );
    } catch (error) {
        console.error('Error creating redirect rules:', error);
    }
}

async function clearAllRules() {
    try {
        // Get existing rules
        const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
        const ruleIds = existingRules.map(rule => rule.id);
        
        if (ruleIds.length > 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: ruleIds
            });
        }
    } catch (error) {
        console.error('Error clearing rules:', error);
    }
}

// Update rules when storage changes. We also mirror sync writes into local so
// the backup stays current even when the popup wrote only to sync.
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'sync') return;
    const watched = ['rules', 'blockedWebsites', 'redirectUrl', 'extensionEnabled', 'mode', 'alwaysAllowed'];
    const relevant = watched.filter(k => k in changes);
    if (relevant.length === 0) return;

    const mirror = {};
    for (const k of relevant) {
        if (changes[k].newValue !== undefined) {
            mirror[k] = changes[k].newValue;
        }
    }
    if (Object.keys(mirror).length > 0) {
        chrome.storage.local.set(mirror);
    }

    updateRedirectRules();
});

// Clicking the toolbar icon opens the settings page in a new tab. We intentionally
// do not declare `default_popup` in the manifest — without that, Chrome fires this
// onClicked event instead of opening a popup.
chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage();
});