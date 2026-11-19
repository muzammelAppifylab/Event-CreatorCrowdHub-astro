import {useEffect, useRef, useState} from 'react';

import {POSTER_DESIGNS, POSTER_HEX, POSTER_PALETTES, POSTER_PRESETS} from '../../lib/event-schemas';
import {
  applyPosterColor,
  COVER_TEMPLATES,
  paletteClass,
  defaultPalette,
  designInfo,
  headlineStep,
  isPosterDesign,
  paletteLabel,
  posterDate,
  posterFor,
  POSTER_LINES,
  posterTextFor,
  type PosterDesign,
  type PosterPalette,
  type PosterText,
} from '../../lib/posters';
import {Button, Card, Field, Icon} from '../ui';

const STAR = 'M50 0 61 32 95 25 70 50 95 75 61 68 50 100 39 68 5 75 30 50 5 25 39 32Z';
const DOTS = Array.from({length: 10}, (_, i) => i < 7);

/**
 * The poster artwork for the dashboard: the same markup and classes as `components/Poster.astro`
 * (styles in `styles/poster.css`), so the editor shows exactly what guests get. Keep the two in step.
 */
export function PosterArt({design, text, palette}: {design: PosterDesign; text: PosterText; palette?: string | null}) {
  const ref = useRef<HTMLDivElement>(null);
  const custom = palette && POSTER_HEX.test(palette) ? palette : null;
  useEffect(() => {
    if (ref.current) applyPosterColor(ref.current, custom);
  }, [custom]);
  const step = headlineStep(design, text.headline);
  const line = [text.eyebrow, text.footer].filter(Boolean).join(' · ');
  const star = (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <path fill="currentColor" d={STAR} />
    </svg>
  );
  return (
    <div ref={ref} className={`poster ${paletteClass(palette ?? defaultPalette[design])} poster-${design}`} aria-hidden="true">
      {design === 'breakfast' && (
        <div className="poster-in poster-between">
          <p className="poster-small poster-trunc">{text.eyebrow}</p>
          <p className={`poster-h poster-h-poster poster-fs-${step}`}>{text.headline}</p>
          <div className="poster-foot">
            <span className="poster-footer poster-trunc">{text.footer}</span>
            <span className="poster-badge">{star}</span>
          </div>
        </div>
      )}
      {design === 'launch' && (
        <div className="poster-in poster-end">
          <svg viewBox="0 0 100 100" className="poster-star" aria-hidden="true">
            <path fill="currentColor" d={STAR} />
          </svg>
          <p className={`poster-h poster-h-display poster-fs-${step}`}>{text.headline}</p>
          {line && <p className="poster-small poster-line">{line}</p>}
        </div>
      )}
      {design === 'ama' && (
        <div className="poster-in">
          <p className="poster-small poster-trunc">{text.eyebrow}</p>
          <p className={`poster-h poster-h-poster poster-push poster-fs-${step}`}>{text.headline}</p>
          {text.footer && <span className="poster-pill">{text.footer}</span>}
        </div>
      )}
      {design === 'mastermind' && (
        <div className="poster-in poster-center">
          {text.eyebrow && <span className="poster-eyebrow-wide">{text.eyebrow}</span>}
          <span className="poster-rule" />
          <p className={`poster-h poster-h-serif poster-fs-${step}`}>{text.headline}</p>
          <span className="poster-rule" />
          {text.footer && <span className="poster-footer-clamp">{text.footer}</span>}
        </div>
      )}
      {design === 'workshop' && (
        <div className="poster-in">
          {text.eyebrow && <p className="poster-small poster-trunc poster-mb">{text.eyebrow}</p>}
          <p className={`poster-h poster-h-poster poster-fs-${step}`}>{text.headline}</p>
          <div className="poster-dots">
            {DOTS.map((on, i) => (
              <span key={i} className={on ? 'poster-dot poster-dot-on' : 'poster-dot'} />
            ))}
          </div>
          {text.footer && <p className="poster-small poster-trunc poster-mt">{text.footer}</p>}
        </div>
      )}
      {design === 'kickoff' && (
        <div className="poster-in poster-between">
          {text.eyebrow ? <span className="poster-tag">{text.eyebrow}</span> : <span />}
          <p className={`poster-h poster-h-rounded poster-fs-${step}`}>{text.headline}</p>
          <p className="poster-footer-clamp poster-footer-sub">{text.footer}</p>
        </div>
      )}
    </div>
  );
}

