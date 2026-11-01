# UI kit parity: original shadcn components vs the new kit

Read-only static comparison (no build, no dev server). Source: `CreatorCrowdHub/src/components/ui/*`, `shared/*`, `features/design-system/**`.
New: `src/portal/ui/*`, `src/styles/app.css` ("Design parity" block from ~line 2397; neutral rules earlier in the file still apply when the parity block does not override them), `screens.css`, `design-system.css`, `src/portal/screens/components.tsx`.

## Token translation (identical in both projects)

| Tailwind in source | Value | New CSS token |
| --- | --- | --- |
| rounded-md / lg / xl / pill | 10px / 12px (r-md) / 16px (r-lg) / 999px | `--r-md` etc. used directly (checked) |
| text-caption / body-sm / body / lead / title-sm | 12 / 14 / 16 / 18 / 20px | `--fs-*` same |
| `type-label` | 12px, 700, lh 1, tracking .06em, uppercase | `--fs-caption`, 700, `--tracking-label`, uppercase |
| shadow-elev-1/2/3, ring-1 ring-border | tokens | `--elev-*`, `0 0 0 1px var(--border)` |
| bg-muted, bg-accent | `--muted` (surface-muted), `--accent` | `--surface-muted`, `--accent-bg` |

Verdict legend: MATCH = same size/colour/state values; DIFF = at least one concrete value or state differs; MISSING = no kit piece.

## Component by component (shadcn `ui/`)

