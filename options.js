document.addEventListener('DOMContentLoaded', function() {
    const redirectUrlInput = document.getElementById('redirectUrl');
    const newWebsiteInput = document.getElementById('newWebsite');
    const websiteListDiv = document.getElementById('websiteList');
    const statusDiv = document.getElementById('status');
    const toggleBtn = document.getElementById('toggleBtn');
    const modeBlocklistBtn = document.getElementById('modeBlocklistBtn');
    const modeAllowlistBtn = document.getElementById('modeAllowlistBtn');

    const MODES = ['blocklist', 'allowlist'];

    // Active group state — tracks which group tab is currently selected so
    // displayRules() can filter to only that group's rules. Starts as 'default'
    // and is updated whenever the user clicks a different tab.
    let currentGroups = [];
    let activeGroupId = 'default';

    // Load saved data
    loadData();

    // Event listeners
    document.getElementById('saveRedirectUrl').addEventListener('click', saveRedirectUrl);
    document.getElementById('addWebsite').addEventListener('click', addRule);
    document.getElementById('clearAll').addEventListener('click', clearAllWebsites);
    document.getElementById('toggleBtn').addEventListener('click', toggleExtension);
    modeBlocklistBtn.addEventListener('click', () => switchMode('blocklist'));
    modeAllowlistBtn.addEventListener('click', () => switchMode('allowlist'));
    document.getElementById('regexTestBtn').addEventListener('click', testRegexAgainstUrl);

    const shortcutsLink = document.getElementById('shortcutsLink');
    if (shortcutsLink) {
        shortcutsLink.addEventListener('click', (e) => {
            e.preventDefault();
            chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        });
    }

    // Search input — re-render the list on every keystroke so the filter is live.
    const ruleSearchInput = document.getElementById('ruleSearch');
    if (ruleSearchInput) {
        ruleSearchInput.addEventListener('input', () => {
            chrome.storage.sync.get(['rules'], result => {
                displayRules(Array.isArray(result.rules) ? result.rules : []);
            });
        });
        // Clear search on Escape.
        ruleSearchInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                ruleSearchInput.value = '';
                chrome.storage.sync.get(['rules'], result => {
                    displayRules(Array.isArray(result.rules) ? result.rules : []);
                });
            }
        });
    }

    // Press "/" anywhere on the page to jump focus to the rule search box,
    // unless the user is already typing in another input/textarea.
    document.addEventListener('keydown', function(e) {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        if (ruleSearchInput) {
            ruleSearchInput.focus();
            ruleSearchInput.select();
        }
    });

    // Show the regex test row only when the input looks like a regex rule.
    newWebsiteInput.addEventListener('input', function() {
        const raw = newWebsiteInput.value.trim();
        const isRegex = /^r\//.test(raw) || /^\/.*\/$/.test(raw);
        document.getElementById('regexTestRow').style.display = isRegex ? 'block' : 'none';
        document.getElementById('regexTestResult').textContent = '';
    });

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

    // `enabled` has been in the Rule schema since PR #1 and background.js already
    // skips disabled rules at DNR emit time. This PR adds the UI toggle per row
    // so users can disable individual rules without deleting them.
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
        // All rule types support exceptions[] (mirrors background.js createRule).
        rule.exceptions = Array.isArray(opts.exceptions) ? opts.exceptions.slice() : [];
        if (type === 'keyword') {
            rule.caseSensitive = opts.caseSensitive === true;
            rule.wholeWord = opts.wholeWord === true;
        }
        return rule;
    }

    // Mirror of background.js createGroup(). Kept in options.js so the page can
    // build group objects locally without round-tripping to the service worker.
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

    function detectRuleType(input) {
        const trimmed = input.trim();
        // Regex rules are prefixed with "r/" (shorthand) or delimited as
        // "/pattern/" (full delimiter form). Both forms signal that the user
        // wants a DNR regexFilter rule rather than a urlFilter rule.
        // Examples: r/facebook\.com, /twitter\.com/
        if (/^r\//.test(trimmed) || /^\/.*\/$/.test(trimmed)) {
            return 'regex';
        }
        if (trimmed.includes('*')) {
            return 'wildcard';
        }
        // After stripping scheme + leading www, anything containing a "/" or
        // a "?" is a path-style rule (e.g. reddit.com/r/funny,
        // youtube.com/@somechan, example.com?v=foo). The "?" case lets users
        // target a specific query string against the bare host. Bare hosts
        // have neither and fall through to the legacy domain type.
        const stripped = trimmed
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
        if (type === 'regex') {
            // Strip the "r/" prefix or surrounding "/" delimiters, leaving the
            // raw regex string that will be passed as regexFilter to DNR.
            const trimmed = input.trim();
            if (/^r\//.test(trimmed)) {
                return trimmed.slice(2); // remove "r/"
            }
            if (/^\/.*\/$/.test(trimmed)) {
                return trimmed.slice(1, -1); // remove leading and trailing "/"
            }
            return trimmed;
        }
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
                'redirectUrl', 'rules', 'extensionEnabled', 'mode', 'alwaysAllowed', 'groups'
            ]);

            redirectUrlInput.value = result.redirectUrl || 'https://www.google.com';

            const rules = Array.isArray(result.rules) ? result.rules : [];

            // Seed group state so renderGroupTabs / displayRules have the full
            // list before any user interaction. Always ensure Default exists.
            currentGroups = Array.isArray(result.groups) ? result.groups : [];
            if (!currentGroups.some(g => g.id === 'default')) {
                currentGroups = [createGroup('Default', { id: 'default', color: '#2196F3' }), ...currentGroups];
            }

            renderGroupTabs(currentGroups);
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

    function renderGroupTabs(groups) {
        const container = document.getElementById('groupTabs');
        if (!container) return;

        container.innerHTML = '';

        groups.forEach(group => {
            // Wrapper holds the tab button plus optional controls for non-default groups.
            const wrapper = document.createElement('span');
            wrapper.style.cssText = 'display:inline-flex;align-items:center;gap:2px;';

            const btn = document.createElement('button');
            btn.className = 'group-tab' + (group.id === activeGroupId ? ' active' : '');
            if (group.enabled === false) {
                btn.style.opacity = '0.45';
                btn.title = `${group.name} (disabled)`;
            }
            btn.style.borderLeftColor = group.color || '#2196F3';
            btn.textContent = group.name;
            btn.dataset.groupId = group.id;
            btn.addEventListener('click', async () => {
                activeGroupId = group.id;
                renderGroupTabs(currentGroups);
                const result = await chrome.storage.sync.get(['rules']);
                displayRules(Array.isArray(result.rules) ? result.rules : []);
                renderGroupRedirectField(group);
            });
            wrapper.appendChild(btn);

            // Toggle + delete controls — only for non-default groups.
            if (group.id !== 'default') {
                const toggleCtrl = document.createElement('button');
                toggleCtrl.style.cssText =
                    'font-size:10px;padding:2px 5px;margin-top:0;background:#78909c;border-radius:10px;';
                toggleCtrl.title = group.enabled === false ? 'Enable group' : 'Disable group';
                toggleCtrl.textContent = group.enabled === false ? '▶' : '⏸';
                toggleCtrl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleGroupEnabled(group.id);
                });
                wrapper.appendChild(toggleCtrl);

                const delCtrl = document.createElement('button');
                delCtrl.style.cssText =
                    'font-size:10px;padding:2px 5px;margin-top:0;background:#f44336;border-radius:10px;';
                delCtrl.title = 'Delete group';
                delCtrl.textContent = '×';
                delCtrl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteGroup(group.id);
                });
                wrapper.appendChild(delCtrl);
            }

            container.appendChild(wrapper);
        });

        // "+" button to create a new group
        const addBtn = document.createElement('button');
        addBtn.className = 'group-tab-add';
        addBtn.textContent = '+ New Group';
        addBtn.addEventListener('click', createNewGroup);
        container.appendChild(addBtn);
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

    // Validate a regex pattern against chrome.declarativeNetRequest.isRegexSupported
    // so we surface a user-friendly error before the rule reaches DNR. Falls back
    // to a plain JS RegExp compile check when the DNR API is unavailable (e.g.
    // in tests or older Chrome builds).
    async function validateRegex(pattern) {
        if (!pattern || !pattern.trim()) {
            return 'Regex pattern cannot be empty.';
        }
        try {
            if (chrome.declarativeNetRequest && typeof chrome.declarativeNetRequest.isRegexSupported === 'function') {
                const result = await chrome.declarativeNetRequest.isRegexSupported({
                    regex: pattern,
                    isCaseSensitive: false
                });
                if (!result.isSupported) {
                    return `Regex not supported by Chrome DNR: ${result.reason || 'unknown reason'}`;
                }
                return null;
            }
        } catch (_e) {
            // Fall through to JS-level check
        }
        try {
            new RegExp(pattern); // eslint-disable-line no-new
        } catch (err) {
            return `Invalid regex: ${err.message}`;
        }
        return null;
    }

    // Test the regex currently in the input box against a user-supplied sample URL.
    // Provides instant feedback before committing the rule to storage.
    function testRegexAgainstUrl() {
        const raw = newWebsiteInput.value.trim();
        const pattern = normalizePattern(raw, 'regex');
        const testUrl = document.getElementById('regexTestUrl').value.trim();
        const resultDiv = document.getElementById('regexTestResult');

        if (!pattern) {
            resultDiv.textContent = 'Enter a regex pattern first.';
            resultDiv.style.color = '#c62828';
            return;
        }
        if (!testUrl) {
            resultDiv.textContent = 'Enter a URL to test against.';
            resultDiv.style.color = '#c62828';
            return;
        }
        try {
            const re = new RegExp(pattern, 'i');
            const matched = re.test(testUrl);
            resultDiv.textContent = matched
                ? `Matches — this URL would be redirected.`
                : `No match — this URL would NOT be redirected.`;
            resultDiv.style.color = matched ? '#155724' : '#856404';
        } catch (err) {
            resultDiv.textContent = `Invalid regex: ${err.message}`;
            resultDiv.style.color = '#c62828';
        }
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

        // Regex patterns require an extra async validation step against DNR.
        if (type === 'regex') {
            const regexError = await validateRegex(pattern);
            if (regexError) {
                showStatus(regexError, 'error');
                return;
            }
        }

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

    function validateException(exc, parentRule) {
        if (!exc || !exc.trim()) return 'Exception cannot be empty.';
        if (/\s/.test(exc) && !/^kw:/i.test(exc)) return 'Exceptions cannot contain whitespace (use %20 for URL spaces).';
        // For domain rules, validate that the exception is a sub-path or
        // subdomain of the parent — a completely unrelated domain would never
        // be reached by the parent redirect so the exception would do nothing.
        if (parentRule && parentRule.type === 'domain') {
            const parent = parentRule.pattern;
            const cleaned = exc.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/^\*\*?\./, '');
            if (!cleaned.startsWith(parent) && !cleaned.includes(`.${parent}`)) {
                return `Exception "${exc}" does not appear to fall under "${parent}". It will still be saved but may have no effect.`;
            }
        }
        return null;
    }

    async function promptAddException(ruleId) {
        const exc = prompt('Add exception — enter a URL, path, or pattern that should NOT be redirected even when the parent rule matches:\n(e.g. reddit.com/r/programming  or  *.reddit.com/r/aww/*)');
        if (exc === null || !exc.trim()) return;
        await addException(ruleId, exc.trim());
    }

    async function addException(ruleId, exception) {
        try {
            const result = await chrome.storage.sync.get(['rules']);
            const rules = Array.isArray(result.rules) ? result.rules : [];
            const parentRule = rules.find(r => r.id === ruleId);
            const warning = validateException(exception, parentRule);
            if (warning) {
                showStatus(warning, 'error');
                return;
            }
            const next = rules.map(r => {
                if (r.id !== ruleId) return r;
                const exceptions = Array.isArray(r.exceptions) ? r.exceptions : [];
                if (exceptions.includes(exception)) return r;
                return { ...r, exceptions: [...exceptions, exception] };
            });
            await chrome.storage.sync.set({ rules: next });
            await updateRedirectRules();
            displayRules(next);
            showStatus('Exception added.', 'success');
        } catch (error) {
            showStatus('Error adding exception: ' + error.message, 'error');
        }
    }

    async function removeException(ruleId, excIndex) {
        try {
            const result = await chrome.storage.sync.get(['rules']);
            const rules = Array.isArray(result.rules) ? result.rules : [];
            const next = rules.map(r => {
                if (r.id !== ruleId) return r;
                const exceptions = Array.isArray(r.exceptions) ? r.exceptions : [];
                return { ...r, exceptions: exceptions.filter((_, i) => i !== excIndex) };
            });
            await chrome.storage.sync.set({ rules: next });
            await updateRedirectRules();
            displayRules(next);
            showStatus('Exception removed.', 'success');
        } catch (error) {
            showStatus('Error removing exception: ' + error.message, 'error');
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

    // Wrap the first occurrence of `query` in `text` with a <mark> highlight
    // span. Both are compared case-insensitively. Returns the escaped HTML
    // string. If query is empty the plain-escaped text is returned unchanged.
    function highlightMatch(text, query) {
        const escaped = escapeHtml(text);
        if (!query) return escaped;
        const idx = text.toLowerCase().indexOf(query.toLowerCase());
        if (idx === -1) return escaped;
        return (
            escapeHtml(text.slice(0, idx)) +
            '<mark style="background:#fff176;border-radius:2px;padding:0 1px;">' +
            escapeHtml(text.slice(idx, idx + query.length)) +
            '</mark>' +
            escapeHtml(text.slice(idx + query.length))
        );
    }

    function displayRules(allRules) {
        // Filter to only the rules belonging to the active group.
        let rules = (allRules || []).filter(r => {
            const gid = r.groupId || 'default';
            return gid === activeGroupId;
        });

        // Apply search filter: match against pattern and group name (case-insensitive).
        const searchInput = document.getElementById('ruleSearch');
        const searchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';
        if (searchQuery) {
            rules = rules.filter(r => {
                const groupName = (currentGroups.find(g => g.id === (r.groupId || 'default')) || {}).name || '';
                return r.pattern.toLowerCase().includes(searchQuery) ||
                    groupName.toLowerCase().includes(searchQuery);
            });
        }

        // Show or hide bulk actions bar based on whether there are rules to show.
        const bulkActionsEl = document.getElementById('bulkActions');
        if (bulkActionsEl) bulkActionsEl.style.display = rules.length > 0 ? 'flex' : 'none';

        if (rules.length === 0) {
            const emptyMsg = searchQuery
                ? `No rules match "<strong>${escapeHtml(searchQuery)}</strong>"`
                : 'No rules in this group';
            websiteListDiv.innerHTML = `<div style="text-align: center; color: #666; font-size: 13px;">${emptyMsg}</div>`;
            return;
        }

        const html = rules.map(rule => {
            const isEnabled = rule.enabled !== false;
            const badgeClass = rule.type === 'wildcard' ? 'badge badge-wildcard'
                : rule.type === 'path' ? 'badge badge-path'
                : rule.type === 'keyword' ? 'badge badge-keyword'
                : rule.type === 'regex' ? 'badge badge-regex'
                : 'badge badge-domain';
            const badgeLabel = (rule.type || 'domain').toUpperCase();
            const exceptions = Array.isArray(rule.exceptions) ? rule.exceptions : [];
            const exceptionItems = exceptions.map((exc, i) => `
                <span class="exception-tag">
                    ${escapeHtml(exc)}
                    <button class="remove-exception-btn" data-rule-id="${escapeHtml(rule.id)}" data-exc-index="${i}" title="Remove exception">&times;</button>
                </span>
            `).join('');
            // Build group dropdown options for this rule row.
            const groupOptions = currentGroups.map(g =>
                `<option value="${escapeHtml(g.id)}" ${g.id === (rule.groupId || 'default') ? 'selected' : ''}>${escapeHtml(g.name)}</option>`
            ).join('');
            const toggleClass = isEnabled ? 'rule-toggle-btn' : 'rule-toggle-btn rule-disabled-btn';
            return `
                <div class="website-item${isEnabled ? '' : ' rule-disabled'}" data-rule-id="${escapeHtml(rule.id)}">
                    <div class="rule-main-row">
                        <span class="rule-meta">
                            <input type="checkbox" class="rule-select-checkbox" data-rule-id="${escapeHtml(rule.id)}" style="margin:0 4px 0 0;cursor:pointer;" title="Select this rule">
                            <span class="${badgeClass}">${badgeLabel}</span>
                            <span class="rule-pattern">${highlightMatch(rule.pattern, searchQuery)}</span>
                        </span>
                        <span class="rule-actions">
                            <button class="${toggleClass}" data-rule-id="${escapeHtml(rule.id)}" title="${isEnabled ? 'Disable this rule' : 'Enable this rule'}">${isEnabled ? 'On' : 'Off'}</button>
                            <select class="rule-group-select" data-rule-id="${escapeHtml(rule.id)}" title="Move to group">${groupOptions}</select>
                            <button class="add-exception-btn" data-rule-id="${escapeHtml(rule.id)}" title="Add exception">+ except</button>
                            <button class="remove-btn" data-rule-id="${escapeHtml(rule.id)}">Remove</button>
                        </span>
                    </div>
                    ${exceptions.length > 0 ? `<div class="exception-list">${exceptionItems}</div>` : ''}
                </div>
            `;
        }).join('');

        websiteListDiv.innerHTML = html;

        // Wire select-all and per-row checkboxes for bulk operations.
        const selectAll = document.getElementById('selectAllRules');
        const rowCheckboxes = websiteListDiv.querySelectorAll('.rule-select-checkbox');
        if (selectAll) {
            selectAll.checked = false;
            selectAll.addEventListener('change', () => {
                rowCheckboxes.forEach(cb => { cb.checked = selectAll.checked; });
            });
        }
        rowCheckboxes.forEach(cb => {
            cb.addEventListener('change', () => {
                if (selectAll) selectAll.checked = [...rowCheckboxes].every(ch => ch.checked);
            });
        });
        // Wire bulk enable / disable buttons.
        const bulkEnableBtn = document.getElementById('bulkEnableBtn');
        const bulkDisableBtn = document.getElementById('bulkDisableBtn');
        if (bulkEnableBtn) {
            bulkEnableBtn.onclick = () => bulkSetEnabled(rules, true);
        }
        if (bulkDisableBtn) {
            bulkDisableBtn.onclick = () => bulkSetEnabled(rules, false);
        }
        websiteListDiv.querySelectorAll('.rule-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => toggleRule(btn.dataset.ruleId));
        });
        websiteListDiv.querySelectorAll('.remove-btn').forEach(btn => {
            btn.addEventListener('click', () => removeRule(btn.dataset.ruleId));
        });
        websiteListDiv.querySelectorAll('.add-exception-btn').forEach(btn => {
            btn.addEventListener('click', () => promptAddException(btn.dataset.ruleId));
        });
        websiteListDiv.querySelectorAll('.remove-exception-btn').forEach(btn => {
            btn.addEventListener('click', () => removeException(btn.dataset.ruleId, parseInt(btn.dataset.excIndex, 10)));
        });
        // Group dropdown — move a rule to a different group on change.
        websiteListDiv.querySelectorAll('.rule-group-select').forEach(sel => {
            sel.addEventListener('change', () => moveRuleToGroup(sel.dataset.ruleId, sel.value));
        });
    }

    // Set enabled state for all rules that are currently checked in the bulk-
    // select panel. Operates on the global rules array so groups not currently
    // shown are NOT affected — only the rules visible in the current group view.
    async function bulkSetEnabled(visibleRules, enable) {
        const checkboxes = websiteListDiv.querySelectorAll('.rule-select-checkbox:checked');
        const selectedIds = new Set([...checkboxes].map(cb => cb.dataset.ruleId));
        if (selectedIds.size === 0) {
            showStatus('Select at least one rule first.', 'error');
            return;
        }
        try {
            const result = await chrome.storage.sync.get(['rules']);
            const all = Array.isArray(result.rules) ? result.rules : [];
            const next = all.map(r => selectedIds.has(r.id) ? { ...r, enabled: enable } : r);
            await chrome.storage.sync.set({ rules: next });
            await updateRedirectRules();
            displayRules(next);
            showStatus(`${enable ? 'Enabled' : 'Disabled'} ${selectedIds.size} rule(s).`, 'success');
        } catch (error) {
            showStatus('Error updating rules: ' + error.message, 'error');
        }
    }

    // Toggle a rule's enabled flag. Disabled rules are kept in storage but skipped
    // at DNR emit time so users can pause individual rules without losing them.
    async function toggleRule(ruleId) {
        try {
            const result = await chrome.storage.sync.get(['rules']);
            const rules = Array.isArray(result.rules) ? result.rules : [];
            const next = rules.map(r => r.id === ruleId ? { ...r, enabled: r.enabled === false } : r);
            await chrome.storage.sync.set({ rules: next });
            await updateRedirectRules();
            displayRules(next);
        } catch (error) {
            showStatus('Error toggling rule: ' + error.message, 'error');
        }
    }

    // Move a rule to a different group by updating its groupId in storage.
    async function moveRuleToGroup(ruleId, newGroupId) {
        try {
            const result = await chrome.storage.sync.get(['rules']);
            const rules = Array.isArray(result.rules) ? result.rules : [];
            const next = rules.map(r => r.id === ruleId ? { ...r, groupId: newGroupId } : r);
            await chrome.storage.sync.set({ rules: next });
            await updateRedirectRules();
            displayRules(next);
        } catch (error) {
            showStatus('Error moving rule: ' + error.message, 'error');
        }
    }

    // Show or hide the per-group redirect URL field below the group tabs.
    // When the active group has a redirectUrl override set, it is shown in the
    // input; clearing it saves null so the global redirect URL takes over again.
    function renderGroupRedirectField(group) {
        const container = document.getElementById('groupRedirectField');
        if (!container) return;
        if (!group || group.id === 'default') {
            container.style.display = 'none';
            return;
        }
        container.style.display = 'block';
        container.innerHTML = `
            <label style="display:block;margin-bottom:4px;color:#555;">
                Redirect URL for group <strong>${escapeHtml(group.name)}</strong>
                <span style="color:#888;font-weight:normal;">(overrides global; leave blank to use global)</span>
            </label>
            <div style="display:flex;gap:8px;align-items:center;">
                <input type="text" id="groupRedirectInput" value="${escapeHtml(group.redirectUrl || '')}"
                    placeholder="https://example.com/blocked" style="flex:1;margin-top:0;">
                <button id="saveGroupRedirect" style="margin-top:0;white-space:nowrap;">Save</button>
            </div>
            <div style="margin-top:6px;font-size:12px;color:#999;">
                Schedule: <em>(coming soon — scheduled activation is planned for a future release)</em>
            </div>
        `;
        document.getElementById('saveGroupRedirect').addEventListener('click', async () => {
            const raw = (document.getElementById('groupRedirectInput').value || '').trim();
            let url = raw;
            if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'https://' + url;
            }
            try {
                const result = await chrome.storage.sync.get(['groups']);
                const groups = Array.isArray(result.groups) ? result.groups : [];
                const updated = groups.map(g =>
                    g.id === group.id ? { ...g, redirectUrl: url || null } : g
                );
                await chrome.storage.sync.set({ groups: updated });
                currentGroups = updated;
                await updateRedirectRules();
                showStatus(
                    url ? `Redirect URL for "${group.name}" set to ${url}.` : `Redirect URL for "${group.name}" cleared.`,
                    'success'
                );
            } catch (error) {
                showStatus('Error saving group redirect URL: ' + error.message, 'error');
            }
        });
    }

    // Prompt the user for a name and color, then create and persist a new group.
    // Uses the browser's built-in prompt() / confirm() so no extra HTML is needed.
    async function createNewGroup() {
        const name = prompt('Group name:', 'New Group');
        if (name === null) return; // user cancelled
        const trimmedName = name.trim();
        if (!trimmedName) {
            showStatus('Group name cannot be empty.', 'error');
            return;
        }

        const color = prompt('Group color (hex, e.g. #E91E63):', '#2196F3');
        const trimmedColor = (color || '').trim() || '#2196F3';

        const group = createGroup(trimmedName, { color: trimmedColor });

        try {
            const result = await chrome.storage.sync.get(['groups']);
            const groups = Array.isArray(result.groups) ? result.groups : [];
            const next = [...groups, group];
            await chrome.storage.sync.set({ groups: next });
            currentGroups = next;
            activeGroupId = group.id;
            renderGroupTabs(currentGroups);
            const rulesResult = await chrome.storage.sync.get(['rules']);
            displayRules(Array.isArray(rulesResult.rules) ? rulesResult.rules : []);
            showStatus(`Group "${group.name}" created.`, 'success');
        } catch (error) {
            showStatus('Error creating group: ' + error.message, 'error');
        }
    }

    // Delete a group by id. Refuses to delete the 'default' group. All rules
    // belonging to the deleted group are re-homed to 'default' so no user data
    // is lost — this is a move, not a delete.
    async function deleteGroup(groupId) {
        if (groupId === 'default') {
            showStatus('The Default group cannot be deleted.', 'error');
            return;
        }
        const group = currentGroups.find(g => g.id === groupId);
        const groupName = group ? group.name : groupId;
        const ok = confirm(
            `Delete group "${groupName}"?\n\nAll its rules will be moved to the Default group. This cannot be undone.`
        );
        if (!ok) return;

        try {
            const result = await chrome.storage.sync.get(['rules', 'groups']);
            const rules = Array.isArray(result.rules) ? result.rules : [];
            const groups = Array.isArray(result.groups) ? result.groups : [];

            // Move rules from deleted group to 'default'
            const updatedRules = rules.map(r =>
                r.groupId === groupId ? { ...r, groupId: 'default' } : r
            );
            const updatedGroups = groups.filter(g => g.id !== groupId);

            await chrome.storage.sync.set({ rules: updatedRules, groups: updatedGroups });
            await updateRedirectRules();

            currentGroups = updatedGroups;
            if (activeGroupId === groupId) {
                activeGroupId = 'default';
            }
            renderGroupTabs(currentGroups);
            displayRules(updatedRules);
            showStatus(`Group "${groupName}" deleted; its rules moved to Default.`, 'success');
        } catch (error) {
            showStatus('Error deleting group: ' + error.message, 'error');
        }
    }

    // Flip the enabled flag of a non-default group, persist the change, and
    // trigger a DNR rule rebuild so disabled-group rules stop redirecting.
    async function toggleGroupEnabled(groupId) {
        try {
            const result = await chrome.storage.sync.get(['groups']);
            const groups = Array.isArray(result.groups) ? result.groups : [];
            const updated = groups.map(g =>
                g.id === groupId ? { ...g, enabled: g.enabled === false ? true : false } : g
            );
            await chrome.storage.sync.set({ groups: updated });
            currentGroups = updated;
            await updateRedirectRules();
            renderGroupTabs(currentGroups);
            const rulesResult = await chrome.storage.sync.get(['rules']);
            displayRules(Array.isArray(rulesResult.rules) ? rulesResult.rules : []);
            const toggled = updated.find(g => g.id === groupId);
            showStatus(
                `Group "${toggled ? toggled.name : groupId}" ${toggled && toggled.enabled !== false ? 'enabled' : 'disabled'}.`,
                'success'
            );
        } catch (error) {
            showStatus('Error toggling group: ' + error.message, 'error');
        }
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
                alwaysAllowed: alwaysAllowed,
                groups: currentGroups
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
    window.addException = addException;
    window.removeException = removeException;
});
