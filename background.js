// Background script for Website Redirector extension

// Bump SCHEMA_VERSION whenever the persisted shape of `rules` changes in a way
// that needs a one-shot migration. Code that reads from storage compares against
// settings.schemaVersion to decide whether to migrate before reading.
const SCHEMA_VERSION = 2;

// URL opened in the browser when the extension is uninstalled. Chrome's DNR
// does not expose a built-in survey flow so we set this via
// chrome.runtime.setUninstallURL on install and startup (the URL is reset on
// every Chrome restart so we must re-register it on startup too).
// Override DEFAULT_UNINSTALL_URL by saving a custom URL to
// chrome.storage.sync under the key 'uninstallUrl'.
const DEFAULT_UNINSTALL_URL = 'https://forms.gle/easyredirect-uninstall';

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
const RULE_TYPES = ['domain', 'wildcard', 'path', 'keyword', 'regex'];

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
    schemaVersion: 1,
    // Named groups that rules can be organised into. Always has at least one
    // entry (the 'default' group) so rules with groupId='default' always have
    // a home. Participates in persist() and restoreFromLocalIfSyncEmpty() like
    // every other key in DEFAULTS.
    groups: [{ id: 'default', name: 'Default', color: '#2196F3', enabled: true, redirectUrl: null }],
    // User theme preference: 'auto' defers to prefers-color-scheme, 'light' forces
    // light regardless of OS setting, 'dark' forces dark regardless of OS setting.
    theme: 'auto',
    // PIN / password protection settings. mode is 'none' (no lock),
    // 'pin' (numeric PIN), or 'password' (arbitrary passphrase). hash and salt
    // are Base64-encoded PBKDF2-SHA256 output and random salt respectively.
    // Stored in chrome.storage.sync so the lock follows the user across devices.
    protection: { mode: 'none', hash: null, salt: null },
    // Random-access-code friction gate (feature #18). When enabled, a randomly
    // generated alphanumeric code of `length` characters must be typed (not
    // pasted) into the Add Rule input before any rule can be saved. Length is
    // configurable between 32 and 256 characters (default 64). Stored in
    // chrome.storage.sync so the setting follows the user across devices.
    accessCode: { enabled: false, length: 64 },
    // URL to open when the extension is uninstalled (feature #19). Defaults to
    // DEFAULT_UNINSTALL_URL. The user can override this in the options page.
    // Empty string means use the DEFAULT_UNINSTALL_URL constant.
    uninstallUrl: ''
};

// Daily quota counts. Stored in chrome.storage.local (not sync) because they
// are per-device runtime state that resets every midnight UTC. The shape is:
//   { date: "YYYY-MM-DD", counts: { [ruleId]: number } }
// A mismatched date means the counts are stale and should be zeroed out.
const DAILY_COUNTS_DEFAULT = { date: null, counts: {} };

// Return today's date in YYYY-MM-DD format (UTC).
function todayUTC() {
    return new Date().toISOString().slice(0, 10);
}

// Read the current dailyCounts from chrome.storage.local. If the stored date
// does not match today (UTC), the counts are stale: return a fresh zero object.
async function getDailyCounts() {
    const result = await chrome.storage.local.get(['dailyCounts']);
    const stored = result.dailyCounts || DAILY_COUNTS_DEFAULT;
    const today = todayUTC();
    if (stored.date !== today) {
        return { date: today, counts: {} };
    }
    return stored;
}

// Persist dailyCounts to chrome.storage.local.
async function saveDailyCounts(dc) {
    await chrome.storage.local.set({ dailyCounts: dc });
}

// Compute the number of milliseconds until the next midnight UTC. Used to
// schedule the daily-quota reset alarm precisely at the day boundary.
function msUntilMidnightUTC() {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return midnight.getTime() - Date.now();
}