| # | Component | Source value | New value | Match? | Files |
| --- | --- | --- | --- | --- | --- |
| 1 | Button (variants) | pill; default `bg-primary/85` hover; outline `border-border-strong`, hover bg-foreground; secondary hover mix 8% foreground; ghost body-sm 600 hover accent; destructive; link underline 1px/4px; active scale .97; disabled opacity .4; focus outline 2px ring offset 2 | all identical (`color-mix(... 85%, transparent)`, 8% mix, `scale(.97)`, `.4`, outline 2px/2px) | MATCH | button.tsx; app.css 2412-2640 |
| 2 | Button (sizes) | xs h28 px12 10px; sm h32 px14 11px; md h40 px20 type-label; lg h48 px28 13px; xl h56 px36 14px; icon 40/28/32/48 | identical heights, paddings, fonts, icon-button widths | MATCH | app.css `.button-xs..xl`, `.icon-button` |
| 3 | Button icon glyph size | xs 12, sm 14, lg 16, xl 20 | `ICON_SIZE` xs 14 (should be 12) | FIXED: ICON_SIZE.xs 12 (was:DIFF (nit)) | button.tsx line 25 |
| 4 | Button ghost with size | twMerge: size font wins (xs 10, sm 11, lg 13px) | forced to 14px for every size | FIXED: ghost xs 10 / sm 11 / lg 13 / xl 14 (was:DIFF (nit, source behaviour uncertain: `text-body-sm` is custom to twMerge)) | app.css `.button-ghost.button-xs..xl` |
| 5 | Badge base | h24, px10, caption 12/600, gap 4, pill, transparent border | same (`.badge`) | MATCH | display.tsx; app.css `.badge` |
| 6 | Badge icon | svg `size-3` (12px) | `<Icon size={14}>` | FIXED: badge icon 12 (was:DIFF (nit)) | display.tsx line 163 |
| 7 | Badge variants | default/secondary/outline/ghost/destructive/link/label + going/maybe/no/waitlist solid + soft pairs + signal | neutral(secondary)/brand+solid(default)/outline/label + soft success/warning/danger/info | FIXED: going/maybe/no/waitlist/signal/ghost/link tones added (BadgeTone extended) (was:DIFF: solid RSVP (going/maybe/no/waitlist), `signal`, `ghost`, `link` not in kit) | display.tsx; app.css `.badge-*` |
| 8 | Card | rounded-xl (16), ring-1 border, py/gap 20, header px20 gap4, title lead(18)/700/lh1.375, desc 14 muted, footer border-t bg-muted/50 p20, `data-size=sm` spacing 12 | `.card-panel` r-lg, 1px border, 1.25rem padding/gap, title 18/700/1.375, foot 50% surface-muted | MATCH (size=sm variant missing; border vs ring is 1px layout-only) | display.tsx Card; app.css 2790-2870 |
| 9 | Input | h44, px14, py8, r12, `border-input`, bg-background, 16px; focus border-foreground + ring-4 ring/15; disabled bg-input/50 op .5; invalid border-destructive + ring-3 destructive/20; dark bg input/30 | all identical in light; dark bg stays `--background` (source `input/30`) | MATCH (dark-mode nit) | app.css 3238-3330 |
| 10 | Textarea | min-h 96, px14 py12, `field-sizing-content` (auto-grow) | min-height 6rem, py .75rem, no auto-grow | MATCH (no auto-grow) | app.css `.field textarea` |
| 11 | Select trigger | h44, r12, pl14 pr12, chevron-down 16 muted, same focus/invalid | native select, same box values, but chevron is `chevrons-up-down` and **right padding overridden to .875rem** (see defect 1) | FIXED: padding-inline-end 2.5rem (field + toolbar select); native chevron glyph kept by design (was:DIFF) | form.tsx Select; app.css 3254-3270 vs 1330 |
| 12 | Select content / item | popup r12, p4, shadow-elev-2, ring; item rounded-md px6 py4 14px, focus accent | native OS popup | DIFF (by design, native) | n/a |
| 13 | Checkbox | 16px, r4, `border-input`, checked bg-primary + border-primary, invalid border-destructive + ring-3, disabled .5, focus outline 2px | 16px, r4, same checked, focus outline; **no `aria-invalid` style**; disabled opacity .6 on wrapper plus .5 on input (compounds) | FIXED: aria-invalid style, disabled no longer compounds (was:DIFF) | form.tsx Checkbox; app.css 1388-1400, 3340-3375 |
| 14 | Switch | 40x24, thumb 20px, off `control-off`, on primary, thumb off x=3 / on x=17 (1px border), disabled .5, focus outline, sm 24x14 | 40x24, thumb 20px, same colours, off x=2 / on x=18; **disabled .55** (neutral rule not overridden); no sm size | FIXED: disabled .5 (thumb offsets and sm size kept) (was:DIFF (nit)) | form.tsx Switch; app.css 1459-1500, 3402-3425 |
| 15 | RadioGroup item | 16px round radio, primary fill, 8px dot | no standalone radio; `RadioCards` only | MISSING (standalone) / cards DIFF | form.tsx RadioCards |
| 16 | RadioCards vs Field-label card | `border-primary/30 bg-primary/5` checked, hover bg-muted/50, r12 | same values | MATCH | app.css 3430-3455 |
| 17 | Label | 14px, 500, lh 1, gap 8 | `.field label` 14/500/lh 1 | MATCH | app.css 3243 |
| 18 | Field (+ error/description) | col gap 8, error 14 destructive, description 14 muted | same | MATCH | form.tsx Field |
| 19 | Tabs (default pill) | list h40 p4 pill bg-muted; trigger h(100%-1px) px16 py2 14/600 `foreground/60`, hover foreground; active bg-background + elev-1; focus outline 2px | identical | MATCH | nav.tsx; app.css 3463-3520 |
| 20 | Tabs line / vertical variants, dark active | line variant, vertical orientation, dark `input/30` active | none | DIFF (missing variants) | nav.tsx |
| 21 | Toggle / ToggleGroup | pill, `aria-pressed`/on = bg-foreground text-background, hover bg-muted, h40 px16 | `SegmentedControl`: active = bg-background + elev-1 (tab look), h40 | DIFF (different on-state look; no multi-toggle) | nav.tsx SegmentedControl |
| 22 | Table | th `type-label` h44 px12 muted; td px12 py12 nowrap; row border-b, hover muted/50, last no border; wrapper rounded-xl border bg-card overflow-x-auto | th identical; td py12 but first/last cell inline padding **1.25rem** (source 0.75rem); td wraps (source nowrap); `.table-wrap` has no border/radius/bg | FIXED: px-3 cells (card-flush keeps gutter), nowrap td, framed wrapper (was:DIFF) | table.tsx; app.css 3183-3230, 1130 |
| 23 | DataTable features (shared) | sorting arrows, row selection + bulk pill bar, pagination footer, empty row | loading/error/empty states and phone card mode (new); no sort, select, bulk bar, pagination | DIFF (missing features) | table.tsx |
| 24 | Dialog | p24 gap16 r16 bg-popover ring+elev-3, max-w 24rem, title 20/700/lh1.25, desc 14 muted, footer `-mx-6 -mb-6` bg surface-sunken px24 py16 border-t, **close = ghost icon 44px at top 8 right 8**, overlay black/10 + blur-xs; footer col-reverse on mobile | box r16 popover elev-3 + 1px ring, 24rem, head 1.5rem, title 20/700/lh1.2, foot sunken px24 py16; overlay ink 10% + blur 4px; **close = 32px IconButton inside head flex**; foot is wrapping row (no col-reverse) | FIXED: 44px absolute close top/right 8, column-reverse footer on mobile (was:DIFF (close target 32 vs 44, position; mobile footer order)) | overlay.tsx Modal; app.css 3563-3630 |
| 25 | AlertDialog / ConfirmDialog | p16 max-w-xs/sm, `ring-foreground/10`, footer bg-muted/50 p16 grid 2 cols on sm, media icon slot, default cancel "Keep it" | `useConfirm` renders `Modal size="sm"` (dialog layout: p24, sunken footer, close X) | FIXED via dialog fixes (close, footer order); alert-dialog layout stays Modal sm by design (was:DIFF) | overlay.tsx 162-240 |
| 26 | Sheet | sides left/right/top/bottom, w-3/4 sm:max-w-sm, elev-3, border, header p16 gap2, footer p16, title 20/700, close 44px | right only; width 75% / 24rem, elev-3, header/foot 1rem; **`.drawer-body` keeps neutral `color: var(--muted)` and `font-size: .9rem`** (source popover-foreground, 14px) | FIXED: drawer-body popover-foreground 14px, 44px close (right side only by design) (was:DIFF) | overlay.tsx Drawer; app.css 1823-1830, 3631-3660 |
| 27 | Dropdown menu | content r12 p4 min-w128 elev-2 ring; item rounded-md(10) px6 py4 14px gap6, focus accent; destructive focus bg/10; label 12 muted; separator -mx1 my1 | identical; no checkbox/radio items, submenu, shortcut | MATCH (feature subset) | overlay.tsx Menu; app.css 3690-3760 |
| 28 | Popover | w72 p10 r12 popover elev-2 ring | none | MISSING | n/a |
| 29 | Tooltip | r10, px12 py6, 12px, bg-foreground, max-w 20rem, **arrow 10px rotated**, delayed-open animation | r10, .375rem .75rem, 12px, bg-foreground, 20rem; hover + focus-within; no arrow, no delay | FIXED: 10px rotated arrow (was:DIFF (arrow)) | display.tsx Tooltip; app.css 3765-3800 |
| 30 | Toast (sonner) | bg-foreground text-background, r16, 14/600, elev-2, icons 16 | same; gap .5rem, padding 1rem | MATCH | overlay.tsx; app.css 3660-3690 |
| 31 | Skeleton | `animate-pulse` 2s cubic-bezier(.4,0,.6,1) opacity .5, r10, bg-muted | identical keyframes/radius/bg; parity rule re-enables animation under `prefers-reduced-motion` (neutral rule disabled it) | MATCH (reduced-motion nit) | app.css 3085-3100 |
| 32 | Alert | r12, border, px10 py8, 14px, bg-card, svg 16, destructive = text-destructive, title 500, desc 14 muted | same box; Notice icon is **18px** (source 16) and offset `margin-top:1px` (source translate 2px); extra success/warning tones (no source) | FIXED: icon 16, offset 2px (was:DIFF (nit)) | display.tsx Notice line 285; app.css 3088-3140 |
| 33 | Separator | 1px `bg-border` | no generic class; only `.menu-separator` | MISSING (generic) | n/a |
| 34 | Avatar | 32 default / 24 sm / 40 lg, bg-muted, text 14 (xs on sm), 1px `border-border` overlay ring, badge, group/overlap `ring-2 ring-background` | sizes 24/32/40, bg-surface-muted, text 12/14/14; **no border overlay, no badge, no group** | FIXED: 1px border ring (badge/group not added) (was:DIFF) | display.tsx Avatar; app.css 3011-3035 |
| 35 | Progress | h8 pill track bg-muted, indicator pill primary, 500ms ease-out transform | svg 100x8 `preserveAspectRatio="none"` rx=4: caps stretch horizontally into ellipses; no transition | FIXED: div track/fill, pill caps, 500ms ease-out width transition (was:DIFF) | display.tsx ProgressBar; app.css 3145-3156 |
| 36 | Sidebar | item h40 pill px12 14/500, active bg-sidebar-accent 600, hover accent/60, group label caps; collapsible icon rail, mobile sheet 18rem, rail | `.app-nav-link` h40 pill, same hover/active, label caps 12; sidebar not collapsible-to-icons | DIFF (values match, rail/collapse missing) | nav in app shell; app.css 2640-2720 |
| 37 | InputGroup | h32 group with addons/buttons | `SearchInput` only (h44 input, icon left) | DIFF | form.tsx SearchInput |
| 38 | Accordion | trigger py10 14/500 hover underline, focus ring-4 | none | MISSING | n/a |
| 39 | Calendar / date pickers | react-day-picker, cell 28px | none (native date inputs) | MISSING | n/a |
| 40 | Command (palette) | cmdk, r16 popover | none | MISSING | n/a |
| 41 | Pagination | prev/next, 32px items | none (`LoadMore` keyset button instead, by design) | MISSING | table.tsx LoadMore |
| 42 | Collapsible | primitive | none | MISSING | n/a |
| 43 | AspectRatio | primitive | none | MISSING | n/a |

