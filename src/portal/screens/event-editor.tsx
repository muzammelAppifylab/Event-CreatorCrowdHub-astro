import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useParams} from '@tanstack/react-router';
import {useRef, useState} from 'react';

import {formatInZone} from '../../domain/time';
import {
  type AdminEventDetail,
  type AdminTicketType,
  completeEvent,
  type EventFormat,
  type EventValues,
  type EventVisibility,
  EVENT_FORMATS,
  EVENT_VISIBILITIES,
  type EventSettingsDto,
  type FieldErrors,
  fromLocalInput,
  MAX_PLUS_ONES,
  MAX_RSVP_QUESTIONS,
  parseEventFields,
  parseTicket,
  POSTER_DESIGNS,
  POSTER_PALETTES,
  type QuestionType,
  QUESTION_TYPES,
  SUPPORTED_CURRENCIES,
  timeZoneOptions,
  toLocalInput,
} from '../../lib/event-schemas';
import {api, ApiError, read} from '../api';
import {eventQuery, eventSettingsQuery, eventTicketsQuery, fieldAria, focusFirstInvalid, useEventsNav} from '../events-queries';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  type Column,
  DataTable,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  LoadingBlock,
  Menu,
  Modal,
  Notice,
  PageHeader,
  RadioCards,
  Select,
  StatusBadge,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

// ---------------------------------------------------------------- labels --

const FORMAT_INFO: Record<EventFormat, {title: string; description: string}> = {
  in_person: {title: 'In person', description: 'Guests come to a venue.'},
  online: {title: 'Online', description: 'Guests get a link to join.'},
  hybrid: {title: 'Hybrid', description: 'A venue and an online link.'},
};
const VISIBILITY_INFO: Record<EventVisibility, {title: string; description: string}> = {
  public: {title: 'Public', description: 'Listed on the events page.'},
  unlisted: {title: 'Unlisted', description: 'Anyone with the link can RSVP.'},
  private: {title: 'Private', description: 'Only people you invite.'},
};
const QUESTION_LABELS: Record<QuestionType, string> = {
  short_text: 'Short answer',
  long_text: 'Long answer',
  single_choice: 'Pick one',
  multi_choice: 'Pick several',
  checkbox: 'Yes / no',
};
const EDITOR_SECTIONS = [['details', 'Details'], ['location', 'Location'], ['datetime', 'Date & time'], ['rsvp', 'Capacity & RSVP'], ['questions', 'Questions'], ['tickets', 'Tickets'], ['reminders', 'Reminders'], ['polls', 'Polls']] as const;
const STATUS_TONES = {draft: 'neutral', published: 'success', cancelled: 'danger'} as const;

type QuestionDraft = {id?: string; label: string; type: QuestionType; options: string; required: boolean};

type FormValues = {
  title: string;
  slug: string;
  description: string;
  coverPoster: string;
  coverImageUrl: string;
  palette: string;
  headline: string;
  eyebrow: string;
  footer: string;
  timezone: string;
  startAt: string;
  endAt: string;
  rsvpDeadline: string;
  format: string;
  venueName: string;
  venueAddress: string;
  mapUrl: string;
  joinUrl: string;
  visibility: string;
  capacity: string;
  maxPlusOnes: string;
  waitlistEnabled: boolean;
  approvalRequired: boolean;
  allowMaybe: boolean;
  showGuestList: boolean;
  thankYouLink: string;
};

const formOf = (e: AdminEventDetail): FormValues => ({
  title: e.title,
  slug: e.slug,
  description: e.description,
  coverPoster: e.coverPoster ?? '',
  coverImageUrl: e.coverImageUrl ?? '',
  palette: e.coverStyle?.palette ?? '',
  headline: e.coverStyle?.headline ?? '',
  eyebrow: e.coverStyle?.eyebrow ?? '',
  footer: e.coverStyle?.footer ?? '',
  timezone: e.timezone,
  startAt: toLocalInput(e.startAt, e.timezone),
  endAt: toLocalInput(e.endAt, e.timezone),
  rsvpDeadline: e.rsvpDeadline ? toLocalInput(e.rsvpDeadline, e.timezone) : '',
  format: e.format,
  venueName: e.venueName ?? '',
  venueAddress: e.venueAddress ?? '',
  mapUrl: e.mapUrl ?? '',
  joinUrl: e.joinUrl ?? '',
  visibility: e.visibility,
  capacity: e.capacity ? String(e.capacity) : '',
  maxPlusOnes: String(e.maxPlusOnes),
  waitlistEnabled: e.waitlistEnabled,
  approvalRequired: e.approvalRequired,
  allowMaybe: e.allowMaybe,
  showGuestList: e.showGuestList,
  thankYouLink: e.thankYouLink ?? '',
});

