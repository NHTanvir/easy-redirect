// 30 dark themes, shared with the Roadmap Coach extension (same file). Easy
// Redirect maps them onto its own CSS variables in theme.js. All dark, no yellow, gold or
// amber anywhere: warnings use orange-red.
//
// Each theme sets the colour variables used by newtab.css plus design knobs:
//   font     — font stack
//   radius   — corner radius of cards
//   pageBg   — page background (colour or gradients)
//   shadow   — card shadow
//   card     — 'flat' | 'shadow' | 'glass' | 'outline' | 'brutal'
//   mission  — 'top' | 'left' | 'glow' | 'fill'
//   heading  — 'normal' | 'upper' | 'serif'

const FONT_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
const FONT_MONO = 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace';
const FONT_ROUND = 'ui-rounded, "Nunito", "Varela Round", system-ui, sans-serif';
const FONT_COND = '"Barlow Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif';

const SOFT = '0 10px 30px -12px rgba(0,0,0,.25)';
const DEEP = '0 18px 40px -18px rgba(0,0,0,.6)';

const THEMES = [
    // ── Dark ───────────────────────────────────────────────────────────
    { id: 'midnight', name: 'Midnight', font: FONT_SANS, radius: 14, card: 'flat', mission: 'top', heading: 'normal',
      c: { bg: '#0F1120', card: '#191C30', text: '#E8EAF6', muted: '#9095AD', border: '#2A2E48', accent: '#E53935', accentHover: '#C62828', good: '#43A047', warn: '#F4511E', track: '#262A42' } },
    { id: 'neon-tokyo', name: 'Neon Tokyo', font: FONT_SANS, radius: 16, card: 'glass', mission: 'glow', heading: 'upper',
      pageBg: 'radial-gradient(circle at 15% 10%, #3a0ca3 0%, transparent 45%), radial-gradient(circle at 85% 90%, #7209b7 0%, transparent 40%), #0b0221',
      c: { bg: '#0b0221', card: 'rgba(25,10,50,.72)', text: '#F5F0FF', muted: '#B9A9D9', border: 'rgba(255,46,136,.35)', accent: '#FF2E88', accentHover: '#D81B6A', good: '#00F5D4', warn: '#FF6B35', track: 'rgba(255,255,255,.1)' } },
    { id: 'ocean-deep', name: 'Ocean Deep', font: FONT_SANS, radius: 18, card: 'shadow', mission: 'left', heading: 'normal', shadow: DEEP,
      pageBg: 'linear-gradient(160deg, #03192a 0%, #0a3d5c 100%)',
      c: { bg: '#03192a', card: '#0C2F44', text: '#E3F4FB', muted: '#8FB7CB', border: '#164B66', accent: '#00B4D8', accentHover: '#0096C7', good: '#2EC4B6', warn: '#FF7F50', track: '#12405A' } },
    { id: 'forest-night', name: 'Forest Night', font: FONT_SERIF, radius: 12, card: 'flat', mission: 'left', heading: 'serif',
      c: { bg: '#0E1712', card: '#16241C', text: '#E6F0E8', muted: '#97AE9E', border: '#25392D', accent: '#6BBF59', accentHover: '#55A145', good: '#8BD17C', warn: '#E76F51', track: '#20332A' } },
    { id: 'dracula', name: 'Dracula', font: FONT_MONO, radius: 10, card: 'outline', mission: 'top', heading: 'normal',
      c: { bg: '#282A36', card: '#343746', text: '#F8F8F2', muted: '#A3A7C2', border: '#4B4F68', accent: '#FF79C6', accentHover: '#E35FAE', good: '#50FA7B', warn: '#FF5555', track: '#44475A' } },
    { id: 'nord', name: 'Nord', font: FONT_SANS, radius: 12, card: 'flat', mission: 'left', heading: 'normal',
      c: { bg: '#2E3440', card: '#3B4252', text: '#ECEFF4', muted: '#A9B1C2', border: '#4C566A', accent: '#88C0D0', accentHover: '#6FA9BA', good: '#A3BE8C', warn: '#D08770', track: '#434C5E' } },
    { id: 'terminal', name: 'Terminal', font: FONT_MONO, radius: 0, card: 'outline', mission: 'left', heading: 'upper',
      c: { bg: '#020A04', card: '#061409', text: '#7CFF9B', muted: '#3FB862', border: '#1F6B36', accent: '#33FF66', accentHover: '#22CC50', good: '#33FF66', warn: '#FF5F56', track: '#0E2A16' }, onAccent: '#02140A' },
    { id: 'synthwave', name: 'Synthwave', font: FONT_COND, radius: 6, card: 'glass', mission: 'fill', heading: 'upper',
      pageBg: 'linear-gradient(180deg, #120458 0%, #3d0f6b 55%, #b5179e 100%)',
      c: { bg: '#120458', card: 'rgba(20,6,60,.7)', text: '#FCEBFF', muted: '#CDB4E6', border: 'rgba(247,37,133,.4)', accent: '#F72585', accentHover: '#B5179E', good: '#4CC9F0', warn: '#FF6B6B', track: 'rgba(255,255,255,.14)' } },
    { id: 'volcano', name: 'Volcano', font: FONT_SANS, radius: 10, card: 'shadow', mission: 'glow', heading: 'upper', shadow: DEEP,
      pageBg: 'radial-gradient(circle at 50% 120%, #5c1505 0%, #1a0b07 60%)',
      c: { bg: '#1A0B07', card: '#2A120C', text: '#FBE9E3', muted: '#C79A8C', border: '#4A2015', accent: '#FF5722', accentHover: '#E64A19', good: '#66BB6A', warn: '#FF7043', track: '#3A1A12' } },
    { id: 'royal', name: 'Royal', font: FONT_SERIF, radius: 14, card: 'flat', mission: 'fill', heading: 'serif',
      c: { bg: '#120F2D', card: '#1D1945', text: '#EEEAFF', muted: '#A9A2D6', border: '#2E2866', accent: '#7B61FF', accentHover: '#5E44E0', good: '#06D6A0', warn: '#FF6B6B', track: '#2A2560' } },
    { id: 'espresso', name: 'Espresso', font: FONT_SERIF, radius: 16, card: 'shadow', mission: 'left', heading: 'serif', shadow: DEEP,
      c: { bg: '#1E1612', card: '#2A1F19', text: '#F3E9DC', muted: '#BBA58F', border: '#3D2E25', accent: '#D08159', accentHover: '#B56A44', good: '#8DB580', warn: '#E5604A', track: '#3A2B22' } },
    { id: 'aurora', name: 'Aurora', font: FONT_ROUND, radius: 22, card: 'glass', mission: 'glow', heading: 'normal',
      pageBg: 'radial-gradient(ellipse at 20% 0%, rgba(0,255,170,.35) 0%, transparent 50%), radial-gradient(ellipse at 90% 30%, rgba(140,80,255,.4) 0%, transparent 50%), #071018',
      c: { bg: '#071018', card: 'rgba(10,25,35,.68)', text: '#E7FFF6', muted: '#9CC7BA', border: 'rgba(124,255,203,.3)', accent: '#2EE6A6', accentHover: '#1FBF88', good: '#7CFFCB', warn: '#FF6F59', track: 'rgba(255,255,255,.1)' }, onAccent: '#04221A' },
    { id: 'monokai', name: 'Monokai', font: FONT_MONO, radius: 6, card: 'flat', mission: 'top', heading: 'normal',
      c: { bg: '#272822', card: '#3E3D32', text: '#F8F8F2', muted: '#B5B39C', border: '#55544A', accent: '#F92672', accentHover: '#D41A5E', good: '#4ADE80', warn: '#FD5F2C', track: '#49483E' } },
    { id: 'blood-moon', name: 'Blood Moon', font: FONT_COND, radius: 4, card: 'outline', mission: 'fill', heading: 'upper',
      pageBg: 'radial-gradient(circle at 80% -10%, #4a0010 0%, #120406 55%)',
      c: { bg: '#120406', card: '#1F080B', text: '#FFE8EA', muted: '#C99299', border: '#4A1219', accent: '#FF1744', accentHover: '#C4001D', good: '#69F0AE', warn: '#FF6E40', track: '#36101A' } },
    { id: 'deep-space', name: 'Deep Space', font: FONT_SANS, radius: 20, card: 'glass', mission: 'left', heading: 'normal',
      pageBg: 'radial-gradient(circle at 30% 20%, #1b2a4a 0%, transparent 40%), radial-gradient(circle at 70% 80%, #2a1b4a 0%, transparent 45%), #05060f',
      c: { bg: '#05060f', card: 'rgba(16,20,40,.75)', text: '#E6EAFF', muted: '#9AA3CC', border: 'rgba(110,130,255,.3)', accent: '#6E82FF', accentHover: '#5468E6', good: '#4ADE80', warn: '#FB7185', track: 'rgba(255,255,255,.1)' } },

    // ── More dark ──────────────────────────────────────────────────────
    { id: 'obsidian', name: 'Obsidian', font: FONT_SANS, radius: 6, card: 'outline', mission: 'left', heading: 'upper',
      c: { bg: '#0B0B0D', card: '#141418', text: '#F1F1F3', muted: '#9A9AA5', border: '#2A2A33', accent: '#E5484D', accentHover: '#C93A3F', good: '#46A758', warn: '#F76B15', track: '#222228' } },
    { id: 'emerald-night', name: 'Emerald Night', font: FONT_SERIF, radius: 14, card: 'shadow', mission: 'glow', heading: 'serif', shadow: DEEP,
      pageBg: 'radial-gradient(circle at 20% 0%, #0b3b2c 0%, transparent 50%), #04140F',
      c: { bg: '#04140F', card: '#0A2219', text: '#E3F7EE', muted: '#8DB8A6', border: '#174233', accent: '#10B981', accentHover: '#059669', good: '#34D399', warn: '#FB7185', track: '#123327' } },
    { id: 'cobalt', name: 'Cobalt', font: FONT_SANS, radius: 8, card: 'flat', mission: 'fill', heading: 'normal',
      c: { bg: '#0A1230', card: '#121C45', text: '#E6ECFF', muted: '#97A4D6', border: '#22306A', accent: '#3B82F6', accentHover: '#2563EB', good: '#22C55E', warn: '#F97366', track: '#1C2858' } },
    { id: 'crimson-velvet', name: 'Crimson Velvet', font: FONT_SERIF, radius: 16, card: 'shadow', mission: 'glow', heading: 'serif', shadow: DEEP,
      pageBg: 'linear-gradient(160deg, #1a070d 0%, #2d0a17 100%)',
      c: { bg: '#1A070D', card: '#2A0D16', text: '#FFE6EC', muted: '#C996A4', border: '#4A1726', accent: '#E11D48', accentHover: '#BE123C', good: '#4ADE80', warn: '#FB923C', track: '#3A1220' } },
    { id: 'purple-haze', name: 'Purple Haze', font: FONT_ROUND, radius: 24, card: 'glass', mission: 'fill', heading: 'normal',
      pageBg: 'linear-gradient(135deg, #1a0b2e 0%, #2d1250 50%, #12082a 100%)',
      c: { bg: '#1A0B2E', card: 'rgba(40,18,70,.7)', text: '#F3E8FF', muted: '#C4B0E0', border: 'rgba(168,85,247,.35)', accent: '#A855F7', accentHover: '#9333EA', good: '#34D399', warn: '#FB7185', track: 'rgba(255,255,255,.12)' } },
    { id: 'teal-abyss', name: 'Teal Abyss', font: FONT_SANS, radius: 12, card: 'flat', mission: 'left', heading: 'normal',
      c: { bg: '#031A1D', card: '#082A2E', text: '#E0FAF7', muted: '#88B9B3', border: '#13464B', accent: '#14B8A6', accentHover: '#0D9488', good: '#5EEAD4', warn: '#FB7185', track: '#0F3A3E' } },
    { id: 'carbon', name: 'Carbon', font: FONT_MONO, radius: 0, card: 'brutal', mission: 'top', heading: 'upper',
      c: { bg: '#121212', card: '#1E1E1E', text: '#EDEDED', muted: '#A0A0A0', border: '#EDEDED', accent: '#FF5252', accentHover: '#E04040', good: '#69F0AE', warn: '#FF6E40', track: '#2C2C2C' } },
    { id: 'graphite', name: 'Graphite', font: FONT_MONO, radius: 4, card: 'outline', mission: 'left', heading: 'upper',
      c: { bg: '#16181D', card: '#1F232A', text: '#E5E9F0', muted: '#9AA3B2', border: '#353B46', accent: '#7DD3FC', accentHover: '#38BDF8', good: '#86EFAC', warn: '#FCA5A5', track: '#2A2F38' }, onAccent: '#0B2533' },
    { id: 'rosewood', name: 'Rosewood', font: FONT_ROUND, radius: 20, card: 'shadow', mission: 'top', heading: 'normal', shadow: DEEP,
      c: { bg: '#1C0F12', card: '#2B171C', text: '#FCE7EE', muted: '#C59AA8', border: '#47242E', accent: '#F472B6', accentHover: '#EC4899', good: '#6EE7B7', warn: '#FB923C', track: '#3A1F27' } },
    { id: 'github-dark', name: 'Ink', font: FONT_SANS, radius: 10, card: 'flat', mission: 'left', heading: 'normal',
      c: { bg: '#0D1117', card: '#161B22', text: '#E6EDF3', muted: '#8D96A0', border: '#30363D', accent: '#58A6FF', accentHover: '#388BFD', good: '#3FB950', warn: '#F85149', track: '#21262D' } },
    { id: 'ember', name: 'Ember', font: FONT_COND, radius: 14, card: 'glass', mission: 'glow', heading: 'upper',
      pageBg: 'radial-gradient(circle at 50% 110%, rgba(255,90,60,.45) 0%, transparent 55%), #120A08',
      c: { bg: '#120A08', card: 'rgba(35,18,14,.75)', text: '#FFECE6', muted: '#CFA196', border: 'rgba(255,107,74,.35)', accent: '#FF6B4A', accentHover: '#F04A28', good: '#4ADE80', warn: '#FF6B4A', track: 'rgba(255,255,255,.1)' } },
    { id: 'galaxy', name: 'Galaxy', font: FONT_SANS, radius: 18, card: 'glass', mission: 'fill', heading: 'normal',
      pageBg: 'linear-gradient(135deg, #0f0c29 0%, #302b63 55%, #24243e 100%)',
      c: { bg: '#0F0C29', card: 'rgba(30,26,70,.72)', text: '#EFEAFF', muted: '#B3AADB', border: 'rgba(192,132,252,.3)', accent: '#C084FC', accentHover: '#A855F7', good: '#4ADE80', warn: '#FB7185', track: 'rgba(255,255,255,.12)' }, onAccent: '#1E0B3A' },
    { id: 'jade-terminal', name: 'Jade Terminal', font: FONT_MONO, radius: 0, card: 'outline', mission: 'top', heading: 'upper',
      c: { bg: '#071A14', card: '#0B241C', text: '#C9F7E3', muted: '#6FBF9C', border: '#1E5A44', accent: '#34D399', accentHover: '#10B981', good: '#34D399', warn: '#F87171', track: '#123A2D' }, onAccent: '#04221A' },
    { id: 'midnight-rose', name: 'Midnight Rose', font: FONT_SERIF, radius: 16, card: 'flat', mission: 'left', heading: 'serif',
      c: { bg: '#12101A', card: '#1C1828', text: '#F3EEFA', muted: '#A79DBD', border: '#2E2840', accent: '#FB7185', accentHover: '#F43F5E', good: '#4ADE80', warn: '#FB923C', track: '#262136' } },
    { id: 'blueprint', name: 'Blueprint', font: FONT_MONO, radius: 2, card: 'outline', mission: 'left', heading: 'upper',
      pageBg: 'linear-gradient(rgba(255,255,255,.07) 1px, transparent 1px) 0 0 / 24px 24px, linear-gradient(90deg, rgba(255,255,255,.07) 1px, transparent 1px) 0 0 / 24px 24px, #0B3B73',
      c: { bg: '#0B3B73', card: 'rgba(9,48,96,.92)', text: '#EAF4FF', muted: '#A8C6E8', border: 'rgba(234,244,255,.45)', accent: '#7FD1FF', accentHover: '#55BDF5', good: '#7CF0B8', warn: '#FF8A80', track: 'rgba(255,255,255,.15)' }, onAccent: '#062A52' }
];

const THEME_BY_ID = Object.fromEntries(THEMES.map(t => [t.id, t]));