## Shared components (`src/components/shared`)

| Component | Source | New | Match? |
| --- | --- | --- | --- |
| StatusBadge | soft badge + 6px dot, word always present | `.status` h24 px10 caption 600, dot 6px, soft tones | MATCH |
| EmptyState | r16 dashed, px24 py56, gap16, 48px icon disc, title 20/700, desc 14 muted max-w 384 | identical values | MATCH |
| PageHeader | full-width band, border-b, h1 20/700, px32 py16, leading/badge/actions/children slots, sticky option | in-content header, h2 20/700, no band or hairline, no `leading`/`badge`/`sticky` | DIFF |
| DataTable | see row 22-23 | see rows | DIFF |
| LoadingSkeleton | CardSkeleton, TableSkeleton, PageSkeleton | `Skeleton` + `LoadingBlock` only | DIFF (3 layouts missing) |
| ConfirmDialog | row 25 | `useConfirm` | DIFF |
| CopyButton, DateTimeDisplay, EventCard, HrefLink, InviteFan, InvitePoster, PhoneFrame, PollResults, QRCode, QRCodeMark, RsvpChoice | domain components | not part of the dashboard kit; not checked | out of scope |

## Kit pieces with no source counterpart

`Stat`, `SettingRow`, `Person`, `Sparkline`, `BarChart`, `DefinitionList`, `ErrorNote`, `LoadMore`, `PasswordInput`/`PasswordChecks`, `useForm`, `Notice` success/warning tones, `SegmentedControl` as a tab-look control, `Menu` keyboard/placement logic, table phone-card mode, `.ds-*` token gallery classes.