/** A new event: tomorrow 18:00 to 20:00 in the default zone, with the settings' defaults. */
function newForm(settings: EventSettingsDto | undefined): FormValues {
  const timezone = settings?.defaultTimezone ?? 'UTC';
  const day = toLocalInput(new Date(Date.now() + 24 * 3600_000).toISOString(), timezone).slice(0, 10);
  return {
    title: '',
    slug: '',
    description: '',
    coverPoster: settings?.defaultCoverPoster ?? '',
    coverImageUrl: '',
    palette: '',
    headline: '',
    eyebrow: '',
    footer: '',
    timezone,
    startAt: `${day}T18:00`,
    endAt: `${day}T20:00`,
    rsvpDeadline: '',
    format: 'in_person',
    venueName: '',
    venueAddress: '',
    mapUrl: '',
    joinUrl: '',
    visibility: 'public',
    capacity: '',
    maxPlusOnes: '0',
    waitlistEnabled: true,
    approvalRequired: false,
    allowMaybe: settings?.allowMaybeDefault ?? true,
    showGuestList: settings?.showGuestListDefault ?? false,
    thankYouLink: '',
  };
}

const draftsOf = (e: AdminEventDetail): QuestionDraft[] =>
  e.questions.map(q => ({id: q.id, label: q.label, type: q.type, options: q.options.join('\n'), required: q.required}));

/** The JSON body the Site API takes: the form's text turned into typed values (the server re-checks all of it). */
function bodyOf(v: FormValues, questions: QuestionDraft[]) {
  const local = (value: string) => (value ? (fromLocalInput(value, v.timezone) ?? 'invalid') : null);
  const number = (value: string) => (value.trim() === '' ? null : Number(value));
  const style = {palette: v.palette || undefined, headline: v.headline, eyebrow: v.eyebrow, footer: v.footer};
  return {
    title: v.title,
    slug: v.slug.trim() || undefined,
    description: v.description,
    coverPoster: v.coverPoster || null,
    coverImageUrl: v.coverImageUrl,
    coverStyle: style,
    startAt: local(v.startAt) ?? '',
    endAt: local(v.endAt) ?? '',
    timezone: v.timezone,
    format: v.format,
    venueName: v.venueName,
    venueAddress: v.venueAddress,
    mapUrl: v.mapUrl,
    joinUrl: v.joinUrl,
    visibility: v.visibility,
    capacity: number(v.capacity),
    rsvpDeadline: local(v.rsvpDeadline),
    waitlistEnabled: v.waitlistEnabled,
    approvalRequired: v.approvalRequired,
    allowMaybe: v.allowMaybe,
    maxPlusOnes: Number(v.maxPlusOnes),
    showGuestList: v.showGuestList,
    thankYouLink: v.thankYouLink,
    questions: questions.map(q => ({
      ...(q.id ? {id: q.id} : {}),
      label: q.label,
      type: q.type,
      options: q.type === 'single_choice' || q.type === 'multi_choice' ? q.options.split('\n').map(o => o.trim()).filter(Boolean) : [],
      required: q.required,
    })),
  };
}

const money = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en', {style: 'currency', currency}).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
};

// ---------------------------------------------------------------- screen --

/**
 * `/dashboard/events/$id`: create (`id` = `new`) or edit one event: details,
 * cover poster, RSVP questions and ticket types. Holders of `site:event:manage`.
 */
