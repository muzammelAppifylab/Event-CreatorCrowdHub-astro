/**
 * Event poster logic, ported from CreatorCrowdHub `src/lib/posters.ts` and the pure parts of
 * `components/shared/InvitePoster.tsx`. Dependency-free and browser-safe: the artwork itself is
 * `src/components/Poster.astro` + `src/styles/public.css` (classes `.poster*`).
 */
import type {CoverStyle} from './event-schemas';
import {POSTER_DESIGNS, POSTER_HEX, POSTER_PALETTES, type PosterDesign, type PosterPalette} from './poster-constants';

export type {CoverStyle, PosterDesign, PosterPalette};
export {POSTER_DESIGNS as posterDesigns, POSTER_PALETTES as posterPalettes};

export interface PosterText {
  headline: string;
  /** Small line above the headline (date, "Invite only"...). Empty hides it. */
  eyebrow: string;
  /** Small line under the headline (venue, tagline...). Empty hides it. */
  footer: string;
}

export const paletteLabel: Record<PosterPalette, string> = {
  butter: 'Butter',
  cobalt: 'Cobalt',
  night: 'Night',
  plum: 'Plum',
  tomato: 'Tomato',
  mint: 'Mint',
  cream: 'Cream',
  teal: 'Teal',
  pink: 'Pink',
};

/** Class for a palette value: a named set, or `poster-pal-custom` for a `#rrggbb` colour. */
export function paletteClass(palette: string): string {
  return POSTER_HEX.test(palette) ? 'poster-pal-custom' : `poster-pal-${palette}`;
}

/**
 * Colours for a custom background: readable ink (black or white by luminance). Applied with
 * `style.setProperty` (CSSOM, allowed by the CSP; a style attribute is not).
 */
export function applyPosterColor(el: HTMLElement, hex: string | null | undefined): void {
  const vars = ['--pb', '--pi', '--ps', '--pa', '--po'];
  if (!hex || !POSTER_HEX.test(hex)) {
    for (const name of vars) el.style.removeProperty(name);
    return;
  }
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const light = (0.299 * r! + 0.587 * g! + 0.114 * b!) / 255 > 0.6;
  const ink = light ? 'black' : 'white';
  el.style.setProperty('--pb', hex);
  el.style.setProperty('--pi', ink);
  el.style.setProperty('--ps', ink);
  el.style.setProperty('--pa', ink);
  el.style.setProperty('--po', hex);
}

/** The palette each design was drawn in; used when the creator has not picked one. */
export const defaultPalette: Record<PosterDesign, PosterPalette> = {
  breakfast: 'butter',
  launch: 'cobalt',
  ama: 'night',
  mastermind: 'plum',
  workshop: 'tomato',
  kickoff: 'mint',
};

export const sampleText: Record<PosterDesign, PosterText> = {
  breakfast: {eyebrow: 'Sat 09:00', headline: 'Founders Breakfast', footer: 'Ground Floor Café'},
  launch: {eyebrow: 'Course v2', headline: 'Launch night', footer: 'Doors 7pm'},
  ama: {eyebrow: 'Live on Zoom', headline: 'Ask me anything', footer: 'Pricing · Funnels · Burnout'},
  mastermind: {eyebrow: 'Invite only', headline: 'The Monthly Mastermind', footer: '12 seats · Thursday'},
  workshop: {eyebrow: '$49 · Saturday', headline: 'Pricing Workshop', footer: '30 seats · In person'},
  kickoff: {eyebrow: 'Cohort 07', headline: 'Kickoff party', footer: 'Bring a goal. Leave with a crew.'},
};

/** The text style of each layout, in words a host can choose by. */
export const designInfo: Record<PosterDesign, {name: string; style: string}> = {
  breakfast: {name: 'Bold stack', style: 'Tall condensed capitals'},
  launch: {name: 'Big modern', style: 'Heavy sans over a star'},
  ama: {name: 'Loud & tidy', style: 'Capitals with a pill'},
  mastermind: {name: 'Elegant serif', style: 'Centred, calm, formal'},
  workshop: {name: 'Workshop', style: 'Capitals with seat dots'},
  kickoff: {name: 'Friendly round', style: 'Soft rounded letters'},
};

export interface CoverTemplate {
  id: string;
  name: string;
  design: PosterDesign;
  palette: PosterPalette;
}

/** Ready-made looks: a layout in a colour set that suits it. One click sets both. */
export const COVER_TEMPLATES: readonly CoverTemplate[] = [
  {id: 'sunny', name: 'Sunny', design: 'breakfast', palette: 'butter'},
  {id: 'launch', name: 'Launch night', design: 'launch', palette: 'cobalt'},
  {id: 'midnight', name: 'Midnight', design: 'ama', palette: 'night'},
  {id: 'salon', name: 'Salon', design: 'mastermind', palette: 'plum'},
  {id: 'hot', name: 'Hot workshop', design: 'workshop', palette: 'tomato'},
  {id: 'fresh', name: 'Fresh', design: 'kickoff', palette: 'mint'},
  {id: 'classic', name: 'Classic', design: 'mastermind', palette: 'cream'},
  {id: 'teal-talk', name: 'Teal talk', design: 'ama', palette: 'teal'},
  {id: 'pink-pop', name: 'Pink pop', design: 'kickoff', palette: 'pink'},
  {id: 'neon', name: 'Neon launch', design: 'launch', palette: 'night'},
];

