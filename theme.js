// Theme engine for the options page. Loaded in <head> (before the body) so
// the saved theme is applied without a flash.
//
// Every theme from themes.js becomes one CSS rule, :root[data-theme="<id>"],
// in a <style> element; switching themes only changes the data-theme
// attribute (no inline styles).
//
// The theme rotates daily: on the first page load of a new local day a
// random theme is picked (never yesterday's). Prev / Next change today's
// theme. Today's choice is cached in localStorage.erTheme as { date, id } for
// the synchronous boot and synced as `theme` + `themeDate` (options.js), so
// every device shows the same theme on the same day.

const THEME_DEFAULT = 'midnight';

function themeIdOrDefault(id) {
    return THEME_BY_ID[id] ? id : THEME_DEFAULT;
}

function themeRule(t) {
    const c = t.c;
    const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
    const vars = {
        '--bg': c.bg, '--bg-card': c.card, '--bg-section': c.card,
        '--sidebar-bg': `color-mix(in srgb, ${c.bg} 72%, #000)`,
        '--sidebar-hover': 'rgba(255,255,255,.06)', '--sidebar-active': tint(c.accent, 26),
        '--sidebar-text': c.muted, '--sidebar-text-hi': c.text,
        '--text': c.text, '--text-muted': c.muted, '--border': c.border, '--border-focus': c.accent,
        '--input-bg': `color-mix(in srgb, ${c.bg} 55%, ${c.track})`, '--input-border': c.border,
        '--accent': c.accent, '--accent-hover': c.accentHover, '--accent-light': tint(c.accent, 18),
        '--green': c.good, '--green-bg': tint(c.good, 14), '--green-border': tint(c.good, 45), '--green-text': c.good,
        '--red': c.warn, '--red-bg': tint(c.warn, 14), '--orange': c.warn, '--orange-bg': tint(c.warn, 14),
        '--blue': c.accent, '--blue-bg': tint(c.accent, 14),
        '--exception-bg': tint(c.good, 14), '--exception-border': tint(c.good, 45), '--exception-text': c.good,
        '--btn-primary': c.accent, '--btn-primary-hover': c.accentHover, '--btn-blue': c.accent,
        '--on-accent': t.onAccent || '#fff',
        '--font': t.font, '--radius': `${t.radius}px`,
        '--page-bg': t.pageBg || c.bg, '--card-shadow': t.shadow || 'none'
    };
    const body = Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(' ');
    return `:root[data-theme="${t.id}"] { ${body} color-scheme: dark; }`;
}

function installThemeRules() {
    if (document.getElementById('erThemeRules')) return;
    const style = document.createElement('style');
    style.id = 'erThemeRules';
    style.textContent = THEMES.map(themeRule).join('\n');
    document.head.appendChild(style);
}

function themeToday(d = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function readThemeCache() {
    try {
        const raw = localStorage.getItem('erTheme');
        if (!raw) return null;
        if (raw.startsWith('{')) return JSON.parse(raw);
        return { date: null, id: raw }; // older cache: a bare id
    } catch (_) { return null; }
}

// Random theme, never `avoidId` (yesterday's).
function randomTheme(avoidId) {
    const pool = THEMES.filter(t => t.id !== avoidId);
    return pool[Math.floor(Math.random() * pool.length)];
}

// Today's theme id: the cached one if it was set today, otherwise a new
// random pick for the new day.
function todaysThemeId() {
    const cache = readThemeCache();
    if (cache && cache.date === themeToday() && THEME_BY_ID[cache.id]) return cache.id;
    return randomTheme(cache && cache.id).id;
}

// Apply a theme by id and remember it as today's. Returns the theme.
function applyTheme(id) {
    const t = THEME_BY_ID[themeIdOrDefault(id)];
    installThemeRules();
    const root = document.documentElement;
    root.dataset.theme = t.id;
    root.dataset.card = t.card || 'flat';
    root.dataset.heading = t.heading || 'normal';
    try { localStorage.setItem('erTheme', JSON.stringify({ date: themeToday(), id: t.id })); } catch (_) {}
    return t;
}

// Step through the list: dir = +1 (next) or -1 (previous), wrapping around.
function themeStep(currentId, dir) {
    const i = THEMES.findIndex(t => t.id === themeIdOrDefault(currentId));
    return THEMES[(i + dir + THEMES.length) % THEMES.length];
}

applyTheme(todaysThemeId());
