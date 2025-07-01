# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Easy Redirect is an unpacked Chrome extension (Manifest V3) that redirects user-configured "blocked" websites to a chosen URL. There is no build step, package manager, or test suite — the four files at the repo root *are* the shipped extension.

## Loading / running the extension

1. Open `chrome://extensions`, enable Developer mode.
2. Click **Load unpacked** and select this directory.
3. After editing any file, click the reload icon on the extension card. Service-worker changes take effect on reload; options-page changes take effect the next time the options tab is opened (or refreshed).

Inspect the background service worker via the **service worker** link on the extension card (this is the only way to see `background.js` `console.log`/`console.error` output).

## Architecture

Three components share state through `chrome.storage.sync`:

- **`options.html` + `options.js`** — the user-facing settings page. Opens in a full browser tab (not a popup) either via the toolbar icon or the *Options* link on `chrome://extensions`. Reads/writes `redirectUrl`, `rules` (array of structured Rule objects), and `extensionEnabled` to `chrome.storage.sync`. After every write it *also* sends a `{ action: 'updateRules', rules, redirectUrl }` runtime message to the background worker.
- **`background.js`** — service worker that owns the `declarativeNetRequest` dynamic rules. It rebuilds the rule set on `onInstalled`, `onStartup`, on `chrome.storage.onChanged` for the relevant keys, and on the `updateRules` message from the options page. Rules are always cleared and recreated wholesale (no diffing). Also handles `chrome.action.onClicked` to open the options page — this fires *because* the manifest deliberately omits `default_popup`.
- **`manifest.json`** — MV3 manifest. Required permissions: `storage`, `declarativeNetRequest`, `activeTab`, plus `<all_urls>` host permission. Uses `options_ui` with `open_in_tab: true` so right-click → Options also lands in a tab.
- **`icons/`** — 16/32/48/128px PNG icons. Blue enabled variants and grey disabled variants. `background.js#setActionIcon(enabled)` swaps them when the extension is toggled.

### Rule generation (background.js)

Source rules in `rules[]` are translated to DNR dynamic rules at runtime. Each source rule reserves a block of `DNR_ID_STRIDE = 100` IDs so different rule types can claim distinct offsets without colliding:

```
dnrId = (sourceIndex + 1) * 100 + typeOffset + variantOffset
```

Current type offsets (must stay stable — DNR persists IDs across worker restarts):

- `domain` — offset `0`, four variants `0..3` (`*://*.domain/*`, `*://domain/*`, `*://domain`, `*://www.domain`).
- `wildcard` — offset `10`, single variant `0`, urlFilter is the user's pattern verbatim.
- `path` — offset `20`, two variants `0..1` (bare host+path, www host+path). Pattern stored as `host/path` or `host?query`.
- `keyword` — offset `30`, single variant `0`. URL substring match via DNR (`*keyword*`); page-title/body matching is handled by `content.js`.
- `regex` — offset `40`, single variant `0`. Uses DNR's `regexFilter` field (case-insensitive). Capped at 10 active regex rules (`REGEX_RULES_MAX`). Validated before storage via `chrome.declarativeNetRequest.isRegexSupported`. Input uses `r/pattern` shorthand or `/pattern/` delimiter form.

If a type ever needs more than 10 variants, widen the offset spacing rather than overlapping. Rules redirect only `main_frame` requests and are added in batches of 50 to stay under MV3 dynamic-rule limits. Rules with `enabled === false` are skipped at DNR emit time but not deleted from storage.

### Storage shape

```
{
  redirectUrl: string,          // full URL, default 'https://www.google.com'
  rules: Rule[],                // structured rules (see below)
  blockedWebsites: string[],    // LEGACY — preserved post-migration, not consumed
  extensionEnabled: boolean,    // default true; when false, all rules are cleared
  mode: 'blocklist'|'allowlist',// default 'blocklist'; see Allowlist mode below
  alwaysAllowed: string[],      // patterns exempt from redirect in both modes
  schemaVersion: number,        // bumped to 2 once migration has run
  groups: Group[]               // named rule groups; always has at least Default
}
```

A `Group` is:

```
{
  id: string,                   // crypto.randomUUID() or fallback; 'default' for Default
  name: string,                 // display name, e.g. 'Work', 'Social Media'
  color: string,                // hex color for the tab left-border, default '#2196F3'
  enabled: boolean,             // false means all rules in this group are skipped at DNR emit
  redirectUrl: string | null,   // per-group redirect URL override (null = use global)
  createdAt: number,            // ms epoch
  schedule: null                // reserved for #8 (scheduled activation); always null for now
}
```

Redirect URL precedence: `rule.redirectUrl` > `group.redirectUrl` > global `redirectUrl`.

The `groups` key lives in `DEFAULTS` so it participates in `persist()` and
`restoreFromLocalIfSyncEmpty()` from the start. `runSchemaMigration()` ensures the
Default group entry always exists and backfills `groupId='default'` on any rules
that predate #7. The 'default' group can never be deleted; all other groups can, and
their rules migrate to 'default' automatically.

### Allowlist mode

When `mode === 'allowlist'`, the semantics of `rules[]` invert: every URL is redirected *except* the ones matching a rule. DNR achieves this by:

1. A catch-all redirect at rule ID 1 (priority 1, urlFilter `*`).
2. Per-rule allow entries at IDs ≥ 2 (priority 2, `allow` action) — these win over the catch-all.
3. `alwaysAllowed[]` patterns at IDs in the 2–50 range (priority 3) — these are exempt in both modes and protect the extension options page.

Switching modes never deletes `rules[]`; the same array just changes meaning. The options-page section heading and Clear All confirmation text update to reflect the current mode.

A `Rule` is:

```
{
  id: string,                   // crypto.randomUUID() or fallback timestamp+random
  pattern: string,              // domain (bare) or wildcard pattern (preserved verbatim)
  type: 'domain'|'wildcard'|'path'|'keyword'|'regex',
  enabled: boolean,             // false skips DNR emission but keeps the rule in storage
  groupId: string,              // 'default' until #7 introduces groups
  createdAt: number,            // ms epoch
  hitCount: number,             // 0 until #27 wires the counter
  lastHitAt: number | null,
  exceptions: string[],         // URL patterns exempt from redirect for this rule
  caseSensitive?: boolean,      // keyword rules only
  wholeWord?: boolean           // keyword rules only
}
```

### Per-rule exceptions

Every rule carries an `exceptions[]` array of URL patterns that are exempt from redirect even when the parent rule matches. In `background.js`, these are emitted as `priority: PRIORITY_EXCEPTION (= 4)` DNR allow rules at ID offsets `90..99` within the rule's 100-ID block — they shadow the parent's redirect (priority 2) and the allowlist catch-all (priority 1). The UI shows exceptions as green tags under each rule row with a `+ except` button.

### Import / export

The Import / Export section in options.html (wired in options.js) lets users back up and restore their rule list. JSON export (version 1 format) includes all settings — rules, groups, redirectUrl, mode, alwaysAllowed, extensionEnabled, and theme. Plain-text export writes one pattern per line for compatibility with other blocklist tools. JSON import validates the rules array and filters entries missing pattern or type. Replace mode requires the user to type the exact string REPLACE to prevent accidental overwrites; merge mode deduplicates by pattern+type so re-importing the same file is idempotent.

### Schema migration

On install and startup, `background.js` runs `migrateLegacyBlockedWebsites()` after `restoreFromLocalIfSyncEmpty()` but before `initializeMissingDefaults()`. The migration:

1. Returns the settings unchanged if `schemaVersion >= 2` (idempotent).
2. Otherwise, builds a `rules[]` of `type:'domain'` entries from `blockedWebsites` via `createRule()`, bumps `schemaVersion` to `2`, and persists through `persist()` so the local mirror tracks the migration.
3. **Never deletes `blockedWebsites`** — the legacy string array is preserved as an untouchable rollback path; only the Remove / Clear All buttons may delete user data.

The options page normalizes input by stripping `https?://`, leading `www.`, and trailing `/` for domain rules (see `normalizePattern` in `options.js`). Wildcard input (anything containing `*`) is preserved verbatim except for surrounding whitespace, because URL paths and query strings are case sensitive.

User data is intentionally sticky: toggling the extension off only flips `extensionEnabled` to `false` and clears the runtime rules — `redirectUrl`, `rules`, and `blockedWebsites` all stay in storage. The only paths that delete user-entered data are the per-row Remove button and Clear All. Don't add disable-time wipes.

### Durability invariant — DO NOT REGRESS

User data must **never** disappear except through an explicit user action (Remove or Clear All). Past regressions came from `onInstalled` blindly writing defaults; that handler now uses `initializeMissingDefaults()` which only fills in keys whose value is `undefined`. Any future code that touches `chrome.storage.sync.set` for the watched keys must do the same — read first, only write missing keys, never overwrite existing values from a code path that isn't the user clicking a button.

Two safety nets back this up in `background.js`:

1. Every value that lands in `chrome.storage.sync` is mirrored to `chrome.storage.local` — either explicitly via `persist()` or implicitly via the `chrome.storage.onChanged` listener. `local` is per-device, has a 10MB quota, and is not subject to sync conflicts or sign-out.
2. `onInstalled` and `onStartup` call `restoreFromLocalIfSyncEmpty()` before anything else. If `sync` came back empty for a key that `local` still has, we copy it back. Only **after** restore do defaults get filled in, so a transient empty `sync` read can't cause defaults to clobber the local backup.

If you add a new persisted key, add it to `DEFAULTS` in `background.js` so it participates in both safety nets.

### Input validation

`options.js#validateInput` rejects empty strings, patterns containing whitespace, and patterns that are only one or more `*` characters (which would block every URL). The check runs before any rule is created or written to storage, so invalid input never reaches `chrome.storage.sync`.

### Dual update path — keep in sync

When the options page mutates storage it triggers redirect-rule updates **twice**: once via the explicit `sendMessage({action:'updateRules'})` and once via the `chrome.storage.onChanged` listener in `background.js`. This is redundant but harmless because rule creation is idempotent (clear-then-recreate). If you change one path, change both, or remove one deliberately.

### Rule list sort

A `<select id="sortSelect">` in the search/filter toolbar lets the user sort the rule list by: **Newest first** (default), **Oldest first**, **A → Z**, **Z → A**, or **Most blocked**. An adjacent `<button id="sortDirBtn">` toggles ascending (↑) vs. descending (↓) within the selected criterion.

`sortRules(rules)` in `options.js` applies the sort using `currentSortOrder` and `sortDir` state variables, using `rule.createdAt` as a stable secondary key so ties are always broken consistently. Both preferences are persisted to `chrome.storage.local` (not sync — sort preference is device-local) and restored on page load.

### Rule search / filter

A search box (`#ruleSearch`) sits above the bulk-actions bar in the Block Rules section. Typing in it live-filters the visible rule list to rules whose `pattern` or group name contains the query (case-insensitive). The filter runs inside `displayRules()` after the active-group filter — it reads `ruleSearch.value` directly, so any caller that re-invokes `displayRules()` (e.g. the search `input` listener) will pick up the current query automatically.

`highlightMatch(text, query)` wraps the first matching substring in a `<mark>` element (yellow background). It is applied to the rule-pattern span in the `displayRules()` template.

Pressing `/` anywhere on the options page (except when another input already has focus) moves focus to `#ruleSearch`. Pressing `Escape` inside the search box clears the query and resets the list.

### Per-rule enable/disable toggle

Every rule row in the options page shows an **On / Off** button. Clicking it calls `toggleRule(ruleId)` in `options.js`, which flips `rule.enabled` in storage and immediately calls `updateRedirectRules()`. Disabled rules (`enabled === false`) are kept in `rules[]` but skipped at DNR emit time in `background.js` — the user can re-enable them at any time without re-entering the pattern.

A **bulk-actions bar** appears above the rule list whenever at least one rule exists. It contains a **Select all** checkbox (wires all per-row checkboxes at once) and **Enable selected** / **Disable selected** buttons that call `bulkSetEnabled(visibleRules, enable)`. `bulkSetEnabled` reads the global `rules[]` from storage, flips `enabled` for every rule whose id is currently checked, and saves the updated array.

