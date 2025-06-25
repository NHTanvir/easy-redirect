document.addEventListener('DOMContentLoaded', function() {
    const redirectUrlInput = document.getElementById('redirectUrl');
    const newWebsiteInput = document.getElementById('newWebsite');
    const websiteListDiv = document.getElementById('websiteList');
    const statusDiv = document.getElementById('status');
    const toggleBtn = document.getElementById('toggleBtn');
    const modeBlocklistBtn = document.getElementById('modeBlocklistBtn');
    const modeAllowlistBtn = document.getElementById('modeAllowlistBtn');

    const MODES = ['blocklist', 'allowlist'];

    function applyTheme(theme) {
        if (theme === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else if (theme === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
    }

    // Active group state — tracks which group tab is currently selected so
    // displayRules() can filter to only that group's rules. Starts as 'default'
    // and is updated whenever the user clicks a different tab.
    let currentGroups = [];
    let activeGroupId = 'default';

    // ---------------------------------------------------------------------------
    // Lock screen helpers (feature #17)
    // ---------------------------------------------------------------------------

    // Rate-limiting constants for the lock screen:
    //   LOCK_MAX_ATTEMPTS — wrong guesses allowed before a lockout kicks in.
    //   LOCK_BACKOFF_MS   — how long (ms) the user must wait after hitting the cap.
    // Both are stored / read from chrome.storage.local under the 'lockAttempts' key
    // so they survive page refreshes and extension restarts without using sync quota.
    const LOCK_MAX_ATTEMPTS = 10;
    const LOCK_BACKOFF_MS = 60 * 1000; // 60 seconds

    // Encode / decode Base64 (mirrors background.js helpers but runs in the page
    // context so the UI can verify a PIN without round-tripping to the worker).
    function _strToBytes(str) { return new TextEncoder().encode(str); }
    function _bytesToBase64(bytes) {
        let b = ''; bytes.forEach(x => { b += String.fromCharCode(x); }); return btoa(b);
    }
    function _base64ToBytes(b64) {
        const s = atob(b64); const a = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a;
    }
    async function _deriveKey(passphrase, saltBytes) {
        const km = await crypto.subtle.importKey('raw', _strToBytes(passphrase), { name: 'PBKDF2' }, false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: 200000 }, km, 256);
        return new Uint8Array(bits);
    }
    async function _verifyPin(passphrase, storedHash, storedSalt) {
        try {
            const derived = await _deriveKey(passphrase, _base64ToBytes(storedSalt));
            return _bytesToBase64(derived) === storedHash;
        } catch (_) { return false; }
    }

    // Show the lock overlay, focus the input, and wire the submit button / Enter key.
    // Resolves only when the correct passphrase has been entered.
    async function checkLock() {
        const result = await chrome.storage.sync.get(['protection']);
        const prot = result.protection || { mode: 'none', hash: null, salt: null };
        if (prot.mode === 'none' || !prot.hash || !prot.salt) return; // no lock set

        const overlay = document.getElementById('lockOverlay');
        const input = document.getElementById('lockPinInput');
        const errorEl = document.getElementById('lockError');
        const attemptsEl = document.getElementById('lockAttemptsLeft');
        if (!overlay || !input) return;

        overlay.classList.add('visible');
        input.focus();

        // Update attempt display from stored counter.
        function refreshAttemptDisplay() {
            chrome.storage.local.get(['lockAttempts'], lr => {
                const attempts = (lr.lockAttempts || {});
                const remaining = Math.max(0, LOCK_MAX_ATTEMPTS - (attempts.count || 0));
                attemptsEl.textContent = remaining < LOCK_MAX_ATTEMPTS
                    ? `${remaining} attempt${remaining !== 1 ? 's' : ''} remaining`
                    : '';
            });
        }
        refreshAttemptDisplay();

        await new Promise(resolve => {
            async function tryUnlock() {
                errorEl.textContent = '';
                const lr = await new Promise(r => chrome.storage.local.get(['lockAttempts'], r));
                const attempts = lr.lockAttempts || { count: 0, lockedUntil: null };
                // Rate-limit: if locked until a future time, block.
                if (attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
                    const secs = Math.ceil((attempts.lockedUntil - Date.now()) / 1000);
                    errorEl.textContent = `Too many failed attempts. Try again in ${secs}s.`;
                    return;
                }
                const ok = await _verifyPin(input.value, prot.hash, prot.salt);
                if (ok) {
                    // Reset attempt counter on success.
                    await chrome.storage.local.set({ lockAttempts: { count: 0, lockedUntil: null } });
                    overlay.classList.remove('visible');
                    resolve();
                } else {
                    const newCount = (attempts.count || 0) + 1;
                    const lockedUntil = newCount >= LOCK_MAX_ATTEMPTS ? Date.now() + LOCK_BACKOFF_MS : null;
                    await chrome.storage.local.set({ lockAttempts: { count: newCount, lockedUntil } });
                    errorEl.textContent = 'Incorrect PIN or password.';
                    input.value = '';
                    input.focus();
                    refreshAttemptDisplay();
                }
            }
            document.getElementById('lockSubmitBtn').addEventListener('click', tryUnlock);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
        });
    }

    // Load saved data (called after lock check resolves)
    async function init() {
        await checkLock();
        loadData();
    }
    init();

    // Event listeners
    document.getElementById('saveRedirectUrl').addEventListener('click', saveRedirectUrl);
    document.getElementById('addWebsite').addEventListener('click', addRule);
    document.getElementById('clearAll').addEventListener('click', clearAllWebsites);
    document.getElementById('toggleBtn').addEventListener('click', toggleExtension);
    modeBlocklistBtn.addEventListener('click', () => switchMode('blocklist'));
    modeAllowlistBtn.addEventListener('click', () => switchMode('allowlist'));
    document.getElementById('regexTestBtn').addEventListener('click', testRegexAgainstUrl);

    // Wire the 3-way theme toggle — clicking saves to storage and applies immediately.
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const theme = btn.dataset.theme;
            await chrome.storage.sync.set({ theme });
            applyTheme(theme);
            document.querySelectorAll('.theme-btn').forEach(b => {
                b.style.background = 'var(--bg-section)';
                b.style.color = 'var(--text)';
            });
            btn.style.background = 'var(--btn-blue)';
            btn.style.color = '#fff';
        });
    });

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

    // Sort direction toggle button — flips between ascending and descending.
    const sortDirBtn = document.getElementById('sortDirBtn');
    if (sortDirBtn) {
        // Restore persisted direction preference on page load.
        chrome.storage.local.get(['sortDir'], lr => {
            if (lr.sortDir) {
                sortDir = lr.sortDir;
                sortDirBtn.textContent = sortDir === 'asc' ? '↑' : '↓';
            }
        });
        sortDirBtn.addEventListener('click', () => {
            sortDir = sortDir === 'desc' ? 'asc' : 'desc';
            sortDirBtn.textContent = sortDir === 'asc' ? '↑' : '↓';
            chrome.storage.local.set({ sortDir });
            chrome.storage.sync.get(['rules'], result => {
                displayRules(Array.isArray(result.rules) ? result.rules : []);
            });
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
                'redirectUrl', 'rules', 'extensionEnabled', 'mode', 'alwaysAllowed', 'groups', 'theme',
                'accessCode'
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
            const bulkGroupSelect = document.getElementById('bulkGroupSelect');
            if (bulkGroupSelect) {
                bulkGroupSelect.innerHTML = currentGroups.map(g =>
                    `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`
                ).join('');
            }
            displayRules(rules);

            const isEnabled = result.extensionEnabled !== false; // Default to true
            updateToggleButton(isEnabled);

            const mode = MODES.includes(result.mode) ? result.mode : 'blocklist';
            updateModeButtons(mode);
            document.getElementById('rulesHeading').textContent =
                mode === 'allowlist' ? 'Allowed Sites (Allowlist mode)' : 'Block Rules';

            // Apply saved theme preference, highlighting the active toggle button.
            const theme = result.theme || 'auto';
            applyTheme(theme);
            document.querySelectorAll('.theme-btn').forEach(b => {
                if (b.dataset.theme === theme) {
                    b.style.background = 'var(--btn-blue)';
                    b.style.color = '#fff';
                } else {
                    b.style.background = 'var(--bg-section)';
                    b.style.color = 'var(--text)';
                }
            });
        renderCategories();
        loadSecuritySection();
        // Populate access code settings (feature #18).
        const ac = result.accessCode || { enabled: false, length: 64 };
        const acEnabledEl = document.getElementById('accessCodeEnabled');
        const acLengthEl = document.getElementById('accessCodeLength');
        const acLengthDisplay = document.getElementById('accessCodeLengthDisplay');
        const acLengthRow = document.getElementById('accessCodeLengthRow');
        if (acEnabledEl) acEnabledEl.checked = ac.enabled === true;
        if (acLengthEl) acLengthEl.value = Math.max(32, Math.min(256, ac.length || 64));
        if (acLengthDisplay) acLengthDisplay.textContent = acLengthEl ? acLengthEl.value : 64;
        if (acLengthRow) acLengthRow.style.display = (ac.enabled === true) ? 'block' : 'none';
        } catch (error) {
            showStatus('Error loading data: ' + error.message, 'error');
        }
    }

    // ---------------------------------------------------------------------------
    // Security section — set a new PIN/password (feature #17, commit 7)
    // ---------------------------------------------------------------------------

    // Hash a passphrase using PBKDF2-SHA256 (page-context mirror of background.js hashPin).
    async function _hashPin(passphrase) {
        const enc = new TextEncoder();
        function toB64(bytes) {
            let b = ''; bytes.forEach(x => { b += String.fromCharCode(x); }); return btoa(b);
        }
        const saltBytes = crypto.getRandomValues(new Uint8Array(16));
        const km = await crypto.subtle.importKey('raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: 200000 }, km, 256);
        return { hash: toB64(new Uint8Array(bits)), salt: toB64(saltBytes) };
    }

    // Load the current protection state and show the appropriate sub-panel.
    async function loadSecuritySection() {
        const result = await chrome.storage.sync.get(['protection']);
        const prot = result.protection || { mode: 'none', hash: null, salt: null };
        const isLocked = prot.mode !== 'none' && prot.hash && prot.salt;
        const noneEl = document.getElementById('securityNone');
        const activeEl = document.getElementById('securityActive');
        if (!noneEl || !activeEl) return;
        noneEl.style.display = isLocked ? 'none' : 'block';
        activeEl.style.display = isLocked ? 'block' : 'none';
    }

    // Set lock button — validate, hash, and persist.
    const secSetBtn = document.getElementById('secSetBtn');
    if (secSetBtn) {
        secSetBtn.addEventListener('click', async () => {
            const secStatusEl = document.getElementById('secStatus');
            const pin = (document.getElementById('secNewPin') || {}).value || '';
            const confirm = (document.getElementById('secConfirmPin') || {}).value || '';
            if (!pin) { secStatusEl.textContent = 'Please enter a PIN or password.'; secStatusEl.style.color = '#c62828'; return; }
            if (pin !== confirm) { secStatusEl.textContent = 'Entries do not match.'; secStatusEl.style.color = '#c62828'; return; }
            try {
                secSetBtn.disabled = true;
                secStatusEl.textContent = 'Hashing…';
                secStatusEl.style.color = 'var(--text-muted)';
                const { hash, salt } = await _hashPin(pin);
                await chrome.storage.sync.set({ protection: { mode: 'pin', hash, salt } });
                secStatusEl.textContent = 'Lock set successfully.';
                secStatusEl.style.color = '#2e7d32';
                document.getElementById('secNewPin').value = '';
                document.getElementById('secConfirmPin').value = '';
                await loadSecuritySection();
            } catch (err) {
                secStatusEl.textContent = 'Error: ' + err.message;
                secStatusEl.style.color = '#c62828';
            } finally {
                secSetBtn.disabled = false;
            }
        });
    }

    // Change password button — verify current, hash new, persist (feature #17, commit 8).
    const secChangeBtn = document.getElementById('secChangeBtn');
    if (secChangeBtn) {
        secChangeBtn.addEventListener('click', async () => {
            const secStatusEl = document.getElementById('secStatus');
            const current = (document.getElementById('secCurrentPin') || {}).value || '';
            const newPin = (document.getElementById('secNewPin2') || {}).value || '';
            const confirm = (document.getElementById('secConfirmPin2') || {}).value || '';
            if (!current) { secStatusEl.textContent = 'Enter your current password.'; secStatusEl.style.color = '#c62828'; return; }
            if (!newPin) { secStatusEl.textContent = 'Enter a new password.'; secStatusEl.style.color = '#c62828'; return; }
            if (newPin !== confirm) { secStatusEl.textContent = 'New passwords do not match.'; secStatusEl.style.color = '#c62828'; return; }
            try {
                secChangeBtn.disabled = true;
                secStatusEl.textContent = 'Verifying…';
                secStatusEl.style.color = 'var(--text-muted)';
                const pResult = await chrome.storage.sync.get(['protection']);
                const prot = pResult.protection || {};
                const ok = await _verifyPin(current, prot.hash, prot.salt);
                if (!ok) {
                    secStatusEl.textContent = 'Current password is incorrect.';
                    secStatusEl.style.color = '#c62828';
                    return;
                }
                secStatusEl.textContent = 'Hashing new password…';
                const { hash, salt } = await _hashPin(newPin);
                await chrome.storage.sync.set({ protection: { mode: 'pin', hash, salt } });
                secStatusEl.textContent = 'Password changed successfully.';
                secStatusEl.style.color = '#2e7d32';
                document.getElementById('secCurrentPin').value = '';
                document.getElementById('secNewPin2').value = '';
                document.getElementById('secConfirmPin2').value = '';
                const details = document.getElementById('changePasswordDetails');
                if (details) details.removeAttribute('open');
            } catch (err) {
                secStatusEl.textContent = 'Error: ' + err.message;
                secStatusEl.style.color = '#c62828';
            } finally {
                secChangeBtn.disabled = false;
            }
        });
    }

    // Remove lock button — verify current password then clear protection (feature #17, commit 9).
    const secRemoveBtn = document.getElementById('secRemoveBtn');
    if (secRemoveBtn) {
        secRemoveBtn.addEventListener('click', async () => {
            const secStatusEl = document.getElementById('secStatus');
            // Inline prompt: ask for current password before removing.
            const current = window.prompt('Enter your current PIN or password to remove the lock:');
            if (current === null) return; // user cancelled
            try {
                secRemoveBtn.disabled = true;
                secStatusEl.textContent = 'Verifying…';
                secStatusEl.style.color = 'var(--text-muted)';
                const pResult = await chrome.storage.sync.get(['protection']);
                const prot = pResult.protection || {};
                const ok = await _verifyPin(current, prot.hash, prot.salt);
                if (!ok) {
                    secStatusEl.textContent = 'Incorrect password. Lock not removed.';
                    secStatusEl.style.color = '#c62828';
                    return;
                }
                await chrome.storage.sync.set({ protection: { mode: 'none', hash: null, salt: null } });
                secStatusEl.textContent = 'Lock removed.';
                secStatusEl.style.color = '#2e7d32';
                await loadSecuritySection();
            } catch (err) {
                secStatusEl.textContent = 'Error: ' + err.message;
                secStatusEl.style.color = '#c62828';
            } finally {
                secRemoveBtn.disabled = false;
            }
        });
    }

    // ---------------------------------------------------------------------------
    // Access code settings wiring (feature #18, commit 4)
    // ---------------------------------------------------------------------------

    // Show / hide the length slider when the checkbox is toggled.
    const acEnabledEl2 = document.getElementById('accessCodeEnabled');
    const acLengthRowEl = document.getElementById('accessCodeLengthRow');
    if (acEnabledEl2) {
        acEnabledEl2.addEventListener('change', () => {
            if (acLengthRowEl) acLengthRowEl.style.display = acEnabledEl2.checked ? 'block' : 'none';
        });
    }

    // Live-update the length display label as the slider moves.
    const acLengthSlider = document.getElementById('accessCodeLength');
    const acLengthDisplay2 = document.getElementById('accessCodeLengthDisplay');
    if (acLengthSlider && acLengthDisplay2) {
        acLengthSlider.addEventListener('input', () => {
            acLengthDisplay2.textContent = acLengthSlider.value;
        });
    }

    // Save button — persist accessCode settings to chrome.storage.sync.
    const saveAccessCodeBtn = document.getElementById('saveAccessCodeBtn');
    if (saveAccessCodeBtn) {
        saveAccessCodeBtn.addEventListener('click', async () => {
            const statusEl = document.getElementById('accessCodeStatus');
            try {
                const enabled = acEnabledEl2 ? acEnabledEl2.checked : false;
                const length = acLengthSlider ? parseInt(acLengthSlider.value, 10) : 64;
                await chrome.storage.sync.set({ accessCode: { enabled, length } });
                if (statusEl) { statusEl.textContent = 'Saved.'; statusEl.style.color = '#2e7d32'; }
                setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
            } catch (err) {
                if (statusEl) { statusEl.textContent = 'Error: ' + err.message; statusEl.style.color = '#c62828'; }
            }
        });
    }

    // Save button — persist uninstall URL setting to chrome.storage.sync (feature #19).
    const saveUninstallUrlBtn = document.getElementById('saveUninstallUrlBtn');
    if (saveUninstallUrlBtn) {
        saveUninstallUrlBtn.addEventListener('click', async () => {
            const statusEl = document.getElementById('uninstallUrlStatus');
            const inputEl = document.getElementById('uninstallUrlInput');
            const url = inputEl ? inputEl.value.trim() : '';
            // Validate: must be empty (use default) or a valid http(s) URL.
            if (url && !/^https?:\/\//.test(url)) {
                if (statusEl) { statusEl.textContent = 'URL must start with https://'; statusEl.style.color = '#c62828'; }
                return;
            }
            try {
                await chrome.storage.sync.set({ uninstallUrl: url });
                if (statusEl) { statusEl.textContent = 'Saved.'; statusEl.style.color = '#2e7d32'; }
                setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
            } catch (err) {
                if (statusEl) { statusEl.textContent = 'Error: ' + err.message; statusEl.style.color = '#c62828'; }
            }
        });
    }

    // ---------------------------------------------------------------------------
    // Access code challenge helpers (feature #18, commit 5)
    // ---------------------------------------------------------------------------

    // Mirrors background.js ACCESS_CODE_CHARS / generateAccessCode in the page
    // context so the challenge can run without a round-trip to the worker.
    const _AC_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    function _generateCode(length) {
        const len = Math.max(32, Math.min(256, length || 64));
        let result = '';
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            const buf = new Uint8Array(len * 2);
            crypto.getRandomValues(buf);
            for (let i = 0, j = 0; j < len; i++) {
                const val = buf[i % buf.length];
                if (val < Math.floor(256 / _AC_CHARS.length) * _AC_CHARS.length) {
                    result += _AC_CHARS[val % _AC_CHARS.length]; j++;
                }
            }
        } else {
            for (let i = 0; i < len; i++) result += _AC_CHARS[Math.floor(Math.random() * _AC_CHARS.length)];
        }
        return result;
    }

    // Show the access-code challenge and return a Promise that resolves to true
    // when the user correctly types the code, or false if they cancel.
    function _showAccessChallenge(code) {
        return new Promise(resolve => {
            const challengeDiv = document.getElementById('accessCodeChallenge');
            const displayDiv = document.getElementById('accessCodeDisplay');
            const inputEl = document.getElementById('accessCodeInput');
            const confirmBtn = document.getElementById('accessCodeConfirmBtn');
            const cancelBtn = document.getElementById('accessCodeCancelBtn');
            const errorDiv = document.getElementById('accessCodeError');
            if (!challengeDiv || !displayDiv || !inputEl) { resolve(true); return; }

            displayDiv.textContent = code;
            inputEl.value = '';
            if (errorDiv) errorDiv.textContent = '';
            challengeDiv.style.display = 'block';
            inputEl.focus();

            // Disable paste on the input.
            function noPaste(e) { e.preventDefault(); if (errorDiv) errorDiv.textContent = 'Typing only — paste is disabled.'; }
            inputEl.addEventListener('paste', noPaste);

            function cleanup() {
                challengeDiv.style.display = 'none';
                inputEl.removeEventListener('paste', noPaste);
                if (confirmBtn) confirmBtn.removeEventListener('click', onConfirm);
                if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
            }

            function onConfirm() {
                if (inputEl.value === code) {
                    cleanup(); resolve(true);
                } else {
                    if (errorDiv) errorDiv.textContent = 'Code does not match. Keep typing.';
                    inputEl.value = '';
                    inputEl.focus();
                }
            }

            function onCancel() { cleanup(); resolve(false); }

            if (confirmBtn) confirmBtn.addEventListener('click', onConfirm);
            if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
            // Also allow Enter key as confirm.
            inputEl.addEventListener('keydown', function onKey(e) {
                if (e.key === 'Enter') { inputEl.removeEventListener('keydown', onKey); onConfirm(); }
                if (e.key === 'Escape') { inputEl.removeEventListener('keydown', onKey); onCancel(); }
            });
        });
    }

    function renderCategories() {
        const container = document.getElementById('categoryList');
        if (!container || typeof PREBUILT_CATEGORIES === 'undefined') return;
        container.innerHTML = PREBUILT_CATEGORIES.map(cat => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;margin:6px 0;border:1px solid var(--border);border-radius:6px;border-left:4px solid ${escapeHtml(cat.color)};">
                <div>
                    <strong style="font-size:14px;">${escapeHtml(cat.name)}</strong>
                    <div class="help-text" style="margin-top:2px;">${escapeHtml(cat.description)} &middot; ${cat.entries.length} sites</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">${cat.entries.slice(0,4).map(e=>escapeHtml(e)).join(', ')}${cat.entries.length > 4 ? ' …' : ''}</div>
                </div>
                <button class="add-category-btn" data-cat-id="${escapeHtml(cat.id)}" style="flex-shrink:0;margin-left:12px;font-size:13px;padding:6px 14px;">Add all</button>
            </div>
        `).join('');
        container.querySelectorAll('.add-category-btn').forEach(btn => {
            btn.addEventListener('click', () => addCategory(btn.dataset.catId));
        });
    }

    async function addCategory(catId) {
        const cat = (typeof PREBUILT_CATEGORIES !== 'undefined') && PREBUILT_CATEGORIES.find(c => c.id === catId);
        if (!cat) return;

        // Create a new group for this category
        const group = createGroup(cat.name, { color: cat.color });
        const existing = await chrome.storage.sync.get(['rules', 'groups']);
        const rules = Array.isArray(existing.rules) ? existing.rules : [];
        const groups = Array.isArray(existing.groups) ? existing.groups : [createGroup('Default', { id: 'default' })];

        // Add the group
        groups.push(group);

        // Add rules (deduplicate)
        let added = 0;
        for (const entry of cat.entries) {
            if (!rules.some(r => r.pattern === entry && r.type === 'domain')) {
                rules.push(createRule(entry, 'domain', { groupId: group.id }));
                added++;
            }
        }

        await chrome.storage.sync.set({ rules, groups });
        currentGroups = groups;
        await updateRedirectRules();
        displayRules(rules);
        renderGroupTabs(groups);
        showStatus(`Added "${cat.name}" group with ${added} rules.`, 'success');
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

        // Access code friction gate (feature #18): if enabled, show the challenge
        // and abort if the user cancels or fails to type the code correctly.
        const acResult = await chrome.storage.sync.get(['accessCode']);
        const ac = acResult.accessCode || { enabled: false, length: 64 };
        if (ac.enabled) {
            const code = _generateCode(ac.length || 64);
            const passed = await _showAccessChallenge(code);
            if (!passed) return; // user cancelled
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

    // Sort order applied to the rule list. Persisted to chrome.storage.local so it
    // survives page reloads. Default is 'newest' (chronological descending).
    let currentSortOrder = 'newest';
    let sortDir = 'desc'; // 'asc' or 'desc'; flips the sort order

    // Apply the current sort to a rules array. Uses createdAt as a stable
    // secondary key so ties are always broken consistently.
    function sortRules(rules) {
        const arr = rules.slice();
        switch (currentSortOrder) {
            case 'oldest':
                arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
                break;
            case 'az':
                arr.sort((a, b) => a.pattern.localeCompare(b.pattern) || (a.createdAt || 0) - (b.createdAt || 0));
                break;
            case 'za':
                arr.sort((a, b) => b.pattern.localeCompare(a.pattern) || (a.createdAt || 0) - (b.createdAt || 0));
                break;
            case 'most-blocked':
                arr.sort((a, b) => (b.hitCount || 0) - (a.hitCount || 0) || (b.createdAt || 0) - (a.createdAt || 0));
                break;
            default: // 'newest'
                arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        }
        if (sortDir === 'asc') arr.reverse();
        return arr;
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

        // Apply sort before rendering.
        rules = sortRules(rules);

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
                        <input type="checkbox" class="rule-enabled-cb" data-rule-id="${escapeHtml(rule.id)}"
                          ${rule.enabled !== false ? 'checked' : ''}
                          title="${rule.enabled !== false ? 'Disable this rule' : 'Enable this rule'}"
                          style="width:16px;height:16px;cursor:pointer;flex-shrink:0;">
                        <span class="rule-meta">
                            <input type="checkbox" class="bulk-select-cb" data-rule-id="${escapeHtml(rule.id)}" style="width:14px;height:14px;margin-right:4px;">
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
        // Per-row enabled toggle checkbox — flip enabled without a full re-render
        // to preserve focus and avoid scroll position jumps.
        websiteListDiv.querySelectorAll('.rule-enabled-cb').forEach(cb => {
            cb.addEventListener('change', async () => {
                const ruleId = cb.dataset.ruleId;
                const checked = cb.checked;
                const result = await chrome.storage.sync.get(['rules']);
                const rules = Array.isArray(result.rules) ? result.rules : [];
                const next = rules.map(r => r.id === ruleId ? { ...r, enabled: checked } : r);
                await chrome.storage.sync.set({ rules: next });
                await updateRedirectRules();
                // Update just this item's opacity instead of full re-render to preserve focus
                const item = websiteListDiv.querySelector(`.website-item[data-rule-id="${CSS.escape(ruleId)}"]`);
                if (item) item.classList.toggle('rule-disabled', !checked);
            });
        });
        // Bulk-select-cb: show the bulkActionBar and update selected count.
        const selectedIds = new Set();
        websiteListDiv.querySelectorAll('.bulk-select-cb').forEach(cb => {
            cb.addEventListener('change', () => {
                if (cb.checked) selectedIds.add(cb.dataset.ruleId);
                else selectedIds.delete(cb.dataset.ruleId);
                document.getElementById('selectedCount').textContent = `${selectedIds.size} selected`;
                document.getElementById('bulkActionBar').style.display = selectedIds.size > 0 ? 'flex' : 'none';
            });
        });
        // Wire the select-all checkbox in #bulkActionBar.
        const selectAllCb = document.getElementById('selectAllCb');
        if (selectAllCb) {
            selectAllCb.checked = false;
            selectAllCb.addEventListener('change', () => {
                websiteListDiv.querySelectorAll('.bulk-select-cb').forEach(cb => {
                    cb.checked = selectAllCb.checked;
                    if (cb.checked) selectedIds.add(cb.dataset.ruleId);
                    else selectedIds.delete(cb.dataset.ruleId);
                });
                document.getElementById('selectedCount').textContent = `${selectedIds.size} selected`;
                document.getElementById('bulkActionBar').style.display = selectedIds.size > 0 ? 'flex' : 'none';
            });
        }
        // Wire the Enable / Disable buttons in #bulkActionBar to operate on selectedIds.
        const barEnableBtn = document.getElementById('bulkEnableBtn2');
        if (barEnableBtn) {
            barEnableBtn.onclick = async () => {
                const result = await chrome.storage.sync.get(['rules']);
                const allRules = Array.isArray(result.rules) ? result.rules : [];
                const next = allRules.map(r => selectedIds.has(r.id) ? { ...r, enabled: true } : r);
                await chrome.storage.sync.set({ rules: next });
                await updateRedirectRules();
                displayRules(next);
                showStatus(`Enabled ${selectedIds.size} rules.`, 'success');
            };
        }
        const barDisableBtn = document.getElementById('bulkDisableBtn2');
        if (barDisableBtn) {
            barDisableBtn.onclick = async () => {
                const result = await chrome.storage.sync.get(['rules']);
                const allRules = Array.isArray(result.rules) ? result.rules : [];
                const next = allRules.map(r => selectedIds.has(r.id) ? { ...r, enabled: false } : r);
                await chrome.storage.sync.set({ rules: next });
                await updateRedirectRules();
                displayRules(next);
                showStatus(`Disabled ${selectedIds.size} rules.`, 'success');
            };
        }
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

            // Send message to background script to update rules.
            // protectionOk: true signals that the user has already passed the
            // lock screen (checkLock() resolved before init() called loadData()).
            // Background.js uses this to gate mutations when protection is active.
            chrome.runtime.sendMessage({
                action: 'updateRules',
                rules: isEnabled ? rules : [],
                redirectUrl: redirectUrl,
                mode: mode,
                alwaysAllowed: alwaysAllowed,
                groups: currentGroups,
                protectionOk: true
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

    // Bulk-adds newline-separated rules. Uses the same validateInput/detectRuleType/normalizePattern pipeline as the single-add path.
    async function bulkAdd() {
        const textarea = document.getElementById('bulkInput');
        const groupSelect = document.getElementById('bulkGroupSelect');
        const groupId = groupSelect ? groupSelect.value : 'default';
        const lines = textarea.value.split('\n').map(l => l.trim()).filter(l => l);
        if (!lines.length) { showStatus('Enter at least one rule.', 'error'); return; }

        const existing = await chrome.storage.sync.get(['rules']);
        const rules = Array.isArray(existing.rules) ? existing.rules : [];
        let added = 0, skipped = 0, errors = [];

        for (const raw of lines) {
            const err = validateInput(raw);
            if (err) { errors.push(`"${raw}": ${err}`); continue; }
            const type = detectRuleType(raw);
            const pattern = normalizePattern(raw, type);
            if (rules.some(r => r.pattern === pattern && r.type === type)) { skipped++; continue; }
            rules.push(createRule(pattern, type, { groupId }));
            added++;
        }

        if (added > 0) {
            await chrome.storage.sync.set({ rules });
            await updateRedirectRules();
            displayRules(rules);
            textarea.value = '';
        }

        // Status message always shows counts; 'success' tone only when at least one rule was added.
        let msg = `${added} added`;
        if (skipped) msg += `, ${skipped} duplicate${skipped > 1 ? 's' : ''} skipped`;
        if (errors.length) msg += `, ${errors.length} invalid`;
        showStatus(msg, added > 0 ? 'success' : 'error');
    }

    async function importFromPlainText(text, mode) {
        const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        const incoming = lines.map(line => {
            const type = line.includes('*') ? 'wildcard' : (line.includes('/') || line.includes('?')) ? 'path' : 'domain';
            const pattern = line.replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/$/,'');
            return createRule(pattern, type);
        });
        if (mode === 'replace') {
            if (!confirm(`Replace ALL existing rules with ${incoming.length} imported rules?`)) return;
            await chrome.storage.sync.set({ rules: incoming });
        } else {
            const existing = await chrome.storage.sync.get(['rules']);
            const current = Array.isArray(existing.rules) ? existing.rules : [];
            const deduped = [...current];
            for (const r of incoming) {
                if (!deduped.some(e => e.pattern === r.pattern && e.type === r.type)) deduped.push(r);
            }
            await chrome.storage.sync.set({ rules: deduped });
        }
        await updateRedirectRules();
        const result = await chrome.storage.sync.get(['rules']);
        displayRules(Array.isArray(result.rules) ? result.rules : []);
        showStatus(`Imported ${incoming.length} rules.`, 'success');
    }

    async function importFromJSON(text, mode) {
        let parsed;
        try { parsed = JSON.parse(text); } catch(e) { showStatus('Invalid JSON file.', 'error'); return; }
        if (!parsed || !Array.isArray(parsed.rules)) { showStatus('Invalid format: missing rules array.', 'error'); return; }
        const incoming = parsed.rules.filter(r => r && r.pattern && r.type);
        if (mode === 'replace') {
            const typed = prompt('Type REPLACE to confirm replacing all existing rules:');
            if (typed !== 'REPLACE') { showStatus('Import cancelled.', 'error'); return; }
        }
        if (mode === 'replace') {
            await chrome.storage.sync.set({ rules: incoming });
        } else {
            const existing = await chrome.storage.sync.get(['rules']);
            const current = Array.isArray(existing.rules) ? existing.rules : [];
            const deduped = [...current];
            for (const r of incoming) {
                if (!deduped.some(e => e.pattern === r.pattern && e.type === r.type)) deduped.push(r);
            }
            await chrome.storage.sync.set({ rules: deduped });
        }
        await updateRedirectRules();
        const result = await chrome.storage.sync.get(['rules']);
        displayRules(Array.isArray(result.rules) ? result.rules : []);
        showStatus(`Import complete: ${incoming.length} rules processed.`, 'success');
    }

    async function exportPlainText() {
        const data = await chrome.storage.sync.get(['rules']);
        const rules = Array.isArray(data.rules) ? data.rules : [];
        const text = rules.map(r => r.pattern).join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), { href: url, download: `easy-redirect-${Date.now()}.txt` });
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showStatus('Exported as plain text.', 'success');
    }

    async function exportSettings() {
        const data = await chrome.storage.sync.get(['rules','redirectUrl','mode','groups','alwaysAllowed','extensionEnabled','theme']);
        const exportData = { version: 1, exportedAt: new Date().toISOString(), ...data };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), { href: url, download: `easy-redirect-${Date.now()}.json` });
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showStatus('Exported successfully.', 'success');
    }

    document.getElementById('bulkAddBtn').addEventListener('click', bulkAdd);
    document.getElementById('exportJsonBtn').addEventListener('click', exportSettings);
    document.getElementById('exportTxtBtn').addEventListener('click', exportPlainText);
    const importBtn = document.getElementById('importBtn');
    const importFile = document.getElementById('importFile');
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        const mode = document.querySelector('input[name="importMode"]:checked').value;
        if (file.name.endsWith('.json')) {
            await importFromJSON(text, mode);
        } else {
            await importFromPlainText(text, mode);
        }
        importFile.value = '';
    });

    // Expose removeRule for any external callers / debugging.
    window.removeRule = removeRule;
    window.addException = addException;
    window.removeException = removeException;
});
