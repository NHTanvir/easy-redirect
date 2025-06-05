// Background script for Website Redirector extension

chrome.runtime.onInstalled.addListener(() => {
    console.log('Website Redirector extension installed');
    
    // Set default values
    chrome.storage.sync.set({
        redirectUrl: 'https://www.google.com',
        blockedWebsites: [],
        extensionEnabled: true
    });
    
    // Initialize redirect rules
    updateRedirectRules();
});

chrome.runtime.onStartup.addListener(() => {
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

// Update rules when storage changes
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && (changes.blockedWebsites || changes.redirectUrl || changes.extensionEnabled)) {
        updateRedirectRules();
    }
});