The `enabled` field on each Rule (present since PR #1) is surfaced as a per-row checkbox toggle. Disabled rules are skipped by `createRedirectRules()` at emit time but remain in storage — re-enabling them via the checkbox restores blocking without any storage loss. Bulk enable/disable is available via the action bar.

### Keyboard shortcuts

Keyboard shortcuts are declared under `commands` in `manifest.json`. background.js `chrome.commands.onCommand` handles `open-settings` (opens options page) and `toggle-extension` (flips enabled state). Default bindings: Ctrl+Shift+B / Ctrl+Shift+Y.

### Context menu

background.js registers two context menu items ('Block this site' and 'Block this URL') recreated on every install/startup. `addRuleFromBackground(pattern, type, groupId)` handles the write. A desktop notification confirms each add. A submenu lists groups for direct targeting.

### Dark mode / CSS variable token system

options.html uses CSS custom properties for all colors. The `theme` storage key ('auto'|'light'|'dark') is read by options.js on load and sets a `data-theme` attribute on `<html>`. 'auto' defers to `prefers-color-scheme`. The CSS defines three sets of variables: the :root defaults (light), the dark media query, and explicit [data-theme] overrides.

The three-layer precedence is: `[data-theme=dark/light]` (highest, forced by user) > `@media (prefers-color-scheme: dark)` (OS preference) > `:root` defaults (light fallback). A 3-way toggle (Auto/Light/Dark) in the toggle-section div lets users switch preference; clicking saves `theme` to `chrome.storage.sync` and calls `applyTheme()` immediately. Badge colors (domain, wildcard, path, keyword, regex) are intentionally kept as hard-coded hex values — they are semantic identifiers, not theme tokens.

### Prebuilt categories (categories.js)

`categories.js` provides 6 prebuilt category lists (social, news, video, gaming, adult, gambling). Lists are static — no remote fetch or auto-update. `addCategory()` in `options.js` creates a new named group (using the category's color) and bulk-adds all entries as domain rules, skipping any that are already present. The Prebuilt Categories section in `options.html` renders one card per category with name, description, entry count, a 4-entry preview, and an "Add all" button.

### Settings-page PIN protection (feature #17)

The `protection` key in `DEFAULTS` / `chrome.storage.sync` holds `{ mode, hash, salt }`:

- `mode` — `'none'` (no lock) or `'pin'` (active lock; `'password'` is a valid alias for future UI copy).
- `hash` and `salt` — both Base64-encoded. `salt` is 16 random bytes generated fresh on every `hashPin()` call. `hash` is the 256-bit PBKDF2-SHA256 output (200 000 iterations). Storing a salted hash means the raw passphrase never touches storage.

**background.js helpers** — `hashPin(passphrase)` and `verifyPin(passphrase, storedHash, storedSalt)` — use `SubtleCrypto` (available in MV3 service workers). Page-context mirrors (`_hashPin`, `_verifyPin`) live in `options.js` so the lock screen can verify locally without a round-trip.

**Lock screen** — `checkLock()` in `options.js` runs before `loadData()`. If `protection.mode !== 'none'`, a full-viewport overlay (`#lockOverlay`) is shown and the page remains blocked until the correct passphrase is entered. Successful unlock resets the `lockAttempts` counter in `chrome.storage.local`.

**Rate limiting** — failed attempts are tracked in `chrome.storage.local` under `lockAttempts: { count, lockedUntil }`. After `LOCK_MAX_ATTEMPTS` (10) failures the screen is locked for `LOCK_BACKOFF_MS` (60 seconds). The counter resets on a correct entry.

**Background gate** — the `updateRules` message handler in `background.js` checks `request.protectionOk`. The options page always sets this to `true` after `checkLock()` resolves. Other callers (injected scripts, external extensions) that omit the flag are rejected when a lock is active.

**Security section UI** (options.html / options.js):
- `loadSecuritySection()` — reads protection from storage and shows either `#securityNone` (set a new lock) or `#securityActive` (change / remove the current lock).
- **Set lock** — `#secSetBtn` validates that both PIN inputs match, calls `_hashPin()`, and writes to storage.
- **Change password** — `#secChangeBtn` (inside a `<details>` in `#securityActive`) first verifies the current password via `_verifyPin()`, then hashes and writes the new one.
- **Remove lock** — `#secRemoveBtn` uses `window.prompt()` to collect the current password, verifies it via `_verifyPin()`, then writes `{ mode: 'none', hash: null, salt: null }` to storage.

### Add-rule friction code (feature #18)

The `accessCode` key in `DEFAULTS` / `chrome.storage.sync` holds `{ enabled: boolean, length: number }`:

- `enabled` — when `true`, a randomly generated code must be typed before any rule can be added.
- `length` — code length in characters; clamped to 32–256 (default 64). Configurable via the "Add-rule friction code" section in options.

**Code generation** — `generateAccessCode(length)` in `background.js` uses `crypto.getRandomValues` with a 56-character alphabet that omits visually ambiguous pairs (0/O, 1/l/I). A page-context mirror `_generateCode(length)` in `options.js` generates the actual challenge code without a round-trip.

**Challenge flow** — when `addRule()` detects `accessCode.enabled`, it calls `_generateCode()` and `_showAccessChallenge(code)`. The challenge div (`#accessCodeChallenge`) reveals the generated code in a monospace display and provides a text input where the user must type it manually. Paste is blocked via a `paste` event listener that shows a "typing only" error message. The user must type the entire code exactly before clicking Confirm (or pressing Enter); Cancel aborts the rule addition. The challenge div hides after success or cancel.

**Settings UI** — the "Add-rule friction code" section in options.html contains a checkbox (`#accessCodeEnabled`), a range slider (`#accessCodeLength`, 32–256 step 8), and a Save button. The length row is hidden when disabled. Saving calls `chrome.storage.sync.set({ accessCode: { enabled, length } })`.

### Uninstall feedback URL (feature #19)

The `uninstallUrl` key in `DEFAULTS` / `chrome.storage.sync` holds a string (default `''`):

- When non-empty it must be a valid `https?://` URL; background.js passes it to `chrome.runtime.setUninstallURL`.
- When empty the extension falls back to `DEFAULT_UNINSTALL_URL` (`'https://forms.gle/easyredirect-uninstall'`).

**Registration** — `registerUninstallUrl()` in `background.js` reads `uninstallUrl` from sync storage and calls `chrome.runtime.setUninstallURL`. It is called on `onInstalled`, `onStartup`, and whenever the `uninstallUrl` key changes in `chrome.storage.onChanged`.

**Settings UI** — the "Uninstall feedback URL" section in options.html (`#uninstallUrlSection`) contains a text input (`#uninstallUrlInput`), a display of the default URL (`#uninstallDefaultDisplay`), a Save button (`#saveUninstallUrlBtn`), and a status line (`#uninstallUrlStatus`). The Save handler in `options.js` validates that the value is empty or starts with `https?://`, then writes to `chrome.storage.sync`. The `chrome.storage.onChanged` listener in `background.js` then picks up the change and re-registers the URL automatically.

### Disable delay (feature #20)

The `disableDelaySecs` key in `DEFAULTS` / `chrome.storage.sync` holds a number (default `0`, max `DISABLE_DELAY_MAX = 300`):

- When `0`, disabling the extension is immediate (legacy behaviour).
- When `> 0`, toggling the extension off starts a countdown. During the countdown the DNR rules remain active and blocking continues. Only when the countdown expires (or the service worker resumes and detects the deadline has passed) does the extension actually disable.

**Countdown state** is persisted to `chrome.storage.local` under `disableCountdownUntil` (epoch ms). This survives service-worker termination: `onStartup` calls `resumeCountdownIfPending()` which resumes the `setTimeout` for the remaining duration or immediately executes the disable if the deadline already passed.

**In-memory timers**:
- `_countdownTimer` — `setTimeout` handle for the final disable action.
- `_badgeInterval` — `setInterval` handle that calls `setCountdownBadge(remaining)` every second to update the toolbar badge (orange background, remaining seconds as text, capped at `'99+'`).

**Cancel** — the options page sends `{ action: 'cancelDisableCountdown' }` to background.js. `cancelDisableCountdown()` clears both timers, wipes `disableCountdownUntil` from local storage, restores `extensionEnabled: true` in sync storage, and calls `updateRedirectRules()` to reactivate blocking.

**Options page integration**:
- `#disableDelaySection` — numeric input (0–300) and Save button that writes `disableDelaySecs` to `chrome.storage.sync`.
- `#disableCountdownBanner` — orange banner (hidden unless active) with a live `#disableCountdownSecs` counter and a `#cancelDisableBtn`. The banner polls `getDisableCountdown` once on load via `_checkCountdown()` and listens for the `disableCountdownFired` runtime message to hide itself and reload the toggle state.
- `chrome.runtime.onMessage` listener for `disableCountdownFired` reloads `loadData()` to update the toggle button.
