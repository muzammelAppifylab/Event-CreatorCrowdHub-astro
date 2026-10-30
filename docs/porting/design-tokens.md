# Design tokens (the "Marquee" system, copied from CreatorCrowdHub)

Source of truth: `CreatorCrowdHub/src/styles/{tokens,theme,globals}.css`. Here:

- `src/styles/tokens.css` : primitives, VERBATIM copy (raw values; never use in screens).
- `src/styles/theme.css` : semantic roles, light + dark, brand override, font presets,
  and the TEMPLATE ALIASES (bottom of the file).
- `src/styles/global.css` : imports fonts, tokens, theme; base elements. No hex outside tokens/theme.

Rules: no hex, no `style=""` (CSP). In screens/pages/kit use ONLY the semantic or template names below.

## Dark mode
Light is the default. Dark when ANY of: `class="dark"` on `<html>` (or on a band element),
`data-theme="dark"` on `<html>` (the template's theme menu, `localStorage['site:theme']`),
or device preference unless `data-theme="light"`. All tokens re-resolve; do nothing per-component.
A nested `.dark` element (black band) works too.

## Template aliases (existing kit/template classes use these; they now carry the new look)
| Template name | Resolves to | Note |
|---|---|---|
| `--bg` | `--background` | page |
| `--surface` | `--surface-sunken` | app canvas / sidebar-ish wells |
| `--card` | `--card` | white / ink-900 |
| `--ink` | `--ink` | TEXT colour: black / paper |
| `--muted` | `--muted-foreground` | muted TEXT (the source's `--muted` bg is `--surface-muted`) |
| `--subtle` | `--subtle-foreground` | |
| `--line` | `--border` | hairline |
| `--line-strong` | 28% foreground mix | stronger hairline |
| `--hover` | `--accent-bg` | hover fill |
| `--accent` | `--primary` | BRAND/primary colour (ink by default, workspace brand when set) |
| `--accent-hover` | primary 85% mix | |
| `--accent-ink` | `--primary-foreground` | text on accent |
| `--accent-soft` | primary 10% over bg | |
| `--accent-text` | `--primary-text` | brand as text/links (AA-safe) |
| `--success(-soft)` | `--rsvp-going-soft-foreground` / `-soft` | |
| `--warning(-soft)` | `--rsvp-maybe-soft-foreground` / `-soft` | |
| `--danger(-soft)`, `--danger-hover` | `--destructive` / `--rsvp-no-soft` | |
| `--info(-soft)` | `--rsvp-waitlist-soft-foreground` / `-soft` | |
| `--shadow-sm/md/lg` | `--elev-1/2/3` | |
| `--overlay` | ink-1000 at 50% | dialog backdrop |
| `--radius-sm / --radius / --radius-lg / --radius-xl / --radius-pill` | 8 / 12 / 16 / 24 / 999px | |
| `--font-sans / --font-display / --font-mono` | `--type-ui / --type-display / --type-code` | |

Name clashes (source name -> here): source `--accent` is `--accent-bg`, source `--accent-foreground`
is `--accent-foreground`, source `--muted` is `--surface-muted`, source `--muted-foreground` is `--muted-foreground`.

## Semantic tokens (source names, use freely)
Surfaces: `--background --foreground --surface-sunken --surface-muted --card --card-foreground --popover --popover-foreground`
Actions: `--primary --primary-foreground --primary-text --secondary --secondary-foreground --accent-bg --accent-foreground --destructive --destructive-foreground`
Lines/controls: `--border --border-strong --input --control-off --ring`
RSVP/status (solid + soft pairs): `--rsvp-{going,maybe,no,waitlist}`, `-foreground`, `-soft`, `-soft-foreground`
Signal: `--signal --signal-foreground` (confirmation screens only). Washes: `--wash-party --wash-sky --wash-spearmint --wash-aura` (surfaces only).
Charts: `--chart-1..5`. Shell: `--sidebar --sidebar-foreground --sidebar-primary(-foreground) --sidebar-accent(-foreground) --sidebar-border --sidebar-ring`.
Selection/scroll: `--selection --selection-foreground --scrollbar-thumb`.
Fonts: `--type-poster --type-display --type-ui --type-code` (+ families `--font-family-{poster,display,ui,mono,serif,rounded}`).

## Primitives (tokens.css; reference only through the roles above, except scale/radius/motion/layout)
- Ink/paper: `--ink-1000 900 850 800 700 600 500 400 300 200 150 100 50`, `--paper`; signal `--mint-400/900`.
- Status primitives: `--leaf-*`, `--amber-*`, `--ember-*`, `--periwinkle-*`, `--midnight-900`; washes `--wash-*`; poster artwork `--poster-{tomato,pink,lime,cobalt,teal,butter,plum,cream}` (artwork only).
- Type scale: `--fs-{micro 11,caption 12,body-sm 14,body 16,lead 18,title-sm 20,title 24,heading 32,display-sm 40,display 48,display-lg 64,poster,poster-xl}`;
  line heights `--lh-{poster,display,heading,title,body,tight}`; tracking `--tracking-{poster,display,heading,body,label}`.
- Radius: `--r-xs 4 --r-sm 8 --r-md 12 --r-lg 16 --r-xl 24 --r-2xl 40 --r-pill 999px`. Every button/badge/tab/toggle is a PILL; inputs/cards `--r-md`; dialogs/popovers `--r-lg`; feature panels `--r-xl`.
- Elevation (only things that float): `--elev-1 --elev-2 --elev-3`. Cards in flow have none (border instead).
- Motion: `--motion-ease-out --motion-ease-in-out --motion-ease-snap`, `--dur-{instant 90,fast 160,base 240,slow 420,deal 700}ms`.
- Layout: `--page-max 1200px --prose-max 68ch --gutter --section-gap --nav-height 4rem`.

## Utility classes (global.css, plain CSS equivalents of the source's Tailwind utilities)
`.type-poster` (condensed uppercase headline), `.type-display` (display font, 650), `.type-label` (12px tracked uppercase bold; buttons, table heads),
`.type-code` (mono, tracked), `.bg-wash-{party,sky,spearmint,aura}`, `.page-container`, `.section-y`.
Source button sizes: h 40 (default), 28 xs, 32 sm, 48 lg, 56 xl; label 12px/700/0.06em uppercase; sentence case for ghost/link.

## Fonts (self-hosted via Fontsource, font-display swap, imported in global.css)
Anton 400 (poster), Bricolage Grotesque Variable (display, opsz), Hanken Grotesk Variable (UI/body), JetBrains Mono Variable (code),
Young Serif 400 (serif preset), Nunito Variable (rounded preset). Body = `--type-ui`; h1-h4 = `--type-display`.

## Workspace brand colour + font preset (runtime, CSP-safe)
`GET /site-api/event-settings/brand` -> apply with `applyBrand(hex)` and `applyFontPreset(preset)` from `src/lib/event-brand.ts`
(same API and variable names as the source). They use `root.style.setProperty` (CSSOM: allowed under CSP, not an inline attribute):
`--brand`, `--brand-foreground` (ink or paper by contrast), `--brand-text` (only when the brand passes AA on white);
preset sets `data-font-preset="serif" | "rounded"` on `<html>` (`inter` removes it). Pass `null` to reset.
`checkBrandContrast(hex)` returns the AA report (for the settings warning). `--accent`, `--primary`, `--ring`, `--chart-1` follow automatically.