## Gallery and design-system CSS

* `design-system.css` / `screens.css` are token-only and consistent with the parity block; `.ds-*` classes are new (the source uses Tailwind in `Foundations.tsx`).
* `screens/components.tsx` demonstrates Button, dialogs/drawer/confirm/toast, fields, choices, settings rows, DataTable, charts, Notice, EmptyState/Loading, Badges, Tabs, Tooltip, Menu, SegmentedControl. Original `Components.tsx` shows Buttons incl. xl/lg/xs/icon/disabled/loading, solid RSVP badges, Tabs, RSVP form with Select, Table with seats/ticket column, Switch rows. Not in the gallery: solid RSVP badges (kit lacks them), Avatar, Skeleton, Progress, disabled button state and `xl` size demos (not verified line by line).
* `screens/design-system/foundations.tsx` covers ink/paper, semantic tokens, RSVP, signal/charts, poster, washes, typography, radii, shadows, spacing, motion, icons. The original also has BrandLab, LiveBand and Confirmation sections: no equivalents in the new gallery.

## Verdict

Counts (35 shadcn files + 6 shared kit-relevant = 41; rows 1-43 are finer grained):

* MATCH: 13 (button, badge base, card, input, textarea, label, field, tabs, skeleton, sonner, dropdown-menu, StatusBadge, EmptyState)
* DIFFER: 20 (select, checkbox, switch, radio-group, table, dialog, alert-dialog, sheet, tooltip, alert, avatar, progress, sidebar, input-group, toggle, toggle-group, PageHeader, DataTable, LoadingSkeleton, ConfirmDialog)
* MISSING: 8 (accordion, aspect-ratio, calendar, collapsible, command, pagination, popover, separator)
* Out of scope: 11 domain components.

## Ranked defects with the exact fix

