# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Easy Redirect is an unpacked Chrome extension (Manifest V3) that redirects user-configured "blocked" websites to a chosen URL. No build step, no package manager, no test suite — the files at the repo root are the shipped extension.

## Loading / running the extension

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this directory.
2. After editing any file, click the reload icon on the extension card.
3. Service-worker output: click the **service worker** link on the extension card.

Options-page changes take effect the next time the options tab is opened or refreshed.

## Architecture

Four source files; state shared via `chrome.storage.sync`:

| File | Role |
|------|------|
| `options.html` + `options.js` | Full-tab settings UI. Reads/writes storage, sends `updateRules` message after every mutation. Tabs wired by external `tabs.js` (MV3 CSP requires no inline scripts). |
| `background.js` | Service worker. Owns DNR dynamic rules; rebuilds them on `onInstalled`, `onStartup`, `storage.onChanged`, and the `updateRules` message. `chrome.action.onClicked` opens options (no `default_popup`). |
| `manifest.json` | MV3. Permissions: `storage`, `declarativeNetRequest`, `declarativeNetRequestFeedback`, `activeTab`, `alarms`, `notifications`, `<all_urls>`. `options_ui.open_in_tab: true`. |
| `categories.js` | Static prebuilt category lists (social, news, video, gaming, adult, gambling). |

### DNR rule ID formula

```
dnrId = (sourceIndex + 1) * 100 + typeOffset + variantOffset
```

Type offsets — **must stay stable** (DNR persists IDs across restarts):

| Type | Offset | Variants |
|------|--------|----------|
| `domain` | 0 | 0–3 (`*://*.d/*`, `*://d/*`, `*://d`, `*://www.d`) |
| `wildcard` | 10 | 0 (verbatim urlFilter) |
| `path` | 20 | 0–1 (bare, www) |
| `keyword` | 30 | 0 (`*keyword*`) |
| `regex` | 40 | 0 (regexFilter; max 10 active) |
| sub-frame copy | 50 | 0 (domain/wildcard/path only) |
| per-rule exceptions | 90–99 | priority 4 allow rules |

Allowlist catch-all: rule ID 1 (priority 1). Per-rule allow entries: IDs ≥ 2 (priority 2). `alwaysAllowed[]` patterns: priority 3.

Redirect URL precedence: `rule.redirectUrl` > `group.redirectUrl` > global `redirectUrl`.

### Storage shape

**`chrome.storage.sync`** (all keys participate in `persist()` / `restoreFromLocalIfSyncEmpty()`):

```js
{
  redirectUrl: string,           // default 'https://www.google.com'
  rules: Rule[],
  blockedWebsites: string[],     // LEGACY — preserved, not consumed
  extensionEnabled: boolean,     // default true
  mode: 'blocklist'|'allowlist', // default 'blocklist'
  alwaysAllowed: string[],
  schemaVersion: number,         // 2 after migration
  groups: Group[],               // always has Default
  theme: 'auto'|'light'|'dark',
  protection: { mode: 'none'|'pin', hash: string|null, salt: string|null },
  accessCode: { enabled: boolean, length: number },
  uninstallUrl: string,
  disableDelaySecs: number,      // 0–300
  pomodoroEnabled: boolean,
  pomodoroState: 'off'|'work'|'break',
  pomodoroWorkMinutes: number,   // default 25
  pomodoroBreakMinutes: number,  // default 5
  pomodoroStartedAt: number|null,
  pomodoroSessionsToday: number,
  pomodoroSessionDate: string|null,
  lockdownUntil: number|null,    // ms epoch; null = not active
  lockdownDurationSecs: number,  // default 3600; max 86400
  lockdownScope: 'all'|'groups'|'allowlist-exempt',
  blockedPageEnabled: boolean,
  blockedPageTitle: string,
  blockedMessage: string,
  motivationEnabled: boolean,
  motivationQuotes: string[],
  blockSubresources: boolean,
  notifyOnRedirect: boolean,
  notifyThrottleMs: number,      // default 5000
  profileName: string,
  incognitoMode: 'block'|'allow'
}
```

**`chrome.storage.local`** (device-only):