// Schedule the 'resetDailyQuota' alarm to fire at the next midnight UTC.
// If an alarm already exists it is replaced so we never end up with duplicates.
async function scheduleMidnightAlarm() {
    const when = Date.now() + msUntilMidnightUTC();
    await chrome.alarms.create('resetDailyQuota', { when });
    console.log(`[daily-quota] Next reset alarm scheduled for ${new Date(when).toISOString()}`);
}

// Handle the 'resetDailyQuota' alarm: wipe the per-rule counts, re-build DNR
// rules (which re-enables any rules that were suspended mid-day), and schedule
// the next midnight alarm.
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'resetDailyQuota') return;
    const fresh = { date: todayUTC(), counts: {} };
    await saveDailyCounts(fresh);
    console.log('[daily-quota] Daily counts reset for', fresh.date);
    await updateRedirectRules();
    await scheduleMidnightAlarm();
});

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
        lastHitAt: opts.lastHitAt || null,
        // Daily quota: maximum redirects allowed per calendar day (UTC). null
        // means no limit. When the day's hit count reaches this value the rule's
        // DNR entries are removed until the midnight alarm resets dailyCounts.
        quota: opts.quota !== undefined ? opts.quota : null
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

// Factory for the structured Group object that organises rules into named lists.
// Groups can be toggled independently; rules whose groupId matches a disabled
// group are silently skipped at DNR emit time but kept in storage untouched.
// `opts` mirrors the full persisted shape so callers can reconstruct existing
// groups (e.g. during migration) by passing all fields through opts.
function createGroup(name, opts = {}) {
    return {
        id: opts.id || generateRuleId(),
        name: String(name || 'Group').trim() || 'Group',
        color: opts.color || '#2196F3',
        enabled: opts.enabled !== undefined ? opts.enabled : true,
        redirectUrl: opts.redirectUrl || null,
        createdAt: opts.createdAt || Date.now(),
        schedule: opts.schedule || null
    };
}

// ---------------------------------------------------------------------------
// PBKDF2-SHA256 helpers for PIN / password protection (feature #17)
// ---------------------------------------------------------------------------

// Encode a JS string as UTF-8 bytes (Uint8Array).
function strToBytes(str) {
    return new TextEncoder().encode(str);
}

// Encode a Uint8Array as a URL-safe Base64 string.
function bytesToBase64(bytes) {
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary);
}

// Decode a URL-safe Base64 string back to a Uint8Array.
function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

// Derive a PBKDF2-SHA256 key from a passphrase + salt.
// Returns a Uint8Array (32 bytes / 256 bits).
async function deriveKey(passphrase, saltBytes) {
    const keyMaterial = await crypto.subtle.importKey(
        'raw', strToBytes(passphrase), { name: 'PBKDF2' }, false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: 200000 },
        keyMaterial,
        256
    );
    return new Uint8Array(bits);
}

// Hash a passphrase and return { hash, salt } — both Base64 strings — ready
// to persist in chrome.storage.sync as protection.hash / protection.salt.
// A fresh 16-byte random salt is generated on every call so re-using the same
// passphrase produces a different hash each time (safe for storage).
async function hashPin(passphrase) {
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const hashBytes = await deriveKey(passphrase, saltBytes);
    return { hash: bytesToBase64(hashBytes), salt: bytesToBase64(saltBytes) };
}

