import {useQuery} from '@tanstack/react-query';
import {Link, useParams} from '@tanstack/react-router';

import {type ContactDetail as Detail, contactDetailQuery} from '../guests-queries';
import {ago, when} from '../shared';
import {Avatar, Badge, Button, buttonClass, Card, DefinitionList, EmptyState, ErrorNote, Icon, type IconName, LoadingBlock, Notice, useToast} from '../ui';

type Rsvp = Detail['rsvps'][number];

const RESPONSE_LABEL = {going: 'Going', maybe: 'Maybe', not_going: "Can't go"} as const;
const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  waitlisted: 'Waitlisted',
  pending_approval: 'Awaiting approval',
  awaiting_payment: 'Awaiting payment',
  declined: 'Declined',
  cancelled: 'Cancelled',
};

const month = (iso: string) => new Intl.DateTimeFormat('en', {month: 'long', year: 'numeric'}).format(new Date(iso));

function iconFor(r: Rsvp): IconName {
  if (r.checkedInAt || r.attended) return 'check-circle';
  if (r.response === 'not_going') return 'x';
  if (r.status === 'waitlisted' || r.status === 'pending_approval') return 'clock';
  return 'calendar';
}

function headline(r: Rsvp) {
  if (r.checkedInAt) return 'Checked in to';
  if (r.response === 'not_going') return "Can't make it to";
  if (r.response === 'maybe') return 'Maybe going to';
  return 'RSVP’d to';
}

/** The route component: reads the contact's key (one of their RSVP ids, never the email) from the path. */
export function ContactDetailPage() {
  const {key} = useParams({strict: false}) as {key?: string};
  return <ContactDetail contactKey={key ?? ''} />;
}

/** `/dashboard/contacts/$key`: one person across every event, as a profile beside a timeline. */
export function ContactDetail({contactKey}: {contactKey: string}) {
  const query = useQuery(contactDetailQuery(contactKey));
  const toast = useToast();
  const data = query.data;
  const c = data?.contact;
  const email = c?.email ?? '';

  // Group the timeline by the month the RSVP was made.
  const groups: {label: string; items: Rsvp[]}[] = [];
  for (const r of data?.rsvps ?? []) {
    const label = month(r.createdAt);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(r);
    else groups.push({label, items: [r]});
  }

  return (
    <div className="app-page screen-contact-detail">
      <header className="hub-head">
        <Link className="hub-crumb" to={'/contacts' as never}>
          <Icon name="arrow-left" size={16} />
          Contacts
        </Link>
        <div className="hub-title-row">
          <div className="contact-id">
            <Avatar name={c?.name ?? 'Contact'} size="lg" />
            <div>
              <h2>{c?.name ?? 'Contact'}</h2>
              <p className="muted">{email}</p>
              {c && <span className="badges">{c.marketingConsent ? <Badge tone="success" icon="check">Opted in to marketing</Badge> : <Badge>No marketing consent</Badge>}</span>}
            </div>
          </div>
          {email && (
          <div className="hub-actions">
            <Button
              variant="secondary"
              icon="copy"
              onClick={() =>
                void navigator.clipboard
                  .writeText(email)
                  .then(() => toast.success('Email copied'))
                  .catch(() => toast.danger('Copying was blocked by the browser.'))
              }>
              Copy email
            </Button>
            <a className={buttonClass()} href={`mailto:${email}`}>
              <Icon name="mail" size={18} />
              Send an email
            </a>
          </div>
          )}
        </div>
      </header>

      {query.error && <ErrorNote error={query.error} title="This contact could not load" />}
      {query.isPending && <LoadingBlock rows={4} />}

      {c && data && (
        <div className="contact-grid">
          <Card title="Activity" description="Every RSVP this person made, newest first." flush>
            {groups.length ? (
              <div className="timeline">
                {groups.map(group => (
                  <section key={group.label} className="timeline-group">
                    <h3 className="timeline-month">{group.label}</h3>
                    <ul className="timeline-list">
                      {group.items.map(r => (
                        <li key={r.id} className="timeline-item">
                          <span className="timeline-icon">
                            <Icon name={iconFor(r)} size={16} />
                          </span>
                          <div className="timeline-body">
                            <p className="timeline-title">
                              {headline(r)}{' '}
                              <Link to={`/events/${r.eventId}` as never} search={{tab: 'guests'} as never}>
                                {r.eventTitle}
                              </Link>
                            </p>
                            <p className="timeline-sub">
                              {when(r.startAt)}
                              {r.seats > 1 ? ` · ${r.seats} seats` : ''}
                              {r.plusOnes > 0 ? ` · +${r.plusOnes}` : ''}
                            </p>
                            <span className="badges">
                              <Badge tone={r.status === 'confirmed' ? 'success' : r.status === 'declined' || r.status === 'cancelled' ? 'danger' : 'warning'}>
                                {STATUS_LABEL[r.status] ?? r.status.replaceAll('_', ' ')}
                              </Badge>
                              <Badge>{RESPONSE_LABEL[r.response]}</Badge>
                              {r.checkedInAt && <Badge tone="success">Checked in {ago(r.checkedInAt)}</Badge>}
                              <Badge>Ticket {r.ticketCode}</Badge>
                            </span>
                          </div>
                          <time className="timeline-time" dateTime={r.createdAt} title={when(r.createdAt)}>
                            {ago(r.createdAt)}
                          </time>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
              <EmptyState icon="calendar" title="No activity">
                RSVPs this person makes will show here.
              </EmptyState>
            )}
          </Card>

          <div className="side-stack">
            <Card title="Details">
              <DefinitionList
                items={[
                  {label: 'Email', value: <span className="break-all">{c.email}</span>},
                  {label: 'First seen', value: when(c.firstSeenAt)},
                  {label: 'Events RSVP’d to', value: String(c.eventCount)},
                  {label: 'Events attended', value: `${c.attendedCount} of ${c.eventCount}`},
                  {label: 'Marketing', value: c.marketingConsent ? 'Opted in (confirmed by email)' : 'No consent'},
                ]}
              />
            </Card>
            {!c.marketingConsent && <Notice tone="info">This person has not opted in. Only send them messages about events they RSVP’d to.</Notice>}
          </div>
        </div>
      )}
    </div>
  );
}
