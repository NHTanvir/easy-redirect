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

### Rule generation (background.js)

Source rules in `rules[]` are translated to DNR dynamic rules at runtime. Each source rule reserves a block of `DNR_ID_STRIDE = 100` IDs so different rule types can claim distinct offsets without colliding:

```
dnrId = (sourceIndex + 1) * 100 + typeOffset + variantOffset
```

Current type offsets (must stay stable — DNR persists IDs across worker restarts):

- `domain` — offset `0`, four variants `0..3` (`*://*.domain/*`, `*://domain/*`, `*://domain`, `*://www.domain`).
- `wildcard` — offset `10`, single variant `0`, urlFilter is the user's pattern verbatim.
- `path` — offset `20`, two variants `0..1` (bare host+path, www host+path). Pattern stored as `host/path` or `host?query`.

Future types (`keyword`, `regex`) claim the next free offset (`30+`); if a type ever needs more than 10 variants, widen the offset spacing rather than overlapping. Rules redirect only `main_frame` requests and are added in batches of 50 to stay under MV3 dynamic-rule limits. Rules with `enabled === false` are skipped at DNR emit time but not deleted from storage.

### Storage shape

```
{
  redirectUrl: string,          // full URL, default 'https://www.google.com'
  rules: Rule[],                // structured rules (see below)
  blockedWebsites: string[],    // LEGACY — preserved post-migration, not consumed
  extensionEnabled: boolean,    // default true; when false, all rules are cleared
  schemaVersion: number         // bumped to 2 once migration has run
}
```

A `Rule` is:

```
{
  id: string,                   // crypto.randomUUID() or fallback timestamp+random
  pattern: string,              // domain (bare) or wildcard pattern (preserved verbatim)
  type: 'domain' | 'wildcard' | 'path',  // future: 'keyword' | 'regex'
  enabled: boolean,             // false skips DNR emission but keeps the rule in storage
  groupId: string,              // 'default' until #7 introduces groups
  createdAt: number,            // ms epoch
  hitCount: number,             // 0 until #27 wires the counter
  lastHitAt: number | null
}
```

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