// Verify a passphrase against a stored { hash, salt } pair (both Base64).
// Returns true if the passphrase is correct, false otherwise.
async function verifyPin(passphrase, storedHash, storedSalt) {
    try {
        const saltBytes = base64ToBytes(storedSalt);
        const derivedBytes = await deriveKey(passphrase, saltBytes);
        const derivedB64 = bytesToBase64(derivedBytes);
        return derivedB64 === storedHash;
    } catch (_) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Random access code generation (feature #18)
// ---------------------------------------------------------------------------

// Characters used when building a random access code. The set intentionally
// omits visually ambiguous pairs (0/O, 1/l/I) so the user can read and type
// the code accurately from a screen. 56 unique chars give enough entropy even
// at minimum length 32 (log2(56^32) ≈ 186 bits).
const ACCESS_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

// Generate a cryptographically random access code of exactly `length`
// characters drawn from ACCESS_CODE_CHARS. Falls back to Math.random if
// crypto.getRandomValues is unavailable (should never happen in MV3).
function generateAccessCode(length) {
    const len = Math.max(32, Math.min(256, length || 64));
    const chars = ACCESS_CODE_CHARS;
    let result = '';
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const buf = new Uint8Array(len * 2); // oversample to avoid modulo bias
        crypto.getRandomValues(buf);
        for (let i = 0, j = 0; j < len; i++) {
            const val = buf[i % buf.length];
            if (val < Math.floor(256 / chars.length) * chars.length) {
                result += chars[val % chars.length];
                j++;
            }
        }
    } else {
        for (let i = 0; i < len; i++) {
            result += chars[Math.floor(Math.random() * chars.length)];
        }
    }
    return result;
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

async function registerContextMenus() {
    chrome.contextMenus.removeAll(async () => {
        // Parent items
        chrome.contextMenus.create({ id: 'block-site', title: 'Block this site', contexts: ['page','link'] });
        chrome.contextMenus.create({ id: 'block-url',  title: 'Block this URL',  contexts: ['page','link'] });

        // Group submenu under block-site
        const result = await chrome.storage.sync.get(['groups']);
        const groups = Array.isArray(result.groups) ? result.groups : [{ id: 'default', name: 'Default' }];
        groups.forEach(g => {
            chrome.contextMenus.create({
                id: `block-site-group-${g.id}`,
                parentId: 'block-site',
                title: `→ ${g.name}`,
                contexts: ['page','link']
            });
        });
    });
}

// Read the stored uninstall URL (may be customised by the user) and call
// chrome.runtime.setUninstallURL. Must be called on both onInstalled and
// onStartup because Chrome resets the URL on browser restart.
async function registerUninstallUrl() {
    try {
        const result = await chrome.storage.sync.get(['uninstallUrl']);
        const url = (typeof result.uninstallUrl === 'string' && result.uninstallUrl.trim())
            ? result.uninstallUrl.trim()
            : DEFAULT_UNINSTALL_URL;
        await chrome.runtime.setUninstallURL(url);
    } catch (err) {
        console.warn('[easy-redirect] setUninstallURL failed:', err);
    }
}

chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('Website Redirector onInstalled:', details.reason);

    registerUninstallUrl();

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
    registerContextMenus();
    scheduleMidnightAlarm();
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
//
// Also backfills groupId='default' on any rules that are missing it (e.g.
// rules created before #7) and ensures the groups[] array always contains at
// least the Default group so rules with groupId='default' always have a home.
async function runSchemaMigration() {
    const keys = Object.keys(DEFAULTS);
    const current = await chrome.storage.sync.get(keys);

    let next = migrateLegacyBlockedWebsites(current);

    // Backfill groupId='default' on rules that predate groups (created before #7).
    const existingRules = Array.isArray(next.rules) ? next.rules : [];
    const rulesNeedGroupId = existingRules.some(r => !r.groupId);
    const backfilledRules = rulesNeedGroupId
        ? existingRules.map(r => r.groupId ? r : { ...r, groupId: 'default' })
        : existingRules;

    // Ensure groups[] always has the Default group. If the key is missing or
    // the Default entry was somehow removed, re-insert it at position 0.
    const existingGroups = Array.isArray(next.groups) ? next.groups : [];
    const hasDefault = existingGroups.some(g => g.id === 'default');
    const groups = hasDefault ? existingGroups
        : [createGroup('Default', { id: 'default', color: '#2196F3' }), ...existingGroups];

    const changed = next !== current || rulesNeedGroupId || !hasDefault;
    if (!changed) {
        return;
    }

    next = { ...next, rules: backfilledRules, groups };

    const beforeRules = Array.isArray(current.rules) ? current.rules.length : 0;
    const afterRules = Array.isArray(next.rules) ? next.rules.length : 0;
    console.log(`Schema migration dry-run: rules ${beforeRules} -> ${afterRules}, schemaVersion -> ${next.schemaVersion}, groups -> ${groups.length}`);

    await persist({ rules: next.rules, schemaVersion: next.schemaVersion, groups: next.groups });
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
    registerUninstallUrl(); // Chrome resets the URL on restart; re-register here.
    await restoreFromLocalIfSyncEmpty();
    await runSchemaMigration();
    await ensureKeywordContentScriptRegistered();
    updateRedirectRules();
    registerContextMenus();
    scheduleMidnightAlarm();
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'updateRules') {
        // Defense-in-depth: if protection is active the request must carry a
        // verified token. The options page sets request.protectionOk = true after
        // the user has successfully passed the lock screen (checkLock() resolves).
        // Background.js cannot re-verify the PIN itself — it trusts the page's
        // attestation here — but this gate still blocks unauthenticated callers
        // (e.g. injected scripts or external extensions) that don't know to set
        // the flag. Real PIN verification happens exclusively in options.js.
        chrome.storage.sync.get(['protection'], protResult => {
            const prot = (protResult.protection) || { mode: 'none' };
            if (prot.mode !== 'none' && !request.protectionOk) {
                console.warn('[easy-redirect] updateRules blocked — protection active, protectionOk not set');
                sendResponse({ success: false, error: 'locked' });
                return;
            }
            const opts = {
                mode: MODES.includes(request.mode) ? request.mode : 'blocklist',
                alwaysAllowed: Array.isArray(request.alwaysAllowed) ? request.alwaysAllowed : [],
                groups: Array.isArray(request.groups) ? request.groups : []
            };
            updateRedirectRulesFromMessage(request.rules || [], request.redirectUrl, opts);
            sendResponse({ success: true });
        });
        return true; // keep channel open for async sendResponse
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
            'rules', 'redirectUrl', 'extensionEnabled', 'mode', 'alwaysAllowed', 'groups'
        ]);
        const rules = Array.isArray(result.rules) ? result.rules : [];
        const redirectUrl = result.redirectUrl || 'https://www.google.com';
        const isEnabled = result.extensionEnabled !== false;
        const mode = MODES.includes(result.mode) ? result.mode : 'blocklist';
        const alwaysAllowed = Array.isArray(result.alwaysAllowed) ? result.alwaysAllowed : [];
        const groups = Array.isArray(result.groups) ? result.groups : [];

        if (!isEnabled) {
            // Clear all rules if extension is disabled
            await clearAllRules();
            setActionIcon(false);
            return;
        }

        await createRedirectRules(rules, redirectUrl, { mode, alwaysAllowed, groups });
        setActionIcon(true);
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

// Track per-rule daily hit counts using the declarativeNetRequestFeedback API.
// When a DNR rule fires, reverse the rule ID to find the source rule index:
//   sourceIndex = Math.floor(dnrId / DNR_ID_STRIDE) - 1
// Increment that rule's count in dailyCounts. If the count reaches the rule's
// quota, immediately remove the rule's DNR entries (runtime-only suspension —
// does not touch chrome.storage.sync, so re-enabling at midnight requires no
// user action). Only redirect-action rules are counted; allow rules are skipped.
if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
        // Only count matches for redirect rules (not allow/alwaysAllowed entries).
        const dnrId = info.rule && info.rule.ruleId;
        if (!dnrId || dnrId < 100) return; // global IDs 1..99 are not source rules

        const sourceIndex = Math.floor(dnrId / DNR_ID_STRIDE) - 1;
        if (sourceIndex < 0) return;

        const result = await chrome.storage.sync.get(['rules']);
        const rules = Array.isArray(result.rules) ? result.rules : [];
        const rule = rules[sourceIndex];
        if (!rule || rule.quota === null || rule.quota === undefined) return; // no quota set

        const dc = await getDailyCounts();
        const prev = dc.counts[rule.id] || 0;
        const next = prev + 1;
        dc.counts[rule.id] = next;
        await saveDailyCounts(dc);

        if (next >= rule.quota) {
            // Quota reached: remove this rule's DNR entries without touching sync.
            console.log(`[daily-quota] Quota reached for rule "${rule.pattern}" (${next}/${rule.quota}). Suspending until midnight.`);
            await removeDNREntriesForRule(sourceIndex);
        }
    });
}

// Immediately remove all DNR dynamic rules associated with a single source
// rule index. Called as soon as the daily quota is reached so the rule stops
// redirecting for the rest of the day without waiting for the next full
// updateRedirectRules() call. This is a runtime-only suspension:
// chrome.storage.sync is not touched, so the rule will be re-emitted when the
// midnight alarm fires and getDailyCounts() returns a fresh zeroed object.
async function removeDNREntriesForRule(sourceIndex) {
    try {
        const baseId = (sourceIndex + 1) * DNR_ID_STRIDE;
        // Collect all IDs in the block [baseId, baseId + DNR_ID_STRIDE - 1].
        const existing = await chrome.declarativeNetRequest.getDynamicRules();
        const toRemove = existing
            .map(r => r.id)
            .filter(id => id >= baseId && id < baseId + DNR_ID_STRIDE);
        if (toRemove.length > 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: toRemove });
            console.log(`[daily-quota] Immediately removed ${toRemove.length} DNR entries for source index ${sourceIndex}.`);
        }
    } catch (err) {
        console.error('[daily-quota] Failed to remove DNR entries:', err);
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
    keyword: 30,
    regex: 40
};

// Cap on how many regex rules can be active at once. Chrome's DNR imposes a
// global cap on regex-filter rules (currently 1000 per extension) and they are
// costlier to evaluate than urlFilter rules, so we enforce a conservative local
// limit. Rules beyond the cap are skipped with a console.warn.
const REGEX_RULES_MAX = 10;
const DNR_CATCH_ALL_ID = 1;
const DNR_ALWAYS_ALLOWED_ID_BASE = 2;
const DNR_ALWAYS_ALLOWED_MAX = 49; // IDs 2..50 inclusive