/** What each poster line is for, with an example in the chosen layout's voice. */
export const POSTER_LINES = {
  eyebrow: {
    label: 'Top line',
    hint: 'When or what kind: a date, "Invite only", "Live on Zoom".',
    max: 40,
  },
  headline: {
    label: 'Headline',
    hint: 'The event name in a few words. Long titles shrink to fit.',
    max: 80,
  },
  footer: {
    label: 'Bottom line',
    hint: 'Where, who or a hook: the venue, seats left, a tagline.',
    max: 60,
  },
} as const;

export function isPosterDesign(value: unknown): value is PosterDesign {
  return typeof value === 'string' && (POSTER_DESIGNS as readonly string[]).includes(value);
}

/**
 * Fallback cover for an event with no chosen poster or image: a stable authored poster derived
 * from its id (or title while unsaved).
 */
export function posterFor(seed: string): PosterDesign {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return POSTER_DESIGNS[Math.abs(hash) % POSTER_DESIGNS.length]!;
}

export interface PosterEventInfo {
  title: string;
  startAt?: string | null;
  timezone?: string | null;
  format?: 'in_person' | 'online' | 'hybrid' | null;
  venueName?: string | null;
}

/** "Sat 14 Nov · 19:00" in the event's zone (the 24-hour clock the guest pages use); "" when the date or zone is unusable. */
export function posterDate(startAt: string | null | undefined, timeZone: string | null | undefined): string {
  if (!startAt || Number.isNaN(Date.parse(startAt))) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || undefined,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(startAt));
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
    const time = `${get('hour')}:${get('minute')}`;
    return `${get('weekday')} ${get('day')} ${get('month')} · ${time}`;
  } catch {
    return '';
  }
}

const filled = (v: string | null | undefined) => (v?.trim() ? v.trim() : undefined);

/** What a poster says for this event: the creator's overrides, else title / date / place. */
export function posterTextFor(event: PosterEventInfo, style?: CoverStyle | null): PosterText {
  const place = event.format === 'online' ? 'Online' : (filled(event.venueName) ?? '');
  return {
    headline: filled(style?.headline) ?? event.title.trim(),
    eyebrow: filled(style?.eyebrow) ?? posterDate(event.startAt, event.timezone),
    footer: filled(style?.footer) ?? place,
  };
}

interface FitBox {
  /** Authored size in cqw; the headline never grows past it. */
  base: number;
  /** Usable width / height for the headline, in cqw. */
  width: number;
  height: number;
  lineHeight: number;
  /** Average glyph advance as a share of the font size (Anton is narrow, Young Serif wide). */
  glyph: number;
}

/**
 * Largest size (cqw) at which `text` wraps inside the box without breaking a word. Estimated from
 * glyph width rather than measured, so it is pure and the same in a 40px thumbnail and the hero.
 */
export function fitHeadline(text: string, box: FitBox): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return box.base;
  const min = box.base * 0.3;
  for (let size = box.base; size > min; size -= box.base / 40) {
    const perLine = Math.floor(box.width / (size * box.glyph));
    if (words.some(w => w.length > perLine)) continue;
    let lines = 1;
    let used = 0;
    for (const w of words) {
      const need = used === 0 ? w.length : used + 1 + w.length;
      if (need > perLine) {
        lines++;
        used = w.length;
      } else used = need;
    }
    if (lines * size * box.lineHeight <= box.height) return size;
  }
  return min;
}

/** Each design's headline box (the authored values of the source's InvitePoster). */
export const headlineBox: Record<PosterDesign, FitBox> = {
  breakfast: {base: 25, width: 84, height: 82, lineHeight: 0.9, glyph: 0.47},
  launch: {base: 22, width: 84, height: 50, lineHeight: 0.86, glyph: 0.56},
  ama: {base: 27, width: 84, height: 80, lineHeight: 0.9, glyph: 0.47},
  mastermind: {base: 14, width: 82, height: 62, lineHeight: 1.02, glyph: 0.7},
  workshop: {base: 17, width: 84, height: 48, lineHeight: 0.9, glyph: 0.47},
  kickoff: {base: 19, width: 84, height: 70, lineHeight: 0.9, glyph: 0.52},
};

/**
 * The headline size as a whole number of cqw (`.poster-fs-N` in public.css, 4 to 27): the CSP
 * forbids a style attribute, so the fitted size is rounded DOWN to the nearest class.
 */
export function headlineStep(design: PosterDesign, text: string): number {
  return Math.max(4, Math.min(27, Math.floor(fitHeadline(text, headlineBox[design]))));
}