```js
{
  dailyCounts: { date: "YYYY-MM-DD", counts: { [ruleId]: number } },
  weeklyStats: { weekStart: "YYYY-MM-DD", days: { "YYYY-MM-DD": { total: N, byRule: {} } } },
  temporaryOverrides: { [ruleId]: expiresAt },
  disableCountdownUntil: number,
  "allowedUntil:<ruleId>": number,
  blockedImageDataUrl: string,
  lockAttempts: { count: number, lockedUntil: number },
  sortOrder: string,
  sortDir: 'asc'|'desc'
}
```

**Rule object:**

```js
{
  id: string,                    // crypto.randomUUID()
  pattern: string,
  type: 'domain'|'wildcard'|'path'|'keyword'|'regex',
  enabled: boolean,
  groupId: string,               // 'default' for Default group
  createdAt: number,
  hitCount: number,
  lastHitAt: number|null,
  exceptions: string[],          // per-rule exempt URL patterns
  caseSensitive?: boolean,       // keyword only
  wholeWord?: boolean,           // keyword only
  quota: number|null,            // max redirects/day; null = unlimited
  redirectUrl: string|null
}
```

**Group object:**

```js
{
  id: string,                    // 'default' for Default
  name: string,
  color: string,                 // hex, default '#2196F3'
  enabled: boolean,
  redirectUrl: string|null,
  createdAt: number,
  delaySeconds: number,          // 0 = immediate; >0 = countdown interstitial
  allowWindowSecs: number,       // after countdown, allow-through window
  schedule: {
    days: number[],              // 0–6 (Sun=0)
    startTime: string,           // "HH:MM"
    endTime: string              // "HH:MM"; < startTime wraps midnight
  } | null
}
```

### Durability invariant — DO NOT REGRESS

User data must **never** disappear except via Remove or Clear All. `onInstalled` uses `initializeMissingDefaults()` — only fills keys whose value is `undefined`, never overwrites. Every sync write is mirrored to local via `persist()`. `onInstalled`/`onStartup` call `restoreFromLocalIfSyncEmpty()` before setting defaults so a transient empty sync read can't clobber the local backup.

**If you add a new persisted key, add it to `DEFAULTS` in `background.js`.**

### Dual update path

Options-page mutations trigger rule rebuilds twice: explicit `sendMessage({action:'updateRules'})` + `chrome.storage.onChanged`. Redundant but harmless (idempotent clear-then-recreate). Change both or remove one deliberately.

### Schema migration

`runSchemaMigration()` (background.js) runs after `restoreFromLocalIfSyncEmpty()` but before `initializeMissingDefaults()`. Currently: migrates `blockedWebsites[]` → `rules[]` (schemaVersion 1→2); backfills `groupId`, `schedule`, `delaySeconds`, `allowWindowSecs`, `redirectUrl`, `hitCount`, `lastHitAt` on old records. Never deletes `blockedWebsites`.

### Theme system

CSS custom properties on `:root` (light), `@media (prefers-color-scheme: dark)`, and `[data-theme=dark/light]` (highest). `applyTheme()` in options.js sets the `data-theme` attribute and uses `classList.toggle('active')` on theme buttons — never inline styles (they override CSS).

### PIN / lock screen

`protection` key holds PBKDF2-SHA256 hash+salt (SubtleCrypto, 200k iterations). `checkLock()` in options.js blocks the page until correct passphrase. Rate-limited: 10 failures → 60s backoff. Background gate: `updateRules` message requires `protectionOk: true`.

## Git / PR workflow

Feature branches: `feature-name` (kebab-case). All feature commits backdated to January 2026. After `gh pr merge --merge`, rewrite today-dated merge commits using `git commit-tree` (not `git filter-branch` — fails on Windows). Walk commits topologically oldest-first (`git rev-list --topo-order --reverse`), maintain old→new SHA map, finish with `git update-ref` + `git push --force`.

Author identity: `NHTanvir <n.mukto@codexpert.io>`.

## Testing

Extension APIs (`chrome.runtime`, `chrome.storage.*`, `chrome.i18n`) are unavailable in `file://` context. Always load via `chrome://extensions` → Load unpacked. `blocked.html` and `countdown.html` render blank content when opened from disk.
