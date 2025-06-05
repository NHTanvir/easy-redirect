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

- **`options.html` + `options.js`** — the user-facing settings page. Opens in a full browser tab (not a popup) either via the toolbar icon or the *Options* link on `chrome://extensions`. Reads/writes `redirectUrl`, `blockedWebsites` (array of bare domains), and `extensionEnabled` to `chrome.storage.sync`. After every write it *also* sends a `{ action: 'updateRules' }` runtime message to the background worker.
- **`background.js`** — service worker that owns the `declarativeNetRequest` dynamic rules. It rebuilds the rule set on `onInstalled`, `onStartup`, on `chrome.storage.onChanged` for the relevant keys, and on the `updateRules` message from the options page. Rules are always cleared and recreated wholesale (no diffing). Also handles `chrome.action.onClicked` to open the options page — this fires *because* the manifest deliberately omits `default_popup`.
- **`manifest.json`** — MV3 manifest. Required permissions: `storage`, `declarativeNetRequest`, `activeTab`, plus `<all_urls>` host permission. Uses `options_ui` with `open_in_tab: true` so right-click → Options also lands in a tab.

### Rule generation (background.js)

For each blocked domain, **four** dynamic rules are generated to cover URL-pattern variants: `*://*.domain/*`, `*://domain/*`, `*://domain`, `*://www.domain`. Rule IDs are assigned as `(index+1)*10 + 0..3`, so adding a 5th URL pattern requires bumping the multiplier to avoid ID collisions. Rules redirect only `main_frame` requests. Rules are added in batches of 50 to stay under MV3 dynamic-rule limits.

### Storage shape

```
{
  redirectUrl: string,          // full URL, default 'https://www.google.com'
  blockedWebsites: string[],    // bare domains, lowercased, no scheme/www/trailing slash
  extensionEnabled: boolean     // default true; when false, all rules are cleared
}
```

The options page normalizes input by stripping `https?://`, leading `www.`, and trailing `/` before storing (see `addWebsite` in `options.js`). Keep the stored form bare — `background.js` builds the `*://...` patterns assuming bare domains.

User data is intentionally sticky: toggling the extension off only flips `extensionEnabled` to `false` and clears the runtime rules — `redirectUrl` and `blockedWebsites` stay in storage. The only paths that delete user-entered data are the per-row Remove button and Clear All. Don't add disable-time wipes.

### Durability invariant — DO NOT REGRESS

User data must **never** disappear except through an explicit user action (Remove or Clear All). Past regressions came from `onInstalled` blindly writing defaults; that handler now uses `initializeMissingDefaults()` which only fills in keys whose value is `undefined`. Any future code that touches `chrome.storage.sync.set` for the watched keys must do the same — read first, only write missing keys, never overwrite existing values from a code path that isn't the user clicking a button.

Two safety nets back this up in `background.js`:

1. Every value that lands in `chrome.storage.sync` is mirrored to `chrome.storage.local` — either explicitly via `persist()` or implicitly via the `chrome.storage.onChanged` listener. `local` is per-device, has a 10MB quota, and is not subject to sync conflicts or sign-out.
2. `onInstalled` and `onStartup` call `restoreFromLocalIfSyncEmpty()` before anything else. If `sync` came back empty for a key that `local` still has, we copy it back. Only **after** restore do defaults get filled in, so a transient empty `sync` read can't cause defaults to clobber the local backup.

If you add a new persisted key, add it to `DEFAULTS` in `background.js` so it participates in both safety nets.

### Dual update path — keep in sync

When the options page mutates storage it triggers redirect-rule updates **twice**: once via the explicit `sendMessage({action:'updateRules'})` and once via the `chrome.storage.onChanged` listener in `background.js`. This is redundant but harmless because rule creation is idempotent (clear-then-recreate). If you change one path, change both, or remove one deliberately.