export function EventEditor() {
  const {id = 'new'} = useParams({strict: false}) as {id?: string};
  const isNew = id === 'new';
  const settings = useQuery(eventSettingsQuery);
  const event = useQuery({...eventQuery(id), enabled: !isNew});
  const nav = useEventsNav();

  if (isNew) {
    if (settings.isPending) return <LoadingScreen />;
    return <EditorForm key="new" id="new" initial={newForm(settings.data?.settings)} drafts={[]} event={null} />;
  }
  if (event.isPending) return <LoadingScreen />;
  if (event.error || !event.data) {
    return (
      <div className="app-page screen-event-editor">
        <PageHeader title="Event" />
        <EmptyState
          icon="alert"
          title="This event could not be opened"
          action={
            <Button variant="secondary" icon="arrow-left" onClick={() => nav('/events')}>
              Back to events
            </Button>
          }>
          {event.error?.message ?? 'It may have been deleted.'}
        </EmptyState>
      </div>
    );
  }
  const e = event.data.event;
  return <EditorForm key={`${e.id}:${e.updatedAt}`} id={id} initial={formOf(e)} drafts={draftsOf(e)} event={e} />;
}

function LoadingScreen() {
  return (
    <div className="app-page screen-event-editor">
      <PageHeader title="Event" />
      <LoadingBlock rows={6} />
    </div>
  );
}

