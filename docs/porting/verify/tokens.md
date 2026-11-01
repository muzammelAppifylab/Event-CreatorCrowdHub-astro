# Verification: design tokens, theme, typography, fonts

Read-only audit. Source = `CreatorCrowdHub` (O), new = `creator-crowd-hub-astro` (N).
Method: Node script (scratchpad, not in repo) parsed every `--custom-property` declaration with its selector/media context
from O `tokens.css, theme.css, globals.css, shadcn-tailwind.css` and N `tokens.css, theme.css, global.css, app.css, public.css, design-system.css, home.css, events.css, screens.css`,
normalised case/whitespace/leading zeros, and diffed by (name, light/dark context).

## Result summary

| Scope | Source decls | Identical | Notes |
|---|---|---|---|
| tokens.css + theme.css (real tokens) | 224 | 218 exact | other 6 = 4 intentional renames (D1) + 2 font-preset selectors differing only in quote style (same value) |
| Tailwind `@theme inline` bridge (globals.css:28-169) | ~170 | 0 | intentional: no Tailwind in N (D2) |
| shadcn-tailwind.css scroll-fade / shimmer vars | ~50 | 0 | intentional: shadcn kit not ported; no usage in O .tsx either (D3) |

Token percentage: **100% of real tokens present with identical values** (218/224 byte-equal after normalisation, 6/224 intentional rename/format).
`tokens.css` is a byte-for-byte copy (diff empty, CRLF-normalised). Dark parity: N `.dark,:root[data-theme='dark']` block (theme.css:106-178) equals the
`prefers-color-scheme` block (theme.css:180-253) and both equal O `.dark` (theme.css:~120-195) value for value; the MQ block adds `:not(.dark)` and `:not([data-theme='light'])` guards (intentional, template theme menu).

## Identical (checked)

- Fonts: same 6 fontsource deps, same versions `^5.3.0` (O package.json:21-26, N package.json:21-26); same imports Anton latin-400, Bricolage opsz, Hanken wght, JetBrains Mono wght, Young Serif latin-400, Nunito wght (O globals.css:15-20, N global.css:14-19). font-display swap comes from fontsource.
- Type scale `--fs-*`, `--lh-*`, `--tracking-*`, radius `--r-*`, elevation `--elev-*` (light + dark), motion `--motion-*`/`--dur-*`, layout vars: all in tokens.css/theme.css, identical.
- Utilities `type-poster/display/label/code`, `bg-wash-*`, `page-container`, `section-y`: values identical (O globals.css:~245-312, N global.css:198-257), converted from `@utility` to plain classes.
- Base: focus ring 2px/offset 2px (O globals.css:~205, N global.css:87), `::selection` (N:51), `scrollbar-color` (N:48), tap highlight, `font-synthesis-weight`, `text-rendering`, `scroll-margin-top`, tabular-nums, caret-color, `font-feature-settings ss01 cv11`, `text-wrap` balance/pretty, pointer cursor: all present.
- Reduced motion rule identical (O globals.css:~255, N global.css:112-119; more reduce/no-preference blocks in app.css).
- `brand.ts` vs `event-brand.ts`: `diff` empty, so applyBrand / applyFontPreset / checkBrandContrast / normalizeHex are identical.
- favicon.svg: `cmp` identical; `<link rel=icon>` kept (O __root.tsx:26, N Base.astro:132, App.astro:37) with the site favicon override.
- Dark-only values (e.g. `--subtle-foreground #8c8c8c`, soft status hexes, washes, shadows) identical.

## Differences

### Intentional
- D1 Name clashes: O `--accent`(bg, theme.css:42/147) -> N `--accent-bg`; O `--muted` (theme.css:44/149) -> N `--surface-muted`/`--muted-foreground`; N `--accent` = primary, N `--muted` = muted text (N theme.css:269-309, 279/273). Template alias layer (`--bg --surface --line --success ...`, 24 extra names) is additive. Documented in design-tokens.md.
- D2 Tailwind bridge `--color-*`, `--text-*`, `--radius-md 10px / 3xl 32px / 4xl`, `--shadow-elev-*`, `--ease-*`, `--container-*` (O globals.css:28-169) absent: N is plain CSS (AGENTS.md: no second UI kit). Equivalent `--radius*`, `--font-*`, `--shadow-*` aliases exist (N theme.css:269-309). `--radius-md 10px`, `--radius-3xl`, `--radius-4xl`, `--radius-xs` and `--font-heading/-poster/-serif/-rounded` have NO plain equivalent (low risk, only matters if ported markup needs them).
- D3 shadcn-tailwind.css (scroll-fade, shimmer utilities): not ported; N has its own `@keyframes shimmer` (app.css:901/920).
- D4 Dark triggers: O only `.dark` class; N also `data-theme` and prefers-color-scheme (N theme.css:106,180).
- D5 Theme mechanism: O `ThemeProvider` toggles `.dark`, key `ezy-events:theme`, values light|dark|system, default **light** (O theme.tsx:13,22,47). N `useTheme` sets `data-theme` on `<html>`, key `site:theme` (N portal/routes.tsx:191-215), system = key removed, default **device preference**. App.astro:45-51 restores before paint. Matches the template design (documented), but default differs from O "light is the product default".

### Defects (ranked)
1. **Brand not applied end to end.** `applyBrand` / `applyFontPreset` (N src/lib/event-brand.ts) are never imported (grep: only the file itself and docs). The only consumer, N `src/pages/host/index.astro:76-85`, sets `--brand` on `<main>` only, plus raw `--accent` / `--accent-hover = hex`; it skips `--brand-foreground` (contrast ink/paper) and `--brand-text` (AA gate), so button text and links may fail AA (O brand.ts:70-80 sets all three on `<html>`). `data-font` (index.astro:32) is never read: `data-font-preset` is never set, so serif/rounded presets (theme.css:257-262) are dead. Fix: import `applyBrand/applyFontPreset` on `<html>` in Base.astro/App.astro from the brand endpoint.
2. **Theme flash / non-persistence on public pages.** The `site:theme` restore script exists only in App.astro:45-51; Base.astro has none, so a user who chose dark in the dashboard sees device theme on public pages. Medium-low.
3. **No `<meta name="theme-color">`** (O __root.tsx:19 `#ffffff`); N Base/App have none (Base.astro:131 adds only `color-scheme`). Low; could be a light/dark pair via `media` attrs (no inline style needed).
4. Missing plain-CSS counterparts of `--radius-md 10px`, `--radius-xs/3xl/4xl`, `--font-heading/poster/serif/rounded` (O globals.css:29-35,147-154). Low, only if used.
5. N `theme.css` header and design-tokens.md say preset hook is `applyFontPreset` "from src/lib/event-brand.ts" (true) but doc implies it is wired; doc inaccurate vs defect 1. Low.

No inline `style=""` found in N (the 4 grep hits are comments).

## Verdict
Tokens: 100% present and value-identical (6 intentional renames/format). Fonts, scale, radii, shadows, motion, focus, selection, scrollbar, reduced motion, favicon, brand.ts: identical. Real gaps are runtime wiring (brand/font preset, theme restore on public layout, theme-color).
