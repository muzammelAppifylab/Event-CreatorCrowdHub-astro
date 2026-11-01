import {useEffect, useRef} from 'react';

import {type BrandContrastReport, checkBrandContrast, type FontPreset, normalizeHex} from '../../lib/event-brand';
import {POSTER_DESIGNS} from '../../lib/event-schemas';
import {type PosterDesign} from '../../lib/posters';
import {Button, Notice} from '../ui';

export type BrandDraft = {state: 'default'} | {state: 'invalid'} | {state: 'ok'; hex: string; report: BrandContrastReport};

/** What a draft colour field means: blank = default ink, unparseable = invalid, else the colour with its AA report. */
export function resolveBrandDraft(input: string): BrandDraft {
  if (input.trim() === '') return {state: 'default'};
  const hex = normalizeHex(input);
  return hex ? {state: 'ok', hex, report: checkBrandContrast(hex)} : {state: 'invalid'};
}

/** The custom properties the preview wrapper needs (the theme reads --primary*, resolved at :root, so they are set directly). */
export function previewVars(draft: BrandDraft): Record<string, string> {
  if (draft.state !== 'ok') return {};
  const vars: Record<string, string> = {
    '--primary': draft.hex,
    '--brand': draft.hex,
    '--primary-foreground': draft.report.foreground,
    '--brand-foreground': draft.report.foreground,
  };
  if (draft.report.textPassesAA) {
    vars['--primary-text'] = draft.hex;
    vars['--brand-text'] = draft.hex;
  }
  return vars;
}

const VAR_NAMES = ['--primary', '--brand', '--primary-foreground', '--brand-foreground', '--primary-text', '--brand-text'];

export function posterLabel(design: PosterDesign | ''): string {
  return design === '' ? 'Automatic' : design[0]!.toUpperCase() + design.slice(1);
}

/** Poster choices with a colour swatch each (`.bp-sw-*` in screens.css). */
export function PosterPicker({value, onChange}: {value: string; onChange: (v: string) => void}) {
  const options: ('' | PosterDesign)[] = ['', ...POSTER_DESIGNS];
  return (
    <fieldset className="bp-posters">
      <legend>Default poster</legend>
      <div className="bp-poster-grid">
        {options.map(design => (
          <label key={design || 'auto'} className="bp-poster">
            <input type="radio" name="defaultPoster" value={design} checked={value === design} onChange={() => onChange(design)} />
            <span className={`bp-swatch bp-sw-${design || 'auto'}`} aria-hidden="true" />
            <span className="bp-poster-name">{posterLabel(design)}</span>
          </label>
        ))}
      </div>
      <p className="muted">Used for new events with no cover image. “Automatic” picks one per event.</p>
    </fieldset>
  );
}

/** Live preview: event card, RSVP button and email header with the draft brand, set through CSSOM on the wrapper. */
export function BrandPreview({color, font, poster, siteName}: {color: string; font: FontPreset; poster: string; siteName: string}) {
  const wrap = useRef<HTMLDivElement>(null);
  const draft = resolveBrandDraft(color);
  const vars = JSON.stringify(previewVars(draft));
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    for (const name of VAR_NAMES) el.style.removeProperty(name);
    for (const [name, value] of Object.entries(JSON.parse(vars) as Record<string, string>)) el.style.setProperty(name, value);
    if (font === 'inter') el.removeAttribute('data-font-preset');
    else el.setAttribute('data-font-preset', font);
  }, [vars, font]);
  const fmt = (n: number) => n.toFixed(1);
  return (
    <aside aria-label="Brand preview" className="bp-preview">
      <p className="bp-label">Live preview</p>
      {draft.state === 'invalid' && <Notice tone="warning">Enter a hex colour like #4f46e5 to preview it.</Notice>}
      {draft.state === 'ok' && !draft.report.fillPassesAA && (
        <Notice tone="warning" title="Low contrast">
          Button text on this colour reaches only {fmt(draft.report.onBrand)}:1 (WCAG AA needs 4.5:1). Pick a darker or lighter colour.
        </Notice>
      )}
      {draft.state === 'ok' && draft.report.fillPassesAA && !draft.report.textPassesAA && (
        <Notice tone="info" title="Colour not used for links">
          On white this colour reaches {fmt(draft.report.onPaper)}:1, under AA (4.5:1), so links stay black. Buttons are fine.
        </Notice>
      )}
      {draft.state === 'ok' && draft.report.fillPassesAA && draft.report.textPassesAA && <Notice tone="success">Passes WCAG AA for buttons and links.</Notice>}
      <div ref={wrap} className="bp-stage">
        <article className="bp-card" aria-label="Event page preview">
          <div className={`bp-cover bp-sw-${poster || 'auto'}`} aria-hidden="true" />
          <div className="bp-body">
            <span className="bp-host">{siteName}</span>
            <h3 className="bp-title">Founders Breakfast</h3>
            <p className="muted">Sat 14 Nov · 9:00 AM · Ground Floor Café</p>
            <div className="bp-actions">
              <Button type="button" tabIndex={-1} aria-hidden="true" className="bp-rsvp">
                RSVP
              </Button>
              <span className="bp-link">Add to calendar</span>
            </div>
          </div>
        </article>
        <div className="bp-email" role="img" aria-label="Email header preview">
          <div className="bp-email-head">{siteName}</div>
          <div className="bp-email-body">
            <strong className="bp-title">You’re in!</strong>
            <span className="muted">See you Saturday at Founders Breakfast.</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
