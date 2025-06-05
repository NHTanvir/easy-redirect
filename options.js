document.addEventListener('DOMContentLoaded', function() {
    const redirectUrlInput = document.getElementById('redirectUrl');
    const newWebsiteInput = document.getElementById('newWebsite');
    const websiteListDiv = document.getElementById('websiteList');
    const statusDiv = document.getElementById('status');
    const toggleBtn = document.getElementById('toggleBtn');
    const modeBlocklistBtn = document.getElementById('modeBlocklistBtn');
    const modeAllowlistBtn = document.getElementById('modeAllowlistBtn');

    const MODES = ['blocklist', 'allowlist'];

    // Load saved data
    loadData();

    // Event listeners
    document.getElementById('saveRedirectUrl').addEventListener('click', saveRedirectUrl);
    document.getElementById('addWebsite').addEventListener('click', addRule);
    document.getElementById('clearAll').addEventListener('click', clearAllWebsites);
    document.getElementById('toggleBtn').addEventListener('click', toggleExtension);
    modeBlocklistBtn.addEventListener('click', () => switchMode('blocklist'));
    modeAllowlistBtn.addEventListener('click', () => switchMode('allowlist'));

    // Enter key support
    newWebsiteInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            addRule();
        }
    });

    redirectUrlInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            saveRedirectUrl();
        }
    });

    // Rule helpers — kept in options.js (mirrored from background.js factory)
    // so the page can build rule objects without round-tripping to the worker.
    function generateRuleId() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

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
        if (type === 'keyword') {
            rule.caseSensitive = opts.caseSensitive === true;
            rule.wholeWord = opts.wholeWord === true;
            rule.exceptions = Array.isArray(opts.exceptions) ? opts.exceptions.slice() : [];
        }
        return rule;
    }

    function detectRuleType(input) {
        if (input.includes('*')) {
            return 'wildcard';
        }
        // After stripping scheme + leading www, anything containing a "/" or
        // a "?" is a path-style rule (e.g. reddit.com/r/funny,
        // youtube.com/@somechan, example.com?v=foo). The "?" case lets users
        // target a specific query string against the bare host. Bare hosts
        // have neither and fall through to the legacy domain type.
        const stripped = input
            .trim()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '');
        if (stripped.includes('/') || stripped.includes('?')) {
            return 'path';
        }
        // Keyword rules are prefixed with "kw:" — this lets the user block
        // page titles / body text without the input being mistaken for a
        // domain name. e.g. "kw:gambling" blocks any page whose title or
        // visible body contains the word "gambling".
        if (/^kw:/i.test(stripped)) {
            return 'keyword';
        }
        return 'domain';
    }

    function normalizePattern(input, type) {
        if (type === 'wildcard') {
            // Wildcards are passed through with surrounding whitespace stripped;
            // case is preserved because URL paths and query strings are case
            // sensitive in general.
            return input.trim();
        }
        if (type === 'path') {
            // Path rules are stored as `host/path` (or `host?query` for the
            // query-only form): lower-case host, original case for everything
            // to the right because paths and query strings can be case
            // sensitive on origin servers. Strip scheme, leading www, and any
            // trailing slash on the path itself (but never a trailing `?`).
            //
            // Channel-style paths like youtube.com/@somechan and
            // youtube.com/c/somechan must survive verbatim: the `@` prefix and
            // the `/c/` segment are load-bearing for matching the right URL.
            //
            // Query-only patterns like example.com?v=foo skip the slash split
            // and are kept as `host?query`; the matcher knows to splice them
            // back together without injecting a stray `/`.
            const cleaned = input
                .trim()
                .replace(/^https?:\/\//, '')
                .replace(/^www\./, '')
                .replace(/\/$/, '');
            const slash = cleaned.indexOf('/');
            const question = cleaned.indexOf('?');

            // If `?` appears before any `/`, treat the whole tail as the query
            // half of `host?query`. Otherwise fall back to the host/path split.
            if (question !== -1 && (slash === -1 || question < slash)) {
                const host = cleaned.slice(0, question).toLowerCase();
                const query = cleaned.slice(question); // include the leading "?"
                return `${host}${query}`;
            }
            if (slash === -1) {
                return cleaned.toLowerCase();
            }
            const host = cleaned.slice(0, slash).toLowerCase();
            const path = cleaned.slice(slash + 1);
            return `${host}/${path}`;
        }
        if (type === 'keyword') {
            // Strip the "kw:" prefix and normalise to lower-case. Keywords are
            // matched case-insensitively by default (caseSensitive:false) so
            // storing in lower-case keeps the stored form predictable.
            return input.trim().replace(/^kw:/i, '').trim().toLowerCase();
        }
        // Domain rules are stored bare (no scheme, no www, no trailing slash).
        return input
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/\/$/, '');
    }

    async function loadData() {
        try {
            const result = await chrome.storage.sync.get([
                'redirectUrl', 'rules', 'extensionEnabled', 'mode', 'alwaysAllowed'
            ]);

            redirectUrlInput.value = result.redirectUrl || 'https://www.google.com';

            const rules = Array.isArray(result.rules) ? result.rules : [];
            displayRules(rules);

            const isEnabled = result.extensionEnabled !== false; // Default to true
            updateToggleButton(isEnabled);

            const mode = MODES.includes(result.mode) ? result.mode : 'blocklist';
            updateModeButtons(mode);
            document.getElementById('rulesHeading').textContent =
                mode === 'allowlist' ? 'Allowed Sites (Allowlist mode)' : 'Block Rules';
        } catch (error) {
            showStatus('Error loading data: ' + error.message, 'error');
        }
    }

    function updateModeButtons(mode) {
        const isAllow = mode === 'allowlist';
        modeBlocklistBtn.classList.toggle('active', !isAllow);
        modeAllowlistBtn.classList.toggle('active', isAllow);
    }

    async function switchMode(targetMode) {
        if (!MODES.includes(targetMode)) {
            return;
        }
        try {
            const result = await chrome.storage.sync.get(['mode']);
            const currentMode = MODES.includes(result.mode) ? result.mode : 'blocklist';
            if (currentMode === targetMode) {
                return;
            }

            if (targetMode === 'allowlist') {
                const ok = confirm(
                    'Switch to allowlist mode?\n\n' +
                    'Every site will be redirected EXCEPT the ones you have listed. ' +
                    'This is destructive to general browsing. Your existing rules are kept; ' +
                    'they will now act as exceptions rather than blocks.'
                );
                if (!ok) return;
            }

            await chrome.storage.sync.set({ mode: targetMode });
            await updateRedirectRules();
            updateModeButtons(targetMode);
            document.getElementById('rulesHeading').textContent =
                targetMode === 'allowlist' ? 'Allowed Sites (Allowlist mode)' : 'Block Rules';
            showStatus(`Switched to ${targetMode} mode.`, 'success');
        } catch (error) {
            showStatus('Error switching mode: ' + error.message, 'error');
        }
    }

    async function saveRedirectUrl() {
        const url = redirectUrlInput.value.trim();

        if (!url) {
            showStatus('Please enter a redirect URL', 'error');
            return;
        }

        // Add protocol if missing
        let formattedUrl = url;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            formattedUrl = 'https://' + url;
        }

        try {
            await chrome.storage.sync.set({ redirectUrl: formattedUrl });
            await updateRedirectRules();
            showStatus('Redirect URL saved successfully!', 'success');
            redirectUrlInput.value = formattedUrl;
        } catch (error) {
            showStatus('Error saving redirect URL: ' + error.message, 'error');
        }
    }

    function validateInput(raw) {
        if (!raw || !raw.trim()) {
            return 'Please enter a website or pattern.';
        }
        if (/\s/.test(raw)) {
            return 'Patterns cannot contain whitespace.';
        }
        const trimmed = raw.trim();
        // Reject "just stars" patterns — they would block literally every URL
        // and almost certainly aren't what the user meant.
        if (/^\*+$/.test(trimmed)) {
            return 'Pattern cannot be only "*". Use something like *.example.com/*.';
        }
        // Reject lone-slash path patterns — "example.com/" with nothing after
        // the slash normalises to a plain domain rule, which confuses users who
        // expect path scoping. Tell them to omit the trailing slash.
        if (/^https?:\/\//i.test(trimmed) === false && /^[^/*?]+\/$/.test(trimmed)) {
            return 'Remove the trailing slash — use "example.com" to block the whole domain.';
        }
        // Keyword rules must have at least 3 characters after the "kw:" prefix
        // so they don't match unintentionally short substrings across all pages.
        if (/^kw:/i.test(trimmed)) {
            const kw = trimmed.replace(/^kw:/i, '').trim();
            if (kw.length < 3) {
                return 'Keyword must be at least 3 characters (e.g. kw:gambling).';
            }
        }
        return null;
    }

    async function addRule() {
        const raw = newWebsiteInput.value;
        const validationError = validateInput(raw);
        if (validationError) {
            showStatus(validationError, 'error');
            return;
        }

        const type = detectRuleType(raw);
        const pattern = normalizePattern(raw, type);

        try {
            const result = await chrome.storage.sync.get(['rules']);
            const rules = Array.isArray(result.rules) ? result.rules : [];

            if (rules.some(r => r.pattern === pattern && r.type === type)) {
                showStatus('That rule is already in the list', 'error');
                return;
            }

            const rule = createRule(pattern, type);
            const next = [...rules, rule];
            await chrome.storage.sync.set({ rules: next });
            await updateRedirectRules();

            displayRules(next);
            newWebsiteInput.value = '';
            showStatus('Rule added successfully!', 'success');
        } catch (error) {
            showStatus('Error adding rule: ' + error.message, 'error');
        }
    }

    async function removeRule(ruleId) {
        try {
            const result = await chrome.storage.sync.get(['rules']);
            const rules = Array.isArray(result.rules) ? result.rules : [];

            const next = rules.filter(r => r.id !== ruleId);
            await chrome.storage.sync.set({ rules: next });
            await updateRedirectRules();

            displayRules(next);
            showStatus('Rule removed successfully!', 'success');
        } catch (error) {
            showStatus('Error removing rule: ' + error.message, 'error');
        }
    }

    async function clearAllWebsites() {
        const result = await chrome.storage.sync.get(['mode']);
        const mode = MODES.includes(result.mode) ? result.mode : 'blocklist';
        const label = mode === 'allowlist' ? 'allowed sites' : 'block rules';
        if (confirm(`Are you sure you want to remove all ${label}?`)) {
            try {
                await chrome.storage.sync.set({ rules: [] });
                await updateRedirectRules();
                displayRules([]);
                showStatus('All rules cleared!', 'success');
            } catch (error) {
                showStatus('Error clearing rules: ' + error.message, 'error');
            }
        }
    }

    async function toggleExtension() {
        try {
            const result = await chrome.storage.sync.get(['extensionEnabled']);
            const isEnabled = result.extensionEnabled !== false;
            const newState = !isEnabled;

            // Only flip the enabled flag — rules and redirectUrl are
            // intentionally preserved so the user's list survives a disable cycle.
            await chrome.storage.sync.set({ extensionEnabled: newState });
            await updateRedirectRules();
            updateToggleButton(newState);

            showStatus(newState ? 'Extension enabled!' : 'Extension disabled!', 'success');
        } catch (error) {
            showStatus('Error toggling extension: ' + error.message, 'error');
        }
    }

    function updateToggleButton(isEnabled) {
        if (isEnabled) {
            toggleBtn.textContent = 'Disable Redirector';
            toggleBtn.classList.remove('disabled');
        } else {
            toggleBtn.textContent = 'Enable Redirector';
            toggleBtn.classList.add('disabled');
        }
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function displayRules(rules) {
        if (!rules || rules.length === 0) {
            websiteListDiv.innerHTML = '<div style="text-align: center; color: #666; font-size: 13px;">No rules configured</div>';
            return;
        }

        const html = rules.map(rule => {
            const badgeClass = rule.type === 'wildcard' ? 'badge badge-wildcard'
                : rule.type === 'path' ? 'badge badge-path'
                : rule.type === 'keyword' ? 'badge badge-keyword'
                : 'badge badge-domain';
            const badgeLabel = (rule.type || 'domain').toUpperCase();
            return `
                <div class="website-item" data-rule-id="${escapeHtml(rule.id)}">
                    <span class="rule-meta">
                        <span class="${badgeClass}">${badgeLabel}</span>
                        <span class="rule-pattern">${escapeHtml(rule.pattern)}</span>
                    </span>
                    <button class="remove-btn" data-rule-id="${escapeHtml(rule.id)}">Remove</button>
                </div>
            `;
        }).join('');

        websiteListDiv.innerHTML = html;

        websiteListDiv.querySelectorAll('.remove-btn').forEach(btn => {
            btn.addEventListener('click', () => removeRule(btn.dataset.ruleId));
        });
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

            // Send message to background script to update rules
            chrome.runtime.sendMessage({
                action: 'updateRules',
                rules: isEnabled ? rules : [],
                redirectUrl: redirectUrl,
                mode: mode,
                alwaysAllowed: alwaysAllowed
            });
        } catch (error) {
            console.error('Error updating redirect rules:', error);
        }
    }

    function showStatus(message, type) {
        statusDiv.textContent = message;
        statusDiv.className = `status ${type}`;
        statusDiv.style.display = 'block';

        setTimeout(() => {
            statusDiv.style.display = 'none';
        }, 3000);
    }

    // Expose removeRule for any external callers / debugging.
    window.removeRule = removeRule;
});