1. **Native select text collides with the chevron** (visible bug). `.app-body .field select` / `.app-body .toolbar .select select` set `padding: .5rem .875rem`, overriding `.select select { padding-inline-end: 2.25rem }`. Add after the field block in app.css:
   `.app-body .field select, .app-body .toolbar .select select { padding-inline-end: 2.5rem; }`
2. **Password input text runs under "Show"** (probable, depends on load order; equal specificity with `global.css` `.field .pw-input input { padding-inline-end: 4.25rem }`). Add:
   `.app-body .field .pw-input input { padding-inline-end: 4.25rem; }`
3. **Drawer body is muted and 14.4px.** Add:
   `.drawer-body { color: var(--popover-foreground); font-size: var(--fs-body-sm); }`
4. **Table edge padding and wrapping.** Source cells are `px-3`, `whitespace-nowrap`. Remove the `th/td:first-child` and `:last-child` `padding-inline` 1.25rem rules (app.css ~3202-3210) or keep only inside `.card-flush`; add `.data-table td { white-space: nowrap }` for desktop (>720px). A standalone DataTable also needs `.table-wrap { border:1px solid var(--border); border-radius: var(--r-lg); background: var(--card); }` (skip inside `.card-flush`).
5. **Dialog/Drawer close button** is 32px inline; source is a 44px ghost icon at top 8 / right 8. Add `.modal-box { position: relative } .modal-head > .icon-button, .drawer-head > .icon-button { position:absolute; top:.5rem; right:.5rem; width:2.75rem; height:2.75rem }` and give `.modal-head`/`.drawer-head` `padding-right: 3.25rem`. Add `@media (max-width:640px){ .modal-foot { flex-direction: column-reverse } }`.
6. **Progress caps are elliptical and static.** Replace the svg with `<div class="progress" role="progressbar"><span style="--w:..">` using `.progress{height:.5rem;border-radius:999px;background:var(--surface-muted);overflow:hidden}` and a fill `border-radius:999px;background:var(--primary);transition:width 500ms ease-out` (width via CSSOM since a CSP forbids `style=""`).
7. **Checkbox invalid state missing and disabled compounds.** Add `.checkbox input[aria-invalid='true'] { border-color: var(--destructive); box-shadow: 0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent) }`; change `.checkbox[data-disabled]` opacity to 1 (the input already dims to .5).
8. **Switch disabled opacity** `.55` -> `.5`: `.switch:disabled { opacity: .5 }`.
9. **Tooltip arrow missing:** add `.tooltip-content::after { content:''; position:absolute; left:50%; top:100%; width:.625rem; height:.625rem; background:inherit; border-radius:2px; transform:translate(-50%,-50%) rotate(45deg) }`.
10. **Badge/Notice/Button icon sizes:** Badge icon 14 -> 12 (display.tsx 163), Notice icon 18 -> 16 (display.tsx 285), `ICON_SIZE.xs` 14 -> 12 (button.tsx 25).
11. **Avatar ring:** `.avatar::after { content:''; position:absolute; inset:0; border-radius:50%; border:1px solid var(--border) }` (only on span avatars; for `img` wrap or use `outline:1px solid var(--border); outline-offset:-1px`).
12. **Missing solid RSVP badges** (`going/maybe/no/waitlist`, `signal`): add `.badge-going{background:var(--rsvp-going);color:var(--rsvp-going-foreground)}` etc. and extend `BadgeTone`.
13. **PageHeader band** (hairline, `leading`/`badge` slots, sticky) to match shared/PageHeader.
14. **Missing components** needed by later ports: Popover, Accordion, Calendar, Command, Pagination, generic Separator (`.separator{height:1px;background:var(--border)}`), Tabs line variant.
15. Dark-mode nits: input/select/textarea dark bg should be `color-mix(in oklab, var(--input) 30%, transparent)` and dark active tab `input/30` with `border: 1px solid var(--input)`.
16. Skeleton: wrap the parity animation in `@media (prefers-reduced-motion: no-preference)`.

## Fix status (this pass)

Fixed in the "Design parity" block of app.css plus display.tsx, button.tsx, icon.tsx: defects 1-12 and 16 (skeleton untouched: reduced-motion nit left). Remaining DIFF rows are structural by design or need new features (rows 12, 15, 20, 21, 23, 36, 37, PageHeader band, LoadingSkeleton layouts, dark-mode input tint) and were not changed.