// Exception (allow-rule) offset inside a source rule's 100-ID block.
// Allow rules for exceptions are emitted at offsets 90..99, leaving room for up
// to DNR_MAX_EXCEPTIONS_PER_RULE exceptions per source rule while staying clear
// of the type offsets (currently 0..30). If a rule has more exceptions than the
// cap, the extras are silently ignored with a console.warn.
const DNR_EXCEPTION_OFFSET = 90;
const DNR_MAX_EXCEPTIONS_PER_RULE = 10;

// Priority math (higher wins on DNR):
//   1 — catch-all redirect (allowlist mode only)
//   2 — per-Rule allow (allowlist mode)  / per-Rule redirect (blocklist mode)
//   3 — alwaysAllowed pinned allow (both modes; always-on)
//   4 — per-Rule exception allow (both modes — must beat PRIORITY_RULE redirects)
const PRIORITY_CATCH_ALL = 1;
const PRIORITY_RULE = 2;
const PRIORITY_ALWAYS_ALLOWED = 3;
const PRIORITY_EXCEPTION = 4;

// Build a DNR urlFilter for an exception pattern. Patterns that already contain
// a '*' are treated as verbatim DNR urlFilters (after stripping any http scheme
// prefix); bare host/path strings get a `*://` prefix so they match both http
// and https, and a trailing `*` so sub-paths are also exempt.
function buildExceptionFilter(exception) {
    const trimmed = String(exception || '').trim();
    if (!trimmed) return null;
    if (trimmed.includes('*')) {
        return trimmed.replace(/^https?:\/\//, '');
    }
    const noScheme = trimmed.replace(/^https?:\/\//, '');
    return `*://${noScheme}*`;
}

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

        // Build a lookup map from groupId -> group so we can resolve per-group
        // settings (enabled flag, redirectUrl override) in O(1) per rule. Rules
        // whose groupId does not match any group are treated as belonging to the
        // Default group and are always emitted (safe fallback for old data).
        const groups = Array.isArray(opts.groups) ? opts.groups : [];
        const groupMap = new Map(groups.map(g => [g.id, g]));

        // Read today's per-rule hit counts so quota-exceeded rules can be skipped
        // during DNR emission. This keeps suspended rules out of DNR without
        // touching chrome.storage.sync — they will be re-emitted once the midnight
        // alarm fires and getDailyCounts() returns a fresh zero object.
        const dailyCounts = await getDailyCounts();

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
            // Disabled rules are intentionally skipped here, not deleted — re-enabling restores them without a storage write.
            if (!rule || rule.enabled === false) {
                return;
            }

            // Skip rules whose daily quota has been reached. The rule stays in
            // storage; it will be re-emitted after midnight resets dailyCounts.
            if (rule.quota !== null && rule.quota !== undefined && rule.quota > 0) {
                const todayCount = (dailyCounts.counts && dailyCounts.counts[rule.id]) || 0;
                if (todayCount >= rule.quota) {
                    return;
                }
            }

            // Skip rules whose group is explicitly disabled. Rules with an
            // unknown or missing groupId fall through (treated as Default).
            const group = groupMap.get(rule.groupId);
            if (group && group.enabled === false) {
                return;
            }

            // Redirect URL precedence: rule.redirectUrl > group.redirectUrl > global.
            const effectiveRedirectUrl = (rule.redirectUrl) ||
                (group && group.redirectUrl) ||
                redirectUrl;

            const baseId = (index + 1) * DNR_ID_STRIDE;
            // In blocklist mode the rule redirects to the configured URL; in
            // allowlist mode the same pattern instead becomes a higher-priority
            // 'allow' rule that overrides the catch-all redirect.
            const ruleAction = mode === 'allowlist'
                ? { type: 'allow' }
                : { type: 'redirect', redirect: { url: effectiveRedirectUrl } };

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
            } else if (rule.type === 'regex') {
                // Regex rules use DNR's native regexFilter field. Each source
                // rule maps to a single DNR rule at offset 40. We cap total
                // active regex rules at REGEX_RULES_MAX to stay within Chrome's
                // per-extension regex-rule quota and keep match performance sane.
                // Rules beyond the cap are skipped with a warning; users should
                // be informed by the UI that the cap exists.
                const regexOffset = baseId + DNR_TYPE_OFFSETS.regex;
                const currentRegexCount = dnrRules.filter(r => r.condition && r.condition.regexFilter).length;
                if (currentRegexCount >= REGEX_RULES_MAX) {
                    console.warn(
                        `Regex rule cap (${REGEX_RULES_MAX}) reached. ` +
                        `Skipping regex rule "${rule.pattern}" (id=${rule.id}).`
                    );
                } else {
                    dnrRules.push({
                        id: regexOffset,
                        priority: PRIORITY_RULE,
                        action: ruleAction,
                        condition: {
                            regexFilter: rule.pattern,
                            resourceTypes: ['main_frame'],
                            isUrlFilterCaseSensitive: false
                        }
                    });
                }
            } else {
                console.warn(`Skipping rule of unsupported type "${rule.type}" (id=${rule.id}); generator not yet wired.`);
            }

            // Per-rule exceptions — emitted as PRIORITY_EXCEPTION allow rules so they
            // shadow the parent redirect (or, in allowlist mode, they shadow the
            // catch-all too because PRIORITY_EXCEPTION > PRIORITY_CATCH_ALL). Capped
            // at DNR_MAX_EXCEPTIONS_PER_RULE; extras are logged and dropped.
            const exceptions = Array.isArray(rule.exceptions) ? rule.exceptions : [];
            if (exceptions.length > DNR_MAX_EXCEPTIONS_PER_RULE) {
                console.warn(`Rule "${rule.pattern}" has ${exceptions.length} exceptions; only the first ${DNR_MAX_EXCEPTIONS_PER_RULE} will be active.`);
            }
            exceptions.slice(0, DNR_MAX_EXCEPTIONS_PER_RULE).forEach((exc, excIdx) => {
                const urlFilter = buildExceptionFilter(exc);
                if (!urlFilter) return;
                dnrRules.push({
                    id: baseId + DNR_EXCEPTION_OFFSET + excIdx,
                    priority: PRIORITY_EXCEPTION,
                    action: { type: 'allow' },
                    condition: { urlFilter, resourceTypes: ['main_frame'] }
                });
            });
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
    const watched = ['rules', 'blockedWebsites', 'redirectUrl', 'extensionEnabled', 'mode', 'alwaysAllowed', 'groups'];
    const relevant = watched.filter(k => k in changes);
    // Also mirror uninstallUrl changes to local storage and re-register.
    if ('uninstallUrl' in changes) {
        const newUrl = changes.uninstallUrl.newValue;
        if (newUrl !== undefined) chrome.storage.local.set({ uninstallUrl: newUrl });
        registerUninstallUrl();
    }
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

    if ('extensionEnabled' in changes) { setActionIcon(changes.extensionEnabled.newValue !== false); }

    updateRedirectRules();
});

