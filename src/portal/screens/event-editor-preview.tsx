import {useQuery} from '@tanstack/react-query';

import {fromLocalInput} from '../../lib/event-schemas';
import {formatDay, formatPrice, formatRange, guestCopy, paragraphsOf, priceSummary} from '../../lib/guest-format';
import {POSTER_HEX, POSTER_PALETTES} from '../../lib/event-schemas';
import {isPosterDesign, posterFor, posterTextFor, type PosterPalette} from '../../lib/posters';
import {PosterArt} from './cover-picker';
import {eventTicketsQuery} from '../events-queries';
import {Icon} from '../ui';

export type PreviewValues = {
  title: string;
  description: string;
  coverImageUrl: string;
  coverPoster: string;
  palette: string;
  headline: string;
  eyebrow: string;
  footer: string;
  timezone: string;
  startAt: string;
  endAt: string;
  format: string;
  venueName: string;
  venueAddress: string;
  capacity: string;
};

/**
 * The public event page as the form currently describes it, in the portal's own classes (the
 * public `g-*` stylesheet is global and only loaded on public pages, so it is not imported here).
 * Ticket types are the saved ones: they are edited and saved on their own.
 */
export function EventPreview({values: v, eventId, seed = ''}: {values: PreviewValues; eventId: string | null; seed?: string}) {
  const tickets = useQuery({...eventTicketsQuery(eventId ?? ''), enabled: eventId !== null});
  const ticketTypes = eventId ? (tickets.data?.ticketTypes ?? []) : [];
  const startIso = fromLocalInput(v.startAt, v.timezone);
  const endIso = fromLocalInput(v.endAt, v.timezone);
  const title = v.title.trim() || 'Untitled event';
  const poster = posterTextFor({title, startAt: startIso, timezone: v.timezone, format: v.format as 'in_person', venueName: v.venueName}, {headline: v.headline, eyebrow: v.eyebrow, footer: v.footer});
  const image = /^https?:\/\//i.test(v.coverImageUrl.trim()) ? v.coverImageUrl.trim() : '';
  const inPerson = v.format !== 'online';
  const online = v.format !== 'in_person';
  const capacity = Number(v.capacity);
  const paragraphs = paragraphsOf(v.description);
  const price = priceSummary(ticketTypes);

  return (
    <article className="ev-preview" aria-label="Preview of the public event page">
      <p className="ev-preview-note muted">Preview of what guests see. It updates as you type.</p>
      {image ? (
        <img className="ev-preview-cover" src={image} alt={`Cover art for ${title}`} width={288} height={384} />
      ) : (
        <div className="ev-preview-posterbox" role="img" aria-label={`Poster for ${title}`}>
          <PosterArt design={isPosterDesign(v.coverPoster) ? v.coverPoster : posterFor(seed || title)} palette={(POSTER_PALETTES as readonly string[]).includes(v.palette) || POSTER_HEX.test(v.palette) ? v.palette : null} text={poster} />
        </div>
      )}
      <ul aria-label="Event type" className="ev-preview-chips">
        <li>{guestCopy.format[v.format] ?? v.format}</li>
        <li>{price}</li>
      </ul>
      <h2 className="ev-preview-title">{title}</h2>

      <section className="ev-preview-fact" aria-label="When">
        <Icon name="clock" size={16} />
        <div>
          <h3>{guestCopy.sections.when}</h3>
          {startIso ? (
            <p>
              <strong>{formatDay(startIso, v.timezone)}</strong>
              <br />
              {formatRange(startIso, endIso ?? undefined, v.timezone)}
            </p>
          ) : (
            <p className="muted">Pick a start date and time.</p>
          )}
        </div>
      </section>
      <section className="ev-preview-fact" aria-label="Where">
        <Icon name="globe" size={16} />
        <div>
          <h3>{guestCopy.sections.where}</h3>
          {inPerson && (v.venueName || v.venueAddress) && (
            <p>
              <strong>{v.venueName}</strong>
              {v.venueAddress && <span className="muted"> {v.venueAddress}</span>}
            </p>
          )}
          {online && <p>{guestCopy.location.onlineTitle}. <span className="muted">{guestCopy.location.onlineNote}</span></p>}
          {inPerson && !v.venueName && !v.venueAddress && <p className="muted">Add a venue.</p>}
        </div>
      </section>
      {paragraphs.length > 0 && (
        <section className="ev-preview-block" aria-label="About">
          <h3>{guestCopy.sections.about}</h3>
          {paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </section>
      )}
      <section className="ev-preview-block" aria-label="Tickets and capacity">
        <h3>Tickets</h3>
        {ticketTypes.length === 0 ? (
          <p className="muted">{eventId ? 'No ticket types: RSVPs are free.' : 'Free RSVPs. Save the draft to add ticket types.'}</p>
        ) : (
          <ul className="ev-preview-tickets">
            {ticketTypes.map(t => (
              <li key={t.id}>
                <span>{t.name}</span>
                <strong>{formatPrice(t.priceCents, t.currency)}</strong>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">{Number.isFinite(capacity) && capacity > 0 ? `${capacity} seats in total.` : 'No capacity limit.'}</p>
      </section>
    </article>
  );
}
