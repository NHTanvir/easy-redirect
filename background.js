// Background script for Website Redirector extension

// Bump SCHEMA_VERSION whenever the persisted shape of `rules` changes in a way
// that needs a one-shot migration. Code that reads from storage compares against
// settings.schemaVersion to decide whether to migrate before reading.
const SCHEMA_VERSION = 2;

// Rule.type values understood by createRedirectRules. Extended as later PRs land
// (path, keyword, regex). Anything not in this list is rejected by validation.
const RULE_TYPES = ['domain', 'wildcard'];

const DEFAULTS = {
    redirectUrl: 'https://www.google.com',
    blockedWebsites: [],
    rules: [],
    extensionEnabled: true,
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
    return {
        id: opts.id || generateRuleId(),
        pattern,
        type,
        enabled: opts.enabled !== undefined ? opts.enabled : true,
        groupId: opts.groupId || 'default',
        createdAt: opts.createdAt || Date.now(),
        hitCount: opts.hitCount || 0,
        lastHitAt: opts.lastHitAt || null
    };
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
    // top of perfectly good local data.
    await restoreFromLocalIfSyncEmpty();
    await initializeMissingDefaults();

    updateRedirectRules();
});

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
    updateRedirectRules();
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'updateRules') {
        updateRedirectRulesFromMessage(request.blockedWebsites, request.redirectUrl);
        sendResponse({ success: true });
    }
});

async function updateRedirectRules() {
    try {
        const result = await chrome.storage.sync.get(['blockedWebsites', 'redirectUrl', 'extensionEnabled']);
        const blockedWebsites = result.blockedWebsites || [];
        const redirectUrl = result.redirectUrl || 'https://www.google.com';
        const isEnabled = result.extensionEnabled !== false;

        if (!isEnabled) {
            // Clear all rules if extension is disabled
            await clearAllRules();
            return;
        }

        await createRedirectRules(blockedWebsites, redirectUrl);
    } catch (error) {
        console.error('Error updating redirect rules:', error);
    }
}

async function updateRedirectRulesFromMessage(blockedWebsites, redirectUrl) {
    try {
        await createRedirectRules(blockedWebsites, redirectUrl);
    } catch (error) {
        console.error('Error updating redirect rules from message:', error);
    }
}

async function createRedirectRules(blockedWebsites, redirectUrl) {
    try {
        // Clear existing rules
        await clearAllRules();

        if (blockedWebsites.length === 0) {
            return;
        }

        // Create new rules
        const rules = [];
        
        blockedWebsites.forEach((website, index) => {
            // Create rules for different URL patterns
            const baseId = (index + 1) * 10;
            
            // Rule for domain with www
            rules.push({
                id: baseId,
                priority: 1,
                action: {
                    type: 'redirect',
                    redirect: { url: redirectUrl }
                },
                condition: {
                    urlFilter: `*://*.${website}/*`,
                    resourceTypes: ['main_frame']
                }
            });

            // Rule for domain without www
            rules.push({
                id: baseId + 1,
                priority: 1,
                action: {
                    type: 'redirect',
                    redirect: { url: redirectUrl }
                },
                condition: {
                    urlFilter: `*://${website}/*`,
                    resourceTypes: ['main_frame']
                }
            });

            // Rule for exact domain match
            rules.push({
                id: baseId + 2,
                priority: 1,
                action: {
                    type: 'redirect',
                    redirect: { url: redirectUrl }
                },
                condition: {
                    urlFilter: `*://${website}`,
                    resourceTypes: ['main_frame']
                }
            });

            // Rule for www exact domain match
            rules.push({
                id: baseId + 3,
                priority: 1,
                action: {
                    type: 'redirect',
                    redirect: { url: redirectUrl }
                },
                condition: {
                    urlFilter: `*://www.${website}`,
                    resourceTypes: ['main_frame']
                }
            });
        });

        // Add rules in batches to avoid hitting limits
        const batchSize = 50;
        for (let i = 0; i < rules.length; i += batchSize) {
            const batch = rules.slice(i, i + batchSize);
            await chrome.declarativeNetRequest.updateDynamicRules({
                addRules: batch
            });
        }

        console.log(`Created ${rules.length} redirect rules for ${blockedWebsites.length} websites`);
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
    const watched = ['blockedWebsites', 'redirectUrl', 'extensionEnabled'];
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