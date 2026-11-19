/**
 * Dev-only demo seed: "Clara Coaching" events, RSVPs, invites, polls, messages and page views,
 * ported from CreatorCrowdHub's src/server/db/seed.ts.
 *
 *   npm run db:seed:demo        (node --env-file=.env scripts/seed-demo.mjs)
 *
 * - Deterministic: ids, names, codes and tokens come from fixed seeds (dates are relative to "now").
 * - Idempotent: deletes the demo events (matched by their `demo-` slugs; every child row cascades)
 *   and re-inserts them in one transaction. Nothing else is touched.
 * - Never touches users / roles / sessions and never creates passwords (template rule: no seeded
 *   admin accounts). Sign in through the normal flow.
 * - Refuses to run with NODE_ENV=production, or against a database that isn't local unless it is
 *   the editor Preview Database (SITE_PREVIEW=1 AND SEED_DEMO_HOST=<that database's host>).
 * - Stops, changing nothing, when a demo slug belongs to an event it didn't create.
 *
 * Manage tokens are stored as sha256 hex (src/domain/secureToken.ts hashToken), so the raw sample
 * links printed at the end are the only way into a guest's `/r/<token>/` page without an email.
 */
import {createHash} from 'node:crypto';
import pg from 'pg';

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // src/domain/codes.ts
const DAY = 86_400_000;
const HOUR = 3_600_000;

// ------------------------------------------------------------------ guards
if (process.env.NODE_ENV === 'production') throw new Error('db:seed:demo refuses to run with NODE_ENV=production.');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('db:seed:demo needs DATABASE_URL (run with `node --env-file=.env`).');
const host = new URL(url).hostname;
const isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || host.endsWith('.localhost');
// A database that isn't on this computer needs BOTH the editor Preview flag and the host typed
// out again, so a production DATABASE_URL left in `.env` next to SITE_PREVIEW=1 is never touched.
if (!isLocal && (process.env.SITE_PREVIEW !== '1' || process.env.SEED_DEMO_HOST !== host)) {
  throw new Error(
    `db:seed:demo refuses to run against ${host}: not a local database. ` +
      'Only for the editor Preview Database: set SITE_PREVIEW=1 and SEED_DEMO_HOST to that host.',
  );
}
const base = (process.env.SEED_BASE_URL || 'http://localhost:4321').replace(/\/$/, '');

// ------------------------------------------------------------------ deterministic helpers
const sha = (s) => createHash('sha256').update(s).digest();
function uuid(key) {
  const h = sha('demo:' + key).subarray(0, 16);
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const rawToken = (key) => sha('demo-token:' + key).toString('base64url'); // 43 chars, like newToken()
const hashToken = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
function code(key, len = 8) {
  const b = sha('demo-code:' + key);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return out;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261030);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const FIRST = ['Ava', 'Noah', 'Mia', 'Liam', 'Zoe', 'Ethan', 'Isla', 'Omar', 'Priya', 'Kenji', 'Lucia', 'Mateo', 'Amara', 'Jonas', 'Freya', 'Dev', 'Hana', 'Tomas', 'Nia', 'Felix', 'Sara', 'Idris', 'Elena', 'Ravi', 'Chloe', 'Marcus', 'Yuki', 'Leila', 'Owen', 'Tessa'];
const LAST = ['Nguyen', 'Okafor', 'Silva', 'Hughes', 'Patel', 'Kowalski', 'Haddad', 'Lindqvist', 'Moreau', 'Tanaka', 'Bianchi', 'Adeyemi', 'Fischer', 'Ortiz', 'Reyes', 'Sato', 'Novak', 'Brennan', 'Clarke', 'Dubois'];
const guestNames = new Set();
function guest(n) {
  // Unique, deterministic name + lower-case email per global index.
  const name = `${FIRST[n % FIRST.length]} ${LAST[Math.floor(n / FIRST.length) % LAST.length]}${n >= FIRST.length * LAST.length ? ' ' + n : ''}`;
  guestNames.add(name);
  return {name, email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.com`};
}

// ------------------------------------------------------------------ the data
const now = Date.now();
const rows = {events: [], ticketTypes: [], questions: [], rules: [], invites: [], rsvps: [], answers: [], orders: [], polls: [], options: [], votes: [], messages: [], deliveries: [], views: []};
const samples = [];

const DEFAULT_RULES = (online) => [
  {kind: 'confirmation', offset: 0, subject: "You're in: {{event.title}}", body: 'Hi {{guest.first_name}}, see you at {{event.title}}.'},
  {kind: 'reminder', offset: -1440, subject: 'Tomorrow: {{event.title}}', body: 'A reminder that {{event.title}} is tomorrow.'},
  {kind: 'reminder', offset: -60, subject: 'Starting in 1 hour: {{event.title}}', body: '{{event.title}} starts in an hour.'},
  ...(online ? [{kind: 'live_now', offset: 0, subject: "We're live: {{event.title}}", body: 'Join now: {{event.join_url}}'}] : []),
  {kind: 'thank_you', offset: 240, subject: 'Thanks for coming to {{event.title}}', body: 'Thanks for joining us, {{guest.first_name}}.'},
];

function addEvent(e) {
  const id = uuid('event:' + e.slug);
  const start = now + e.startOffsetDays * DAY;
  rows.events.push({
    id, slug: e.slug, title: e.title, description: e.description, start_at: new Date(start), end_at: new Date(start + e.hours * HOUR),
    timezone: e.timezone, format: e.format, venue_name: e.venueName ?? null, venue_address: e.venueAddress ?? null, map_url: e.mapUrl ?? null,
    join_url: e.joinUrl ?? null, visibility: 'public', status: e.status, capacity: e.capacity ?? null, rsvp_deadline: null,
    waitlist_enabled: true, approval_required: false, allow_maybe: true, max_plus_ones: e.maxPlusOnes ?? 0, show_guest_list: e.showGuestList ?? false,
    poll_join_code: code('join:' + e.slug, 6), thank_you_link: e.thankYouLink ?? null, cover_poster: e.coverPoster,
    created_at: new Date(Math.min(start, now) - 40 * DAY), updated_at: new Date(now),
  });
  for (const r of DEFAULT_RULES(e.format !== 'in_person')) {
    rows.rules.push({id: uuid(`rule:${e.slug}:${r.kind}:${r.offset}`), event_id: id, kind: r.kind, offset_minutes: r.offset, enabled: true, subject: r.subject, body: r.body});
  }
  return {id, start, ...e};
}

const ama = addEvent({
  slug: 'demo-ask-me-anything-pricing', title: 'Ask Me Anything: Pricing', coverPoster: 'ama', status: 'published', startOffsetDays: -9, hours: 1.5,
  timezone: 'Europe/London', format: 'online', capacity: 45, joinUrl: 'https://meet.example.com/clara-ama',
  description: 'Clara answers your pricing questions live.\n\nSubmit yours when you RSVP.', thankYouLink: 'https://example.com/pricing-guide',
});
const workshop = addEvent({
  slug: 'demo-pricing-workshop', title: 'Pricing Workshop', coverPoster: 'workshop', status: 'published', startOffsetDays: 6, hours: 3,
  timezone: 'America/Chicago', format: 'in_person', capacity: 30, maxPlusOnes: 1, venueName: 'The Foundry', venueAddress: '200 W Adams St, Chicago, IL',
  mapUrl: 'https://maps.example.com/the-foundry', showGuestList: true,
  description: 'A hands-on half day: work out what to charge, then say it out loud.\n\nBring one offer you want to price.',
});
const mastermind = addEvent({
  slug: 'demo-the-monthly-mastermind', title: 'The Monthly Mastermind', coverPoster: 'mastermind', status: 'published', startOffsetDays: 12, hours: 1.5,
  timezone: 'America/New_York', format: 'online', capacity: 12, joinUrl: 'https://meet.example.com/clara-mastermind',
  description: 'Peers, laptops and a tight agenda. Twelve seats, hot seats rotate.',
});
const draft = addEvent({
  slug: 'demo-launch-day-qa', title: 'Launch Day Q&A (draft)', coverPoster: 'launch', status: 'draft', startOffsetDays: 40, hours: 1,
  timezone: 'Asia/Singapore', format: 'hybrid', venueName: 'Marina Hub', venueAddress: '10 Bayfront Ave, Singapore', joinUrl: 'https://meet.example.com/clara-launch',
  description: 'Not published yet: a hybrid launch-day session.',
});

// Ticket types (workshop is the paid one).
const ticketId = uuid('ticket:workshop:ga');
rows.ticketTypes.push({id: ticketId, event_id: workshop.id, name: 'General admission', price_cents: 4900, currency: 'USD', quantity: 30, sales_end_at: new Date(workshop.start - DAY)});
const freeTicket = {};
for (const e of [ama, mastermind, draft]) {
  freeTicket[e.id] = uuid('ticket:' + e.slug + ':free');
  rows.ticketTypes.push({id: freeTicket[e.id], event_id: e.id, name: 'Free', price_cents: 0, currency: 'USD', quantity: null, sales_end_at: null});
}

// RSVP questions.
const Q = {};
function addQuestion(e, key, label, type, options, required) {
  Q[key] = {id: uuid('question:' + key), type, options};
  rows.questions.push({id: Q[key].id, event_id: e.id, label, type, options: JSON.stringify(options), required});
}
addQuestion(ama, 'ama.role', 'What best describes you?', 'single_choice', ['Coach', 'Course creator', 'Consultant', 'Other'], true);
addQuestion(ama, 'ama.q', 'What pricing question should Clara answer?', 'long_text', [], false);
addQuestion(workshop, 'ws.years', 'How long have you been selling?', 'single_choice', ['< 1 year', '1-3 years', '3+ years'], true);
addQuestion(workshop, 'ws.diet', 'Any dietary requirements?', 'short_text', [], false);
addQuestion(mastermind, 'mm.goal', "What's your goal for this month?", 'short_text', [], true);
addQuestion(mastermind, 'mm.hot', "I'm happy to be featured in the hot seat", 'checkbox', [], false);

const GOALS = ['Raise my prices 20%', 'Launch a group program', 'Land 3 retainer clients', 'Fix my sales page', 'Plan Q1 offers'];
const PRICING_QS = ['How do I raise prices without losing clients?', 'Hourly or package pricing?', 'Is a free tier worth it?', 'How do I price a cohort course?', 'When do I offer discounts?'];
const HOW_LONG = ['< 1 year', '1-3 years', '3+ years'];
const DIETS = ['Vegetarian', 'No nuts', 'None', 'Gluten free'];

// RSVPs. spec: {status, response, plus, checkedIn, attended, waitpos, source, invite, ticket, utm, ageDays}
let gi = 0;
const rsvpRefs = {ama: [], ws: [], mm: []};
function addRsvp(ev, group, s) {
  const {name, email} = guest(gi++);
  const id = uuid(`rsvp:${ev.slug}:${email}`);
  const token = rawToken(`manage:${ev.slug}:${email}`);
  const plus = s.plus ?? 0;
  const created = new Date(Math.min(now, ev.start) - (s.ageDays ?? 3 + Math.floor(rand() * 14)) * DAY - Math.floor(rand() * DAY));
  const confirmed = s.status === 'confirmed';
  const optIn = rand() < 0.4;
  const r = {
    id, event_id: ev.id, ticket_type_id: s.ticket ?? null, invite_id: s.invite ?? null, name, email, response: s.response, status: s.status,
    plus_ones: plus, seats: 1 + plus, ticket_code: code(`ticket:${ev.slug}:${email}`), manage_token: hashToken(token), marketing_consent: optIn,
    checked_in_at: s.checkedIn ? new Date(ev.start + Math.floor(rand() * 20) * 60_000) : null, attended: s.attended ?? null,
    waitlist_position: s.waitpos ?? null, claim_expires_at: null, source: s.source ?? 'direct', utm_source: s.utm ?? pick([null, null, 'newsletter', 'instagram', 'linkedin']),
    created_at: created, updated_at: created, confirmed_at: confirmed ? created : null, consent_confirmed_at: optIn ? created : null,
  };
  rows.rsvps.push(r);
  rsvpRefs[group].push(r);
  if (group === 'ama') {
    rows.answers.push({id: uuid('ans:' + id + ':role'), rsvp_id: id, question_id: Q['ama.role'].id, value: JSON.stringify(pick(Q['ama.role'].options))});
    if (rand() < 0.6) rows.answers.push({id: uuid('ans:' + id + ':q'), rsvp_id: id, question_id: Q['ama.q'].id, value: JSON.stringify(pick(PRICING_QS))});
  } else if (group === 'ws') {
    rows.answers.push({id: uuid('ans:' + id + ':yrs'), rsvp_id: id, question_id: Q['ws.years'].id, value: JSON.stringify(pick(HOW_LONG))});
    if (rand() < 0.5) rows.answers.push({id: uuid('ans:' + id + ':diet'), rsvp_id: id, question_id: Q['ws.diet'].id, value: JSON.stringify(pick(DIETS))});
  } else {
    rows.answers.push({id: uuid('ans:' + id + ':goal'), rsvp_id: id, question_id: Q['mm.goal'].id, value: JSON.stringify(pick(GOALS))});
    rows.answers.push({id: uuid('ans:' + id + ':hot'), rsvp_id: id, question_id: Q['mm.hot'].id, value: JSON.stringify(rand() < 0.5)});
  }
  samples.push({title: ev.title, label: `${s.status}${s.checkedIn ? ', checked in' : ''}`, name, token});
  return r;
}

// (a) AMA: past, 40 confirmed going (28 attended, 12 no-shows) filling 40/45 seats, 3 maybe, 4 declined, 3 cancelled.
const amaFree = freeTicket[ama.id];
for (let i = 0; i < 40; i++) addRsvp(ama, 'ama', {status: 'confirmed', response: 'going', ticket: amaFree, checkedIn: i < 28, attended: i < 28});
for (let i = 0; i < 3; i++) addRsvp(ama, 'ama', {status: 'confirmed', response: 'maybe', ticket: amaFree});
for (let i = 0; i < 4; i++) addRsvp(ama, 'ama', {status: 'declined', response: 'not_going', ticket: amaFree});
for (let i = 0; i < 3; i++) addRsvp(ama, 'ama', {status: 'cancelled', response: 'going', ticket: amaFree});

// (b) Workshop: $49, capacity 30: 22 paid confirmed (4 checked in), 2 with a plus-one, 2 awaiting payment, 2 waitlisted, 1 maybe, 1 declined.
const wsPaid = [];
for (let i = 0; i < 22; i++) {
  wsPaid.push(addRsvp(workshop, 'ws', {status: 'confirmed', response: 'going', ticket: ticketId, plus: i < 2 ? 1 : 0, checkedIn: i >= 18, attended: i >= 18 ? true : null}));
}
const wsHeld = [];
for (let i = 0; i < 2; i++) wsHeld.push(addRsvp(workshop, 'ws', {status: 'awaiting_payment', response: 'going', ticket: ticketId, ageDays: 0}));
for (let i = 0; i < 2; i++) addRsvp(workshop, 'ws', {status: 'waitlisted', response: 'going', ticket: ticketId, waitpos: i + 1});
addRsvp(workshop, 'ws', {status: 'confirmed', response: 'maybe', ticket: ticketId});
addRsvp(workshop, 'ws', {status: 'declined', response: 'not_going', ticket: ticketId});
let orderN = 0;
for (const r of wsPaid) {
  rows.orders.push({id: uuid('order:' + r.id), rsvp_id: r.id, checkout_id: `pcs_demo_${String(++orderN).padStart(3, '0')}`, amount_cents: 4900 * r.seats, currency: 'USD', seats: r.seats, status: 'paid', created_at: r.created_at});
}
for (const r of wsHeld) {
  rows.orders.push({id: uuid('order:' + r.id), rsvp_id: r.id, checkout_id: `pcs_demo_${String(++orderN).padStart(3, '0')}`, amount_cents: 4900, currency: 'USD', seats: 1, status: 'pending', created_at: r.created_at});
}

// (c) Mastermind: 12 seats full, 5 waitlisted, 2 maybe, 1 declined. 8 invites, 6 of them answered.
const mmFree = freeTicket[mastermind.id];
const inviteSpecs = [];
for (let i = 0; i < 8; i++) {
  const g = guest(gi + i); // reserve the same identities the first RSVPs will use
  inviteSpecs.push({i, ...g});
}
const statusFor = ['responded', 'responded', 'responded', 'responded', 'responded', 'responded', 'sent', 'bounced'];
const inviteIds = [];
inviteSpecs.forEach((s, i) => {
  const id = uuid(`invite:${mastermind.slug}:${s.email}`);
  inviteIds.push(id);
  const sentAt = new Date(now - (10 - i) * HOUR * 6);
  rows.invites.push({id, event_id: mastermind.id, email: s.email, name: s.name, token: rawToken(`invite:${mastermind.slug}:${s.email}`), status: statusFor[i], sent_at: sentAt, last_resent_at: i === 6 ? new Date(now - HOUR) : null});
  samples.push({title: mastermind.title, label: `invite (${statusFor[i]})`, name: s.name, invite: rawToken(`invite:${mastermind.slug}:${s.email}`)});
});
// Two extra invites that are only queued (no email sent yet).
for (const k of ['queued.one', 'queued.two']) {
  const email = `${k}@example.com`;
  rows.invites.push({id: uuid(`invite:${mastermind.slug}:${email}`), event_id: mastermind.id, email, name: null, token: rawToken(`invite:${mastermind.slug}:${email}`), status: 'queued', sent_at: null, last_resent_at: null});
}
for (let i = 0; i < 12; i++) {
  addRsvp(mastermind, 'mm', i < 6 ? {status: 'confirmed', response: 'going', ticket: mmFree, invite: inviteIds[i], source: 'invite'} : {status: 'confirmed', response: 'going', ticket: mmFree});
}
for (let i = 0; i < 5; i++) addRsvp(mastermind, 'mm', {status: 'waitlisted', response: 'going', ticket: mmFree, waitpos: i + 1});
for (let i = 0; i < 2; i++) addRsvp(mastermind, 'mm', {status: 'confirmed', response: 'maybe', ticket: mmFree});
addRsvp(mastermind, 'mm', {status: 'declined', response: 'not_going', ticket: mmFree});
// The six answered invites must be the RSVPs for those identities: re-point them.
for (let i = 0; i < 6; i++) {
  const r = rsvpRefs.mm[i];
  const s = inviteSpecs[i];
  r.name = s.name;
  r.email = s.email;
  r.id = r.id; // id stays derived from the original email; only the identity columns move
}
// (the guest() sequence above already issued indexes in order, so names line up; asserted below)
for (let i = 0; i < 6; i++) if (rsvpRefs.mm[i].email !== inviteSpecs[i].email) throw new Error('seed: invite/rsvp identity mismatch');

// ------------------------------------------------------------------ polls
// Closed (AMA): "Biggest pricing worry?" single choice, 26 votes from attendees.
{
  const pollId = uuid('poll:ama');
  rows.polls.push({id: pollId, event_id: ama.id, question: "What's your biggest pricing worry?", type: 'single_choice', status: 'closed', anonymous: true, show_results_to_voters: true, opened_at: new Date(ama.start + 10 * 60_000), closed_at: new Date(ama.start + 60 * 60_000)});
  const labels = ['Charging too little', 'Losing clients on a rise', 'Justifying premium', 'Packaging offers'];
  const optIds = labels.map((label, i) => {
    const id = uuid(`poll:ama:opt:${i}`);
    rows.options.push({id, poll_id: pollId, label});
    return id;
  });
  rsvpRefs.ama.slice(0, 26).forEach((r, i) => {
    const opt = optIds[[0, 0, 0, 1, 1, 2, 3][i % 7]];
    rows.votes.push({id: uuid(`vote:ama:${i}`), poll_id: pollId, voter_token: uuid(`voter:ama:${i}`), rsvp_id: r.id, option_ids: JSON.stringify([opt]), rating_value: null, text_value: null, created_at: new Date(ama.start + (11 + i) * 60_000)});
  });
}
// Open (Mastermind): "Which topic first?" multi choice, 7 votes (one-open-per-event index respected).
{
  const pollId = uuid('poll:mm');
  rows.polls.push({id: pollId, event_id: mastermind.id, question: 'Which topics should we cover? Pick up to two.', type: 'multi_choice', status: 'open', anonymous: true, show_results_to_voters: true, opened_at: new Date(now - 2 * DAY), closed_at: null});
  const labels = ['Pricing reviews', 'Offer design', 'Sales calls', 'Content & audience'];
  const optIds = labels.map((label, i) => {
    const id = uuid(`poll:mm:opt:${i}`);
    rows.options.push({id, poll_id: pollId, label});
    return id;
  });
  for (let i = 0; i < 7; i++) {
    const picks = [optIds[i % 4], optIds[(i + 1 + (i % 2)) % 4]];
    rows.votes.push({id: uuid(`vote:mm:${i}`), poll_id: pollId, voter_token: uuid(`voter:mm:${i}`), rsvp_id: rsvpRefs.mm[i].id, option_ids: JSON.stringify([...new Set(picks)]), rating_value: null, text_value: null, created_at: new Date(now - (47 - i) * HOUR)});
  }
}

// ------------------------------------------------------------------ messages + deliveries
function addMessage(ev, key, segment, subject, body, recipients, ageHours, failIdx = -1) {
  const id = uuid('message:' + key);
  rows.messages.push({id, event_id: ev.id, segment, subject, body, sent_count: recipients.length - (failIdx >= 0 ? 1 : 0), sent_by: null, created_at: new Date(now - ageHours * HOUR), idempotency_key: 'demo-' + key});
  recipients.forEach((r, i) => {
    const failed = i === failIdx;
    rows.deliveries.push({id: uuid(`delivery:${key}:${r.id}`), rsvp_id: r.id, invite_id: null, reminder_rule_id: null, message_id: id, channel: 'email', status: failed ? 'failed' : 'sent', sent_at: failed ? null : new Date(now - ageHours * HOUR + i * 1000), error: failed ? 'mailbox full (demo)' : null});
  });
}
addMessage(ama, 'ama.thanks', 'checked_in', 'Thanks for coming to the pricing AMA', 'Hi {{guest.first_name}}, the replay and the pricing guide are in your inbox. Thanks for joining us!', rsvpRefs.ama.filter((r) => r.checked_in_at), 9 * 24 - 3, 5);
addMessage(ama, 'ama.noshow', 'no_show', 'Sorry we missed you', 'We missed you at the AMA, the replay is here: {{event.thank_you_link}}.', rsvpRefs.ama.slice(28, 40), 8 * 24);
addMessage(workshop, 'ws.logistics', 'going', 'Workshop logistics', 'Doors open at 9:30. Bring a laptop and one offer to price.', rsvpRefs.ws.filter((r) => r.status === 'confirmed' && r.response === 'going'), 20);
addMessage(mastermind, 'mm.welcome', 'going', 'Welcome to the Mastermind', 'Hi {{guest.first_name}}, your seat is saved. Vote in the poll before we meet.', rsvpRefs.mm.filter((r) => r.status === 'confirmed' && r.response === 'going'), 30);
// Invite deliveries for the sent / bounced / responded invites.
rows.invites.forEach((inv, i) => {
  if (inv.status === 'queued') return;
  rows.deliveries.push({id: uuid('delivery:invite:' + inv.id), rsvp_id: null, invite_id: inv.id, reminder_rule_id: null, message_id: null, channel: 'email', status: inv.status === 'bounced' ? 'failed' : 'sent', sent_at: inv.status === 'bounced' ? null : inv.sent_at, error: inv.status === 'bounced' ? 'address rejected (demo)' : null});
});
// Confirmation rule deliveries (rule x rsvp is unique) for the first 10 workshop guests.
{
  const rule = rows.rules.find((r) => r.event_id === workshop.id && r.kind === 'confirmation');
  for (const r of rsvpRefs.ws.slice(0, 10)) {
    rows.deliveries.push({id: uuid(`delivery:rule:${rule.id}:${r.id}`), rsvp_id: r.id, invite_id: null, reminder_rule_id: rule.id, message_id: null, channel: 'email', status: 'sent', sent_at: r.created_at, error: null});
  }
}

// ------------------------------------------------------------------ page views: 30 days, published events
for (const [ev, base_] of [[ama, 14], [workshop, 9], [mastermind, 6]]) {
  for (let d = 29; d >= 0; d--) {
    const dayStart = new Date(now - d * DAY);
    const ymd = dayStart.toISOString().slice(0, 10);
    // Traffic rises toward the event for upcoming ones; the AMA decays after it.
    const wave = ev === ama ? Math.max(0.3, 1 - Math.abs(d - 16) / 18) : 0.4 + (1 - d / 30) * 1.2;
    const n = Math.max(1, Math.round(base_ * wave * (0.6 + rand() * 0.8)));
    for (let v = 0; v < n; v++) {
      rows.views.push({id: uuid(`view:${ev.slug}:${ymd}:${v}`), event_id: ev.id, visitor_hash: sha(`visitor:${ev.slug}:${ymd}:${v}`).toString('hex').slice(0, 32), utm_source: pick([null, null, null, 'newsletter', 'instagram', 'linkedin', 'twitter']), created_at: new Date(dayStart.getTime() - Math.floor(rand() * 12) * HOUR), day: ymd});
    }
  }
}

// ------------------------------------------------------------------ write
async function insert(client, table, list, chunk = 500) {
  if (!list.length) return;
  const cols = Object.keys(list[0]);
  for (let i = 0; i < list.length; i += chunk) {
    const part = list.slice(i, i + chunk);
    const params = [];
    const tuples = part.map((row) => '(' + cols.map((c) => { params.push(row[c]); return '$' + params.length; }).join(',') + ')');
    await client.query(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES ${tuples.join(',')}`, params);
  }
}

const client = new pg.Client({connectionString: url});
await client.connect();
try {
  await client.query('BEGIN');
  // Display order within each parent (sort_order).
  const number = (list, parent) => { const seen = new Map(); for (const r of list) { const n = seen.get(r[parent]) ?? 0; r.sort_order = n; seen.set(r[parent], n + 1); } };
  number(rows.ticketTypes, 'event_id'); number(rows.questions, 'event_id'); number(rows.polls, 'event_id'); number(rows.options, 'poll_id');
  // Children cascade from events (rsvps -> answers/orders/deliveries, polls -> options/votes, ...).
  // An event that holds a demo slug but is not one of ours (a host made it): stop, never delete it.
  const clash = await client.query(
    `SELECT "slug" FROM "events" WHERE "slug" = ANY($1::text[]) AND NOT ("id" = ANY($2::uuid[])) LIMIT 5`,
    [rows.events.map((e) => e.slug), rows.events.map((e) => e.id)],
  );
  if (clash.rowCount) {
    throw new Error(`db:seed:demo stopped: these slugs belong to events it did not create: ${clash.rows.map((r) => r.slug).join(', ')}. Nothing was changed.`);
  }
  // Only the demo events this script made (fixed ids derived from their slugs).
  const del = await client.query(`DELETE FROM "events" WHERE "slug" LIKE 'demo-%' AND "id" = ANY($1::uuid[])`, [rows.events.map((e) => e.id)]);
  await insert(client, 'events', rows.events);
  await insert(client, 'ticket_types', rows.ticketTypes);
  await insert(client, 'rsvp_questions', rows.questions);
  await insert(client, 'reminder_rules', rows.rules);
  await insert(client, 'invites', rows.invites);
  await insert(client, 'rsvps', rows.rsvps);
  await insert(client, 'rsvp_answers', rows.answers);
  await insert(client, 'ticket_orders', rows.orders);
  await insert(client, 'polls', rows.polls);
  await insert(client, 'poll_options', rows.options);
  await insert(client, 'poll_votes', rows.votes);
  await insert(client, 'messages', rows.messages);
  await insert(client, 'message_deliveries', rows.deliveries);
  await insert(client, 'page_views', rows.views);
  await client.query('COMMIT');
  console.log(`Seeded demo data (replaced ${del.rowCount} existing demo event(s)): ${rows.events.length} events, ${rows.rsvps.length} RSVPs, ${rows.invites.length} invites, ${rows.polls.length} polls / ${rows.votes.length} votes, ${rows.messages.length} messages / ${rows.deliveries.length} deliveries, ${rows.views.length} page views.`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  await client.end();
}

console.log('No users, roles or passwords were created. Sign in through the normal flow.');
console.log('Manage tokens are stored hashed; these raw links are the only way in without an email:');
const seen = new Set();
for (const s of samples) {
  if (s.invite) {
    if (s.label.includes('responded') || seen.has('inv:' + s.title)) continue;
    seen.add('inv:' + s.title);
    console.log(`Sample invite link (${s.title}, ${s.name}): ${base}/i/${s.invite}`);
    continue;
  }
  const key = s.title + '|' + s.label;
  if (seen.has(key) || !['confirmed', 'confirmed, checked in', 'waitlisted', 'awaiting_payment'].includes(s.label)) continue;
  seen.add(key);
  console.log(`Sample manage link (${s.title}, ${s.label}, ${s.name}): ${base}/r/${s.token}/`);
}
