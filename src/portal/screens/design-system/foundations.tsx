import '../../../styles/design-system.css';

import {Card, Icon, ICON_NAMES} from '../../ui';

/** Foundations of the Marquee design system: colour, type, radii, shadows, spacing, motion, icons. */

const SEMANTIC = [
  'background', 'foreground', 'surface-sunken', 'surface-muted', 'card', 'popover', 'primary', 'primary-text', 'secondary',
  'accent-bg', 'destructive', 'border', 'border-strong', 'input', 'control-off', 'ring', 'muted-foreground', 'subtle-foreground',
  'sidebar', 'sidebar-accent',
];
const INK = [
  ['ink-1000', 'Text, pills, bands', 'on-dark'],
  ['ink-800', 'Dark surface', 'on-dark'],
  ['ink-700', 'Secondary text', 'on-dark'],
  ['ink-600', 'Muted text', 'on-dark'],
  ['ink-500', 'Lowest text grey', 'on-dark'],
  ['ink-300', 'Disabled fills', 'on-light'],
  ['ink-200', 'Hairlines, inputs', 'on-light'],
  ['ink-100', 'Poster backing', 'on-light'],
  ['paper', 'Canvas', 'on-light'],
] as const;
const RSVP = [
  ['Going', 'rsvp-going'],
  ['Maybe', 'rsvp-maybe'],
  ["Can't go", 'rsvp-no'],
  ['Waitlist', 'rsvp-waitlist'],
] as const;
const POSTER = ['tomato', 'pink', 'lime', 'cobalt', 'teal', 'butter', 'plum', 'cream'];
const WASH = ['party', 'sky', 'spearmint', 'aura'];
const TYPE = [
  ['Poster', 'Anton · uppercase · stacked', 'Doors at seven', 'type-poster t-poster', 'Hero headlines only.'],
  ['Display', 'Bricolage Grotesque 650 · -0.03em', 'Pricing Workshop', 'type-display t-display', 'Event and section titles.'],
  ['Heading', 'Hanken Grotesk 700 · 32px', 'Guests and leads', 't-heading', 'Admin page titles.'],
  ['Title', 'Hanken Grotesk 700 · 24px', 'Reminder sent to 45 guests', 't-title', 'Card and dialog titles.'],
  ['Body', 'Hanken Grotesk 400 · 16px', 'Bring a laptop and one pricing page you want torn apart.', 't-body', 'Default. 14px in dense tables.'],
  ['Label', 'Hanken Grotesk 700 · 12px · +0.06em · uppercase', 'Get tickets · Waitlist open', 'type-label', 'Buttons, table heads, metadata.'],
  ['Code', 'JetBrains Mono 600 · +0.12em', 'K7Q-42X', 'type-code t-title', 'Join codes and ticket codes only.'],
] as const;
const RADII = [
  ['r-xs', 4, 'ds-r-xs'],
  ['r-sm', 8, 'ds-r-sm'],
  ['r-md', 12, 'ds-r-md'],
  ['r-lg', 16, 'ds-r-lg'],
  ['r-xl', 24, 'ds-r-xl'],
  ['r-pill', 999, 'ds-r-pill'],
] as const;
const SPACE = [1, 2, 3, 4, 6, 8, 12, 16] as const;

function Tile({token, className, tall}: {token: string; className: string; tall?: boolean}) {
  return (
    <div className="ds-tile">
      <span className={`ds-chip ${tall ? 'ds-chip-tall ' : ''}${className}`} />
      <code>--{token}</code>
    </div>
  );
}