// Clicking the toolbar icon opens the settings page in a new tab. We intentionally
// do not declare `default_popup` in the manifest — without that, Chrome fires this
// onClicked event instead of opening a popup.
chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage();
});

// Placeholder for the lockdown check that #11 will wire. Returns false until
// the real implementation lands so the toggle shortcut behaves normally.
function isLockedDown() { return false; /* wired in #11 */ }

chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'open-settings') {
        chrome.runtime.openOptionsPage();
    }
    if (command === 'toggle-extension') {
        // TODO: check lockdown state when #11 lands — if locked, skip toggle
        if (isLockedDown()) return;
        const result = await chrome.storage.sync.get(['extensionEnabled']);
        const isEnabled = result.extensionEnabled !== false;
        const newState = !isEnabled;
        await persist({ extensionEnabled: newState });
        setActionIcon(newState);
        updateRedirectRules();
    }
});

function setActionIcon(enabled) {
    const variant = enabled ? '' : '-disabled';
    chrome.action.setIcon({
        path: {
            16: `icons/icon-16${variant}.png`,
            32: `icons/icon-32${variant}.png`,
            48: `icons/icon-48${variant}.png`,
            128: `icons/icon-128${variant}.png`
        }
    });
}

async function addRuleFromBackground(pattern, type, groupId) {
    const result = await chrome.storage.sync.get(['rules']);
    const rules = Array.isArray(result.rules) ? result.rules : [];
    if (rules.some(r => r.pattern === pattern && r.type === type)) return; // already exists
    const rule = createRule(pattern, type, { groupId: groupId || 'default' });
    const next = [...rules, rule];
    await persist({ rules: next });
    updateRedirectRules();
    chrome.notifications.create(`block-confirm-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Easy Redirect',
        message: `Blocked: ${pattern}`
    });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const pageUrl = info.pageUrl || (tab && tab.url) || '';
    if (!pageUrl || pageUrl.startsWith('chrome://') || pageUrl.startsWith('chrome-extension://')) return;

    if (info.menuItemId === 'block-site') {
        try {
            const host = new URL(pageUrl).hostname.replace(/^www\./, '');
            if (host) await addRuleFromBackground(host, 'domain');
        } catch (e) { console.error('context menu block-site:', e); }
    }
    if (info.menuItemId === 'block-url') {
        await addRuleFromBackground(pageUrl, 'wildcard');
    }
    if (info.menuItemId.startsWith('block-site-group-')) {
        const groupId = info.menuItemId.replace('block-site-group-', '');
        try {
            const host = new URL(pageUrl).hostname.replace(/^www\./, '');
            if (host) await addRuleFromBackground(host, 'domain', groupId);
        } catch (e) {}
    }
});