export type CoverValues = {
  coverPoster: string;
  coverImageUrl: string;
  palette: string;
  headline: string;
  eyebrow: string;
  footer: string;
};

type CoverField = keyof CoverValues;

interface Props {
  values: CoverValues;
  /** Event facts the poster can quote. `startAt` is an ISO instant or null. */
  event: {title: string; startAt: string | null; timezone: string; format: string; venueName: string; capacity: string};
  /** Picks the automatic layout, like the public page (event id, else the title). */
  seed: string;
  set: (name: CoverField, value: string) => void;
  error: (name: CoverField) => string | undefined;
  inputProps: (name: CoverField) => Record<string, unknown>;
}

/**
 * The Cover card: ready-made looks, then every part adjustable (layout, colours, the three lines),
 * or the host's own image. A live poster beside it shows the result as guests see it.
 */
export function CoverPicker({values: v, event, seed, set, error, inputProps}: Props) {
  const [mode, setMode] = useState<'poster' | 'image'>(v.coverImageUrl.trim() ? 'image' : 'poster');
  const remembered = useRef(v.coverImageUrl);

  const design: PosterDesign = isPosterDesign(v.coverPoster) ? v.coverPoster : posterFor(seed || event.title);
  const palette = (POSTER_PALETTES as readonly string[]).includes(v.palette) || POSTER_HEX.test(v.palette) ? v.palette : null;
  const customHex = POSTER_HEX.test(v.palette) ? v.palette : null;
  const title = event.title.trim() || 'Your event title';
  const info = {title, startAt: event.startAt, timezone: event.timezone, format: event.format as 'in_person', venueName: event.venueName};
  const style = {headline: v.headline, eyebrow: v.eyebrow, footer: v.footer};
  const textFor = posterTextFor(info, style);
  const image = /^https?:\/\//i.test(v.coverImageUrl.trim()) ? v.coverImageUrl.trim() : '';

  const date = posterDate(event.startAt, event.timezone);
  const place = event.format === 'online' ? 'Online' : event.venueName.trim();
  const seats = Number(event.capacity) > 0 ? `${Number(event.capacity)} seats` : '';
  const customised = Boolean(v.headline || v.eyebrow || v.footer);

  const switchMode = (next: 'poster' | 'image') => {
    if (next === mode) return;
    if (next === 'poster') {
      remembered.current = v.coverImageUrl || remembered.current;
      set('coverImageUrl', '');
    } else set('coverImageUrl', remembered.current);
    setMode(next);
  };
  const useTemplate = (t: (typeof COVER_TEMPLATES)[number]) => {
    set('coverPoster', t.design);
    set('palette', t.palette);
  };
  const lines = (['eyebrow', 'headline', 'footer'] as const).map(name => {
    const line = POSTER_LINES[name];
    const placeholder = name === 'headline' ? title : name === 'eyebrow' ? date : place;
    return (
      <Field
        key={name}
        id={`f-${name}`}
        label={line.label}
        optional
        hint={
          <>
            {line.hint} <span className="cp-count">{v[name].length}/{line.max}</span>
          </>
        }
        error={error(name)}>
        <input {...inputProps(name)} maxLength={line.max} placeholder={placeholder} autoComplete="off" />
      </Field>
    );
  });

  return (
    <Card title="Cover" description="The first thing guests see. Pick a ready-made poster, adjust it, or use your own image.">
      <div className="cp">
        <div className="cp-controls">
          <div className="cp-mode" role="group" aria-label="Cover type">
            <Button type="button" size="sm" variant={mode === 'poster' ? 'primary' : 'secondary'} aria-pressed={mode === 'poster'} onClick={() => switchMode('poster')}>
              Poster
            </Button>
            <Button type="button" size="sm" variant={mode === 'image' ? 'primary' : 'secondary'} aria-pressed={mode === 'image'} onClick={() => switchMode('image')}>
              My own image
            </Button>
          </div>

          {mode === 'image' ? (
            <div className="form-stack">
              <Field id="f-coverImageUrl" label="Image link" hint="A public https link to a 3:4 portrait image (for example 1200 × 1600). Keep any text near the middle: it is cropped on small screens." error={error('coverImageUrl')}>
                <input {...inputProps('coverImageUrl')} inputMode="url" placeholder="https://…" />
              </Field>
              <p className="muted cp-note">
                <Icon name="info" size={14} /> No image link yet? Guests see your poster instead. Switch back to Poster any time; your link is remembered.
              </p>
            </div>
          ) : (
            <div className="form-stack">
              <fieldset className="cp-set">
                <legend>Ready-made looks</legend>
                <div className="cp-grid cp-grid-templates">
                  {COVER_TEMPLATES.map(t => {
                    const on = design === t.design && (palette ?? defaultPalette[design]) === t.palette && isPosterDesign(v.coverPoster);
                    return (
                      <label key={t.id} className="cp-tile" data-on={on ? '' : undefined}>
                        <input type="radio" name="cover-template" checked={on} onChange={() => useTemplate(t)} />
                        <PosterArt design={t.design} palette={t.palette} text={textFor} />
                        <span className="cp-tile-name">{t.name}</span>
                        {on && (
                          <span className="cp-check" aria-hidden="true">
                            <Icon name="check" size={12} />
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset className="cp-set">
                <legend>Text style</legend>
                <div className="cp-grid cp-grid-designs">
                  {[{value: '', name: 'Automatic', style: 'We pick one for you'}, ...POSTER_DESIGNS.map(d => ({value: d as string, ...designInfo[d]}))].map(d => (
                    <label key={d.value || 'auto'} className="cp-chip" data-on={v.coverPoster === d.value ? '' : undefined}>
                      <input type="radio" name="cover-design" checked={v.coverPoster === d.value} onChange={() => set('coverPoster', d.value)} />
                      <span className="cp-chip-name">{d.name}</span>
                      <span className="cp-chip-sub">{d.style}</span>
                      {v.coverPoster === d.value && (
                        <span className="cp-check" aria-hidden="true">
                          <Icon name="check" size={12} />
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="cp-set">
                <legend>Colours</legend>
                <div className="cp-swatches">
                  {['', ...POSTER_PRESETS].map(p => {
                    const shown = (p || defaultPalette[design]) as PosterPalette;
                    const on = v.palette === p;
                    return (
                      <label key={p || 'default'} className="cp-swatch-label" data-on={on ? '' : undefined}>
                        <input type="radio" name="cover-palette" checked={on} onChange={() => set('palette', p)} />
                        <span className={`cp-swatch poster-pal-${shown}`} aria-hidden="true" />
                        <span className="cp-swatch-name">{p ? paletteLabel[p as PosterPalette] : 'Layout’s own'}</span>
                      </label>
                    );
                  })}
                  <label className="cp-swatch-label" data-on={customHex ? '' : undefined}>
                    <input
                      type="color"
                      name="cover-palette-custom"
                      aria-label="Custom colour"
                      value={customHex ?? '#6d28d9'}
                      onChange={e => set('palette', e.target.value.toLowerCase())}
                    />
                    <span className="cp-swatch cp-swatch-custom" aria-hidden="true" />
                    <span className="cp-swatch-name">{customHex ? `Custom ${customHex}` : 'Custom colour'}</span>
                  </label>
                </div>
              </fieldset>

              <fieldset className="cp-set">
                <legend>Words on the poster</legend>
                <p className="muted cp-note">Leave a line blank and it fills itself from the event (title, date, venue). Type to say something different.</p>
                <div className="form-stack">{lines}</div>
                <div className="cp-fills" role="group" aria-label="Quick fills">
                  {place && (
                    <Button type="button" size="sm" variant="secondary" onClick={() => set('footer', place)}>
                      Bottom: {event.format === 'online' ? 'online' : 'venue'}
                    </Button>
                  )}
                  {seats && (
                    <Button type="button" size="sm" variant="secondary" onClick={() => set('footer', seats)}>
                      Bottom: seats
                    </Button>
                  )}
                  {customised && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        set('headline', '');
                        set('eyebrow', '');
                        set('footer', '');
                      }}>
                      Reset words
                    </Button>
                  )}
                </div>
              </fieldset>
            </div>
          )}
        </div>

        <figure className="cp-preview">
          <div className="cp-preview-art" role="img" aria-label={`Cover preview for ${title}`}>
            {mode === 'image' && image ? <img src={image} alt="" width={288} height={384} /> : <PosterArt design={design} palette={palette} text={textFor} />}
          </div>
          <figcaption className="muted">{mode === 'image' && image ? 'Your image' : `${designInfo[design].name} · ${customHex ?? paletteLabel[(palette ?? defaultPalette[design]) as PosterPalette]}`}</figcaption>
        </figure>
      </div>
    </Card>
  );
}