export function Foundations() {
  return (
    <div className="kit-section">
      <Card title="Ink and paper" description="Black and white run the interface. Saturated colour lives in artwork, RSVP states and one mint screen.">
        <ol className="ds-ramp">
          {INK.map(([token, role, on]) => (
            <li key={token} className={`bg-t-${token} ${on}`}>
              <span>{token}</span>
              <span>{role}</span>
            </li>
          ))}
        </ol>
      </Card>
      <Card title="Semantic colour tokens" description="Read from the CSS variables, so they follow light, dark and the workspace brand.">
        <div className="ds-grid">
          {SEMANTIC.map(name => (
            <Tile key={name} token={name} className={`bg-t-${name}`} />
          ))}
        </div>
      </Card>
      <div className="grid-2">
        <Card title="RSVP states" description="Solid for one loud state, soft for lists.">
          <div className="ds-grid">
            {RSVP.map(([label, token]) => (
              <div key={token} className="form-stack">
                <Tile token={token} className={`bg-t-${token}`} />
                <Tile token={`${token}-soft`} className={`bg-t-${token}-soft`} />
                <span className="type-label">{label}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Signal and charts" description="Signal: confirmation screens only.">
          <div className="form-stack">
            <div className="ds-signal">
              <span className="type-poster">You're in</span>
              <span>Mint paints this one screen. Nothing else borrows it.</span>
            </div>
            <div className="ds-grid">
              {[1, 2, 3, 4, 5].map(n => (
                <Tile key={n} token={`chart-${n}`} className={`bg-t-chart-${n}`} />
              ))}
            </div>
          </div>
        </Card>
      </div>
      <Card title="Poster palette" description="Artwork only. These never become UI tokens.">
        <div className="ds-grid">
          {POSTER.map(name => (
            <Tile key={name} token={`poster-${name}`} className={`bg-t-poster-${name}`} tall />
          ))}
        </div>
      </Card>
      <Card title="Washes" description="Surfaces only. Never on a button, input or text.">
        <div className="ds-grid">
          {WASH.map(name => (
            <div key={name} className={`ds-wash bg-t-wash-${name}`}>
              <code>--wash-{name}</code>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Typography" description="Loud headline, quiet interface. The .type-* utilities plus the scale.">
        <ul>
          {TYPE.map(([name, meta, sample, className, rule]) => (
            <li key={name} className="ds-type-row">
              <div className="ds-meta">
                <strong>{name}</strong>
                <span>{meta}</span>
                <span>{rule}</span>
              </div>
              <p className={className}>{sample}</p>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Radii" description="Every button, badge, tab and toggle is a pill; inputs and cards 12; dialogs 16; feature panels 24.">
        <div className="ds-grid">
          {RADII.map(([token, px, cls]) => (
            <div key={token} className="ds-tile">
              <span className={`ds-demo ${cls}`}>{px === 999 ? 'pill' : `${px}px`}</span>
              <code>--{token}</code>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Shadows" description="Flat in the page. Shadows only on what floats.">
        <div className="ds-surface-band">
          <div className="ds-grid">
            <div className="ds-tile">
              <span className="ds-demo ds-flat">Card in flow</span>
              <code>border</code>
            </div>
            <div className="ds-tile">
              <span className="ds-demo ds-r-md ds-elev-1">Toast</span>
              <code>--elev-1</code>
            </div>
            <div className="ds-tile">
              <span className="ds-demo ds-r-lg ds-elev-2">Menu</span>
              <code>--elev-2</code>
            </div>
            <div className="ds-tile">
              <span className="ds-demo ds-r-lg ds-elev-3">Dialog</span>
              <code>--elev-3</code>
            </div>
          </div>
        </div>
      </Card>
      <div className="grid-2">
        <Card title="Spacing">
          <div className="form-stack">
            {SPACE.map(n => (
              <div key={n} className={`ds-space ds-space-${n}`}>
                <span>space-{n}</span>
                <i />
                {n * 4}px
              </div>
            ))}
          </div>
        </Card>
        <Card title="Motion">
          <dl className="ds-motion">
            <dt>Ease out</dt>
            <dd>Expo out (0.16, 1, 0.3, 1). The default.</dd>
            <dt>Snap</dt>
            <dd>Quint out (0.22, 1, 0.36, 1). Choice and vote tap.</dd>
            <dt>160 / 240 ms</dt>
            <dd>Hover and press / menus, tabs, card lift.</dd>
            <dt>700 ms</dt>
            <dd>The invite deal. Once per page.</dd>
          </dl>
        </Card>
      </div>
      <Card title="Icons" description={`<Icon name="…" />, ${ICON_NAMES.length} of them. Add more from lucide.dev in ui/icon.tsx.`}>
        <div className="kit-icons">
          {ICON_NAMES.map(name => (
            <div key={name} className="kit-icon">
              <Icon name={name} size={20} />
              {name}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
