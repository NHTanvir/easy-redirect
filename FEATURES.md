# Easy Redirect — Features

## Blocking
- **Block websites** — redirects any visit to a blocked domain (and its subdomains) to your chosen page.
- **Rule types** — block by domain, path (`reddit.com/r/funny`), wildcard (`*.site.com/*`), keyword (`kw:word`) or regex (`r/...`).
- **Keyword page matching** — keyword rules also catch pages whose title or text contains the word.
- **Redirect URL** — sets where blocked visits go (default Google); can be overridden per group or per rule.
- **Allowlist mode** — flips the logic so everything is blocked except the sites on your list.
- **Always-allowed list** — sites that are never blocked, in either mode.
- **Sub-resource blocking** — also blocks blocked sites loaded inside iframes.
- **Incognito support** — choose whether rules apply in incognito windows.

## Managing rules
- **Groups** — organise rules into colour-coded groups you can switch on and off together.
- **Bulk add** — paste many sites at once, one per line.
- **Per-rule exceptions** — allows specific pages inside an otherwise blocked site.
- **Enable / disable single rules** — turns one rule off without deleting it.
- **Daily limit** — a rule stops blocking after N redirects in a day, then resets at midnight.
- **Temporary allow** — lets one rule through for 5, 15 or 60 minutes.
- **Move rules between groups** — reassigns a rule to another group.
- **Search & sort** — filters the rule list by text and sorts it by date, name or hit count.
- **Hit counts** — shows how many times each rule has fired.
- **Import & Export** — backs up or shares your rules as a file.
- **Context menu** — block the current site with a right-click.

## Focus tools
- **Pause / Resume blocking** — the main button only pauses blocking; there is no permanent off switch.
- **Pomodoro timer** — runs work/break cycles in the background with notifications.
- **Lockdown mode** — blocks pausing and rule changes for a fixed time, up to 24 hours.
- **Disable delay** — makes a pause wait up to 5 minutes before it takes effect.
- **Group schedule** — a group only blocks on chosen days and times.
- **Redirect delay / countdown** — shows a countdown page before a blocked site, then allows it briefly.

## Blocked page
- **Custom blocked page** — shows your own title, message and image instead of redirecting elsewhere.
- **Motivational quotes** — shows a rotating quote on the blocked page.
- **Streak reminder** — the blocked page shows your current focus streak.

## Stats
- **Stats dashboard** — today's and this week's blocked visits, a 7-day chart and your top blocked sites.
- **Redirect notification** — optional desktop notification when a site is blocked.

## Security & settings
- **PIN lock** — protects the settings page with a PIN or password.
- **Friction code** — adding a rule or pausing requires typing a long random code (no paste).
- **Profile name** — labels this Chrome profile's rule set.
- **Uninstall feedback URL** — opens a page of your choice when the extension is removed.
- **Keyboard shortcuts** — `Ctrl+Shift+B` opens settings, `Ctrl+Shift+Y` resumes blocking.
- **Theme** — Auto, Light or Dark mode.
- **Sync & backup** — settings sync across your Chrome devices and are mirrored locally so they can't vanish.

## Focus Guard (new) — all in the Focus Guard tab, one section each
- **Auto re-enable** — a pause ends by itself after the pause length (default 5 min, adjustable 1–30).
- **Daily pause budget** — caps total pausing per day (default 30 min, adjustable 0–120).
- **Work-hours lock** — no pausing and no Focus Guard setting changes during chosen work hours.
- **Focus streak** — counts days in a row without pausing, with your best streak; optional on the blocked page.
- **Earned breaks** — each finished Pomodoro work session earns break minutes (default 5, bank up to 60, both adjustable) that don't cost budget or streak.
- **Points & levels** — earns points for blocked visits and Pomodoro sessions, loses them for pauses (all three amounts adjustable), and levels you up.
- **Reflection prompt** — before pausing, shows today's stats and makes you write a reason and wait (length and wait adjustable).
- **Focus report & pause history** — 7/14/30-day table of pauses, minutes paused, earned breaks and blocked visits, plus your recent pause reasons.

## Works with Roadmap Coach
- **Roadmap Coach bridge** — the Roadmap Coach extension can read what Easy Redirect blocks and grant an earned break here when its daily roadmap goal is met; Easy Redirect keeps doing all the blocking.
