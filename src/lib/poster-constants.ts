/**
 * The poster's fixed sets and colour rule, with NO imports: `posters.ts` (shipped in every public
 * page's poster script) reads them from here, so a page never pulls `event-schemas.ts` and its
 * date libraries in just to test a hex colour (audit M-30). `event-schemas.ts` re-exports them for the
 * server's validation: this file is the only place they are written.
 */
export const POSTER_DESIGNS = ['breakfast', 'launch', 'ama', 'mastermind', 'workshop', 'kickoff'] as const;
export const POSTER_PALETTES = ['butter', 'cobalt', 'night', 'plum', 'tomato', 'mint', 'cream', 'teal', 'pink'] as const;
/** A custom poster colour: `#rrggbb`, stored lower-cased. */
export const POSTER_HEX = /^#[0-9a-f]{6}$/;

export type PosterDesign = (typeof POSTER_DESIGNS)[number];
export type PosterPalette = (typeof POSTER_PALETTES)[number];