function EditorForm({id, initial, drafts, event}: {id: string; initial: FormValues; drafts: QuestionDraft[]; event: AdminEventDetail | null}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const nav = useEventsNav();
  const form = useForm<FormValues>(initial, {});
  const formRef = useRef<HTMLFormElement>(null);
  const [questions, setQuestions] = useState<QuestionDraft[]>(drafts);
  const [problems, setProblems] = useState<FieldErrors>({});
  const refresh = () => queryClient.invalidateQueries({queryKey: ['events']});
  const v = form.values;
  const isNew = event === null;

  /** Field errors by name; `questions.N.x` ones show under that question. */
  const showErrors = (fields: FieldErrors) => {
    const named: Partial<Record<keyof FormValues, string>> = {};
    const rest: FieldErrors = {};
    for (const [key, message] of Object.entries(fields)) {
      const formKey = key === 'coverStyle' ? 'headline' : key;
      if (formKey in initial) named[formKey as keyof FormValues] = message;
      else rest[key] = message;
    }
    form.setServerErrors(named);
    setProblems(rest);
    if (Object.keys(fields).length) focusFirstInvalid(formRef.current);
  };

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof bodyOf>) =>
      isNew
        ? read<{event: AdminEventDetail}>(api['admin-events'].$post({json: body as never}))
        : read<{event: AdminEventDetail}>(api['admin-events'][':id'].$patch({param: {id}, json: body as never})),
    onSuccess: async ({event: saved}) => {
      toast.success(isNew ? 'Draft created.' : 'Changes saved.');
      await refresh();
      if (isNew) nav(`/events/${saved.id}`);
    },
    onError: err => err instanceof ApiError && showErrors(err.fields),
  });
  const setStatus = useMutation({
    mutationFn: (action: 'publish' | 'unpublish') =>
      read<{event: AdminEventDetail}>(api['admin-events'][':id'][action].$post({param: {id}})),
    onSuccess: ({event: saved}) => {
      toast.success(saved.status === 'published' ? 'Event published.' : 'Event is a draft again.');
      return refresh();
    },
    onError: err => err instanceof ApiError && showErrors(err.fields),
  });

  const submit = form.submit(() => {
    const body = bodyOf(v, questions);
    // The server's own rules, run here first, so the errors show before the request.
    const parsed = parseEventFields(body, false);
    const fields: FieldErrors = parsed.ok ? {} : parsed.fields;
    if (parsed.ok) {
      const done = completeEvent(parsed.value as EventValues, {});
      if (!done.ok) Object.assign(fields, done.fields);
    }
    showErrors(fields);
    if (Object.keys(fields).length === 0) save.mutate(body);
  });

  const setQuestion = (index: number, patch: Partial<QuestionDraft>) =>
    setQuestions(current => current.map((q, i) => (i === index ? {...q, ...patch} : q)));
  const published = event?.status === 'published';
  const cancelled = event?.status === 'cancelled';
  const busy = save.isPending || setStatus.isPending;
  const error = save.error ?? setStatus.error;
  const failed = error && !(error instanceof ApiError && Object.keys(error.fields).length);
  const needsVenue = v.format !== 'online';
  const needsLink = v.format !== 'in_person';
  const zones = timeZoneOptions(v.timezone);
  const checkbox = (name: 'waitlistEnabled' | 'approvalRequired' | 'allowMaybe' | 'showGuestList', label: string, description: string) => (
    <Checkbox label={label} description={description} checked={v[name]} onChange={checked => form.set(name, checked)} />
  );

  return (
    <div className="app-page screen-event-editor">
      <form ref={formRef} noValidate onSubmit={submit}>
        <PageHeader
          title={isNew ? 'New event' : 'Edit event'}
          description={
            event ? (
              <>
                <StatusBadge tone={STATUS_TONES[event.status]}>{event.status === 'draft' ? 'Draft' : event.status === 'published' ? 'Published' : 'Cancelled'}</StatusBadge>{' '}
                {published && (
                  <a href={event.publicPath} target="_blank" rel="noopener noreferrer">
                    {event.publicPath}
                  </a>
                )}
              </>
            ) : (
              'Publishing saves your changes first, then makes the page live.'
            )
          }
          actions={
            <>
              <Button variant="secondary" icon="arrow-left" onClick={() => nav('/events')} disabled={busy}>
                Back to events
              </Button>
              {event && !cancelled && (
                <Button variant="secondary" onClick={() => setStatus.mutate(published ? 'unpublish' : 'publish')} pending={setStatus.isPending} pendingLabel={published ? 'Unpublishing…' : 'Publishing…'} disabled={save.isPending}>
                  {published ? 'Unpublish' : 'Publish'}
                </Button>
              )}
              <Button type="submit" pending={save.isPending} pendingLabel="Saving…" disabled={setStatus.isPending || cancelled}>
                {isNew ? 'Save draft' : 'Save changes'}
              </Button>
            </>
          }
        />

        <nav aria-label="Editor sections" className="editor-nav">
          {EDITOR_SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={`#sec-${id}`}
              onClick={ev => {
                ev.preventDefault();
                document.getElementById(`sec-${id}`)?.scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'});
              }}>
              {label}
            </a>
          ))}
        </nav>

        {cancelled && <Notice tone="warning" title="This event is cancelled">A cancelled event can’t be edited or published again. Duplicate it to run it again.</Notice>}
        {failed && <ErrorNote error={error!} />}
        {Object.keys(problems).length > 0 && (
          <Notice tone="danger" title="Fix these first">
            {Object.entries(problems).filter(([key]) => !key.startsWith('questions.')).map(([key, message]) => (
              <div key={key}>{message}</div>
            ))}
          </Notice>
        )}

        <fieldset className="form-stack" disabled={cancelled}>
          <div id="sec-details" className="editor-section">
            <Card title="Details">
              <div className="form-stack">
                <Field id="f-title" label="Title" error={form.error('title')}>
                  <input {...form.field('title')} maxLength={120} autoComplete="off" />
                </Field>
                <Field id="f-slug" label="Link" optional={isNew} hint={`The public page is /e/${v.slug.trim() || 'your-title'}. ${isNew ? 'Leave it blank to make one from the title.' : ''}`} error={form.error('slug')}>
                  <input {...form.field('slug')} maxLength={60} autoComplete="off" spellCheck={false} />
                </Field>
                <Field id="f-description" label="Description" hint="Shown on the event page. Leave a blank line between paragraphs." error={form.error('description')}>
                  <textarea {...form.field('description')} rows={6} />
                </Field>
              </div>
            </Card>
          </div>

          <div id="sec-cover" className="editor-section">
            <Card title="Cover" description="Without an image, guests see an authored poster.">
              <div className="form-stack">
                <Field id="f-coverImageUrl" label="Cover image link" optional hint="A 3:4 image works best." error={form.error('coverImageUrl')}>
                  <input {...form.field('coverImageUrl')} inputMode="url" placeholder="https://…" />
                </Field>
                <div className="form-grid">
                  <Field id="f-coverPoster" label="Poster" optional error={form.error('coverPoster')}>
                    <Select {...form.field('coverPoster')} options={[{value: '', label: 'Automatic'}, ...POSTER_DESIGNS.map(p => ({value: p, label: p[0]!.toUpperCase() + p.slice(1)}))]} />
                  </Field>
                  <Field id="f-palette" label="Poster colours" optional error={form.error('palette')}>
                    <Select {...form.field('palette')} options={[{value: '', label: 'Poster default'}, ...POSTER_PALETTES.map(p => ({value: p, label: p[0]!.toUpperCase() + p.slice(1)}))]} />
                  </Field>
                </div>
                <div className="form-grid">
                  <Field id="f-headline" label="Poster headline" optional hint="Blank uses the title." error={form.error('headline')}>
                    <input {...form.field('headline')} maxLength={80} />
                  </Field>
                  <Field id="f-eyebrow" label="Poster eyebrow" optional error={form.error('eyebrow')}>
                    <input {...form.field('eyebrow')} maxLength={40} />
                  </Field>
                </div>
                <Field id="f-footer" label="Poster footer" optional error={form.error('footer')}>
                  <input {...form.field('footer')} maxLength={60} />
                </Field>
              </div>
            </Card>
          </div>

          <div id="sec-location" className="editor-section">
            <Card title="Location">
              <div className="form-stack">
                <RadioCards
                  legend="Format"
                  name="format"
                  columns={3}
                  value={v.format as EventFormat}
                  onChange={format => form.set('format', format)}
                  options={EVENT_FORMATS.map(f => ({value: f, title: FORMAT_INFO[f].title, description: FORMAT_INFO[f].description}))}
                />
                {needsVenue && (
                  <>
                    <Field id="f-venueName" label="Venue name" error={form.error('venueName')}>
                      <input {...form.field('venueName')} maxLength={200} />
                    </Field>
                    <Field id="f-venueAddress" label="Venue address" error={form.error('venueAddress')}>
                      <textarea {...form.field('venueAddress')} rows={2} maxLength={500} />
                    </Field>
                    <Field id="f-mapUrl" label="Map link" optional error={form.error('mapUrl')}>
                      <input {...form.field('mapUrl')} inputMode="url" placeholder="https://maps.example.com/…" />
                    </Field>
                  </>
                )}
                {needsLink && (
                  <Field id="f-joinUrl" label="Join link" hint="Only confirmed guests ever see it." error={form.error('joinUrl')}>
                    <input {...form.field('joinUrl')} inputMode="url" placeholder="https://meet.example.com/…" />
                  </Field>
                )}
              </div>
            </Card>
          </div>

          <div id="sec-datetime" className="editor-section">
            <Card title="Date & time" description="Guests see their own local time first, with the event’s timezone underneath.">
              <div className="form-stack">
                <Field id="f-timezone" label="Timezone" error={form.error('timezone')}>
                  <Select {...form.field('timezone')} options={zones} />
                </Field>
                <div className="form-grid">
                  <Field id="f-startAt" label="Starts" error={form.error('startAt')}>
                    <input {...form.field('startAt')} type="datetime-local" />
                  </Field>
                  <Field id="f-endAt" label="Ends" error={form.error('endAt')}>
                    <input {...form.field('endAt')} type="datetime-local" />
                  </Field>
                </div>
                <Field id="f-rsvpDeadline" label="RSVP deadline" optional hint="Guests can’t RSVP after this. Blank means until the event starts." error={form.error('rsvpDeadline')}>
                  <input {...form.field('rsvpDeadline')} type="datetime-local" />
                </Field>
                {event && v.startAt && (
                  <p className="muted">
                    Saved as {formatInZone(new Date(event.startAt), event.timezone)}.
                  </p>
                )}
              </div>
            </Card>
          </div>

          <div id="sec-rsvp" className="editor-section">
            <Card title="Capacity & RSVP">
              <div className="form-stack">
                <RadioCards
                  legend="Who can find it"
                  name="visibility"
                  columns={3}
                  value={v.visibility as EventVisibility}
                  onChange={visibility => form.set('visibility', visibility)}
                  options={EVENT_VISIBILITIES.map(o => ({value: o, title: VISIBILITY_INFO[o].title, description: VISIBILITY_INFO[o].description}))}
                />
                <div className="form-grid">
                  <Field id="f-capacity" label="Capacity" optional hint="Blank means no limit." error={form.error('capacity')}>
                    <input {...form.field('capacity')} type="number" min={1} inputMode="numeric" />
                  </Field>
                  <Field id="f-maxPlusOnes" label="Plus-ones per guest" hint={`0 to ${MAX_PLUS_ONES}.`} error={form.error('maxPlusOnes')}>
                    <input {...form.field('maxPlusOnes')} type="number" min={0} max={MAX_PLUS_ONES} inputMode="numeric" />
                  </Field>
                </div>
                {checkbox('waitlistEnabled', 'Waitlist', 'When the event is full, guests can join a waitlist.')}
                {checkbox('approvalRequired', 'Approve guests', 'You approve each RSVP before the guest is confirmed.')}
                {checkbox('allowMaybe', 'Allow “Maybe”', 'Guests can answer going, maybe or not going.')}
                {checkbox('showGuestList', 'Show the guest list', 'Confirmed guests see who else is coming.')}
                <Field id="f-thankYouLink" label="Thank-you link" optional hint="Where the thank-you email sends guests (a survey, a recording)." error={form.error('thankYouLink')}>
                  <input {...form.field('thankYouLink')} inputMode="url" placeholder="https://…" />
                </Field>
              </div>
            </Card>
          </div>

          <div id="sec-questions" className="editor-section">
            <Card
              title="Questions"
              description={`Ask up to ${MAX_RSVP_QUESTIONS} questions on the RSVP form. Answers appear in the guest list and CSV.`}
              actions={
                <Button variant="secondary" size="sm" icon="plus" disabled={questions.length >= MAX_RSVP_QUESTIONS} onClick={() => setQuestions(current => [...current, {label: '', type: 'short_text', options: '', required: false}])}>
                  Add question
                </Button>
              }>
              {questions.length === 0 ? (
                <p className="muted">No questions yet. Name and email are always collected.</p>
              ) : (
                <div className="form-stack">
                  {questions.map((q, i) => (
                    <div key={q.id ?? `new-${i}`} className="form-stack">
                      <div className="form-grid">
                        <Field id={`q-${i}-label`} label={`Question ${i + 1}`} error={problems[`questions.${i}.label`]}>
                          <input id={`q-${i}-label`} {...fieldAria(`q-${i}-label`, problems[`questions.${i}.label`])} value={q.label} maxLength={200} onChange={ev => setQuestion(i, {label: ev.target.value})} />
                        </Field>
                        <Field id={`q-${i}-type`} label="Answer type" error={problems[`questions.${i}.type`]}>
                          <Select id={`q-${i}-type`} {...fieldAria(`q-${i}-type`, problems[`questions.${i}.type`])} value={q.type} onChange={ev => setQuestion(i, {type: ev.target.value as QuestionType})} options={QUESTION_TYPES.map(t => ({value: t, label: QUESTION_LABELS[t]}))} />
                        </Field>
                      </div>
                      {(q.type === 'single_choice' || q.type === 'multi_choice') && (
                        <Field id={`q-${i}-options`} label="Options" hint="One per line, at least two." error={problems[`questions.${i}.options`]}>
                          <textarea id={`q-${i}-options`} {...fieldAria(`q-${i}-options`, problems[`questions.${i}.options`], true)} rows={4} value={q.options} onChange={ev => setQuestion(i, {options: ev.target.value})} />
                        </Field>
                      )}
                      <div className="toolbar">
                        <Checkbox label="Required" checked={q.required} onChange={required => setQuestion(i, {required})} />
                        <IconButton icon="trash" label={`Remove question ${i + 1}`} size="sm" onClick={() => setQuestions(current => current.filter((_, at) => at !== i))} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </fieldset>
      </form>

      <div id="sec-tickets" className="editor-section">
        {event ? <Tickets event={event} /> : (
          <Card title="Tickets">
            <p className="muted">Save the draft first, then add ticket types here.</p>
          </Card>
        )}
      </div>
      <div id="sec-reminders" className="editor-section">
        <Card title="Reminders">
          <p className="muted">{event ? 'Edit this event’s automatic emails in the Messages tab of the event hub.' : 'Save the event first, then edit its automatic emails here. New events start with the defaults from Settings.'}</p>
        </Card>
      </div>
      <div id="sec-polls" className="editor-section">
        <Card title="Polls">
          <p className="muted">{event ? 'Prepare questions before the event, then open them one at a time from the event hub while you present.' : 'Save the event first, then prepare its polls here. You open them live from the event hub.'}</p>
        </Card>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- tickets --

type TicketForm = {name: string; price: string; currency: string; quantity: string; salesEndAt: string};

function Tickets({event}: {event: AdminEventDetail}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const tickets = useQuery(eventTicketsQuery(event.id));
  const [editing, setEditing] = useState<AdminTicketType | 'new' | null>(null);
  // Sold counts and capacity also show in the event itself, so refresh the whole slice.
  const refresh = () => queryClient.invalidateQueries({queryKey: ['events']});
  const remove = useMutation({
    mutationFn: (t: AdminTicketType) => read(api['admin-events'][':id']['ticket-types'][':ticketId'].$delete({param: {id: event.id, ticketId: t.id}})),
    onSuccess: refresh,
  });
  const columns: Column<AdminTicketType>[] = [
    {key: 'name', header: 'Ticket', cell: t => <span className="cell-title">{t.name}</span>},
    {key: 'price', header: 'Price', width: 'shrink', cell: t => (t.priceCents === 0 ? 'Free' : money(t.priceCents, t.currency))},
    {key: 'qty', header: 'Sold', width: 'shrink', hideOnMobile: true, cell: t => `${t.sold}${t.quantity ? ` / ${t.quantity}` : ''}`},
    {
      key: 'ends',
      header: 'Sales end',
      width: 'shrink',
      hideOnMobile: true,
      cell: t => (t.salesEndAt ? <span>{formatInZone(new Date(t.salesEndAt), event.timezone)} {t.salesEnded && <Badge tone="neutral">Ended</Badge>}</span> : <span className="muted">When RSVPs close</span>),
    },
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: t =>
        remove.isPending && remove.variables?.id === t.id ? (
          <IconButton icon="more" label={`Deleting “${t.name}”`} size="sm" pending />
        ) : (
        <Menu
          label={`Actions for ${t.name}`}
          disabled={remove.isPending}
          items={[
            {label: 'Edit', icon: 'pencil', onSelect: () => setEditing(t)},
            'separator',
            {
              label: 'Delete',
              icon: 'trash',
              danger: true,
              onSelect: () =>
                void confirm({
                  title: `Delete “${t.name}”?`,
                  body: 'Guests who already chose it block the delete: end its sales instead.',
                  confirmLabel: 'Delete ticket',
                  pendingLabel: 'Deleting…',
                  action: () => remove.mutateAsync(t),
                }).then(ok => ok && toast.success(`Deleted “${t.name}”.`)),
            },
          ]}
        />
        ),
    },
  ];
  return (
    <>
      <Card
        title="Tickets"
        description="Free and paid ticket types. Without any, RSVPs are free."
        flush
        actions={
          <Button variant="secondary" size="sm" icon="plus" onClick={() => setEditing('new')}>
            Add ticket
          </Button>
        }>
        <DataTable
          caption="Ticket types"
          columns={columns}
          rows={tickets.data?.ticketTypes}
          rowKey={t => t.id}
          loading={tickets.isPending}
          error={tickets.error}
          empty={<EmptyState icon="inbox" title="No ticket types">Add one to cap a kind of seat or to charge for it.</EmptyState>}
        />
      </Card>
      {editing && (
        <TicketModal
          key={editing === 'new' ? 'new' : editing.id}
          event={event}
          ticket={editing === 'new' ? null : editing}
          currency={tickets.data?.currency ?? 'USD'}
          lockCurrency={(tickets.data?.ticketTypes.length ?? 0) > (editing === 'new' ? 0 : 1)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast.success('Ticket saved.');
            void refresh();
          }}
        />
      )}
    </>
  );
}

function TicketModal({event, ticket, currency, lockCurrency, onClose, onSaved}: {event: AdminEventDetail; ticket: AdminTicketType | null; currency: string; lockCurrency: boolean; onClose: () => void; onSaved: () => void}) {
  const [values, setValues] = useState<TicketForm>({
    name: ticket?.name ?? '',
    price: ticket ? (ticket.priceCents / 100).toFixed(2) : '0',
    currency: ticket?.currency ?? currency,
    quantity: ticket?.quantity ? String(ticket.quantity) : '',
    salesEndAt: ticket?.salesEndAt ? toLocalInput(ticket.salesEndAt, event.timezone) : '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const set = (patch: Partial<TicketForm>) => setValues(current => ({...current, ...patch}));
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      ticket
        ? read(api['admin-events'][':id']['ticket-types'][':ticketId'].$patch({param: {id: event.id, ticketId: ticket.id}, json: body as never}))
        : read(api['admin-events'][':id']['ticket-types'].$post({param: {id: event.id}, json: body as never})),
    onSuccess: onSaved,
    onError: err => {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        setErrors(err.fields);
        focusFirstInvalid(formRef.current);
      }
    },
  });
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const price = Number(values.price.replace(',', '.'));
    const body = {
      name: values.name,
      priceCents: Number.isFinite(price) ? Math.round(price * 100) : -1,
      currency: values.currency,
      quantity: values.quantity.trim() === '' ? null : Number(values.quantity),
      salesEndAt: values.salesEndAt ? (fromLocalInput(values.salesEndAt, event.timezone) ?? 'invalid') : null,
    };
    const parsed = parseTicket(body, false);
    setErrors(parsed.ok ? {} : parsed.fields);
    if (parsed.ok) save.mutate(body);
    else focusFirstInvalid(formRef.current);
  };
  const failed = save.error && !(save.error instanceof ApiError && Object.keys(save.error.fields).length);
  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!save.isPending}
      title={ticket ? 'Edit ticket' : 'Add a ticket'}
      description={`Sales end times are in ${event.timezone}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="ticket-form" pending={save.isPending} pendingLabel="Saving…">
            Save ticket
          </Button>
        </>
      }>
      <form ref={formRef} id="ticket-form" className="form-stack" noValidate onSubmit={submit}>
        <Field id="t-name" label="Name" error={errors.name}>
          <input id="t-name" {...fieldAria('t-name', errors.name)} value={values.name} maxLength={80} onChange={ev => set({name: ev.target.value})} autoComplete="off" />
        </Field>
        <div className="form-grid">
          <Field id="t-price" label="Price" hint="0 for a free ticket." error={errors.priceCents}>
            <input id="t-price" {...fieldAria('t-price', errors.priceCents, true)} value={values.price} inputMode="decimal" onChange={ev => set({price: ev.target.value})} />
          </Field>
          <Field id="t-currency" label="Currency" hint={lockCurrency ? 'All tickets of an event use one currency.' : undefined} error={errors.currency}>
            <Select id="t-currency" {...fieldAria('t-currency', errors.currency, lockCurrency)} value={values.currency} disabled={lockCurrency} onChange={ev => set({currency: ev.target.value})} options={SUPPORTED_CURRENCIES.map(c => ({value: c, label: c}))} />
          </Field>
        </div>
        <div className="form-grid">
          <Field id="t-quantity" label="Seats" optional hint="Blank means the event capacity is the only limit." error={errors.quantity}>
            <input id="t-quantity" {...fieldAria('t-quantity', errors.quantity, true)} type="number" min={1} value={values.quantity} inputMode="numeric" onChange={ev => set({quantity: ev.target.value})} />
          </Field>
          <Field id="t-ends" label="Sales end" optional error={errors.salesEndAt}>
            <input id="t-ends" {...fieldAria('t-ends', errors.salesEndAt)} type="datetime-local" value={values.salesEndAt} onChange={ev => set({salesEndAt: ev.target.value})} />
          </Field>
        </div>
        {failed && <ErrorNote error={save.error!} />}
      </form>
    </Modal>
  );
}
