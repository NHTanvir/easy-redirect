// Theme engine for the options page. Loaded in <head> (before the body) so
// the saved theme is applied without a flash.
//
// Every theme from themes.js becomes one CSS rule, :root[data-theme="<id>"],
// in a <style> element; switching themes only changes the data-theme
// attribute (no inline styles). The choice is stored in chrome.storage.sync
// as `theme` and cached in localStorage.erTheme for the synchronous boot.

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

// Apply a theme by id and remember it locally. Returns the theme.
function applyTheme(id) {
    const t = THEME_BY_ID[themeIdOrDefault(id)];
    installThemeRules();
    const root = document.documentElement;
    root.dataset.theme = t.id;
    root.dataset.card = t.card || 'flat';
    root.dataset.heading = t.heading || 'normal';
    try { localStorage.setItem('erTheme', t.id); } catch (_) {}
    return t;
}

// Step through the list: dir = +1 (next) or -1 (previous), wrapping around.
function themeStep(currentId, dir) {
    const i = THEMES.findIndex(t => t.id === themeIdOrDefault(currentId));
    return THEMES[(i + dir + THEMES.length) % THEMES.length];
}

let _bootTheme = THEME_DEFAULT;
try { _bootTheme = localStorage.getItem('erTheme') || THEME_DEFAULT; } catch (_) {}
applyTheme(_bootTheme);
