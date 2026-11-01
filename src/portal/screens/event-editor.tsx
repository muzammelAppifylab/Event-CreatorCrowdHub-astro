import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useParams} from '@tanstack/react-router';
import {useEffect, useRef, useState} from 'react';

import {useUnsavedGuard} from '../use-unsaved-guard';
import {CoverPicker} from './cover-picker';
import {EventPreview} from './event-editor-preview';
import {AutomaticEmails} from './messages';
import {Polls} from './polls';

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
  type QuestionType,
  QUESTION_TYPES,
  SUPPORTED_CURRENCIES,
  timeZoneOptions,
  toLocalInput,
} from '../../lib/event-schemas';
import {api, ApiError, read} from '../api';
import {siteFetch} from '../../platform/browser';
import {MoveButtons, moved} from './move-buttons';
import {eventQuery, eventSettingsQuery, eventTicketsQuery, fieldAria, focusFirstInvalid, useEventsNav} from '../events-queries';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Collapsible,
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
  DateTimeField,
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
const EDITOR_SECTIONS = [['details', 'Basics'], ['cover', 'Cover'], ['datetime', 'When & where'], ['rsvp', 'Capacity & RSVP'], ['questions', 'Questions'], ['tickets', 'Tickets'], ['reminders', 'Reminders'], ['polls', 'Polls']] as const;
/** A new event has no tickets, reminders or polls yet: one card stands in for all three. */
const NEW_SECTIONS = [['details', 'Basics'], ['cover', 'Cover'], ['datetime', 'When & where'], ['rsvp', 'Capacity & RSVP'], ['questions', 'Questions'], ['tickets', 'Tickets & more']] as const;
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

/** A link made from a title, like the server's own (lower case, dashes, 60 characters). */
const slugOf = (title: string) =>
  title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');

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
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const dirty = JSON.stringify(v) !== JSON.stringify(initial) || JSON.stringify(questions) !== JSON.stringify(drafts);
  const guard = useUnsavedGuard(dirty);

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

  const [slugEdited, setSlugEdited] = useState(!isNew);
  const [justSaved, setJustSaved] = useState(false);
  const save = useMutation({
    mutationFn: async ({body, publish}: {body: ReturnType<typeof bodyOf>; publish: boolean}) => {
      const saved = await (isNew
        ? read<{event: AdminEventDetail}>(api['admin-events'].$post({json: body as never}))
        : read<{event: AdminEventDetail}>(api['admin-events'][':id'].$patch({param: {id}, json: body as never})));
      if (!publish) return {...saved, publishError: null as string | null};
      try {
        const done = await read<{event: AdminEventDetail}>(api['admin-events'][':id'].publish.$post({param: {id: saved.event.id}}));
        return {...done, publishError: null as string | null};
      } catch (err) {
        // Saved, but not live: say what is missing (the server's own message and fields).
        const fields = err instanceof ApiError ? Object.values(err.fields).join(' ') : '';
        return {...saved, publishError: `${err instanceof Error ? err.message : 'It could not be published.'}${fields ? ` ${fields}` : ''}`};
      }
    },
    onSuccess: async ({event: saved, publishError}) => {
      if (publishError) toast.danger(`Saved as a draft. ${publishError}`);
      else toast.success(saved.status === 'published' ? 'Event published.' : isNew ? 'Draft created.' : 'Changes saved.');
      setJustSaved(true);
      guard.allowNext();
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

  const submitWith = (publish: boolean) => form.submit(() => {
    const body = bodyOf(v, questions);
    // An untouched link on a new event is the server's to choose: it adds -2, -3… when the title repeats
    // and handles titles too short or reserved to make a valid link.
    if (isNew && !slugEdited) body.slug = undefined;
    const parsed = parseEventFields(body, false);
    const fields: FieldErrors = parsed.ok ? {} : parsed.fields;
    // A saved event keeps its link: a blank one is an error, not "leave it as it was".
    if (!isNew && !v.slug.trim()) fields.slug = 'Enter a link, or keep the current one.';
    if (parsed.ok) {
      const done = completeEvent(parsed.value as EventValues, {});
      if (!done.ok) Object.assign(fields, done.fields);
    }
    showErrors(fields);
    if (Object.keys(fields).length === 0) save.mutate({body, publish});
  });
  const submit = submitWith(false);

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

  const [advOpen, setAdvOpen] = useState(false);
  // A hidden field with an error must open its section, or nobody could see or focus it.
  const advErrors = (['rsvpDeadline', 'maxPlusOnes', 'thankYouLink'] as const).some(k => Boolean(form.error(k)));
  const sections = isNew ? NEW_SECTIONS : EDITOR_SECTIONS;
  const [active, setActive] = useState<string>('details');
  useEffect(() => {
    const els = sections.map(([sid]) => document.getElementById(`sec-${sid}`)).filter((el): el is HTMLElement => Boolean(el));
    if (!els.length || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      entries => {
        const hit = entries.filter(entry => entry.isIntersecting).sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top)[0];
        if (hit) setActive(hit.target.id.replace('sec-', ''));
      },
      {rootMargin: '-15% 0px -70% 0px'}
    );
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, [sections]);

  const statusLabel = !event ? 'New draft' : event.status === 'draft' ? 'Draft' : event.status === 'published' ? 'Published' : 'Cancelled';
  const statusTone = event ? STATUS_TONES[event.status] : 'neutral';
  const saveIsPrimary = published || cancelled;

  return (
    <div className="app-page screen-event-editor" data-view={view}>
      <div className="editor-viewtoggle" role="group" aria-label="Form or preview">
        <Button variant={view === 'edit' ? 'primary' : 'secondary'} size="sm" aria-pressed={view === 'edit'} onClick={() => setView('edit')}>
          Form
        </Button>
        <Button variant={view === 'preview' ? 'primary' : 'secondary'} size="sm" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>
          Preview
        </Button>
      </div>

      <div className="editor-main">
        <form id="event-form" ref={formRef} noValidate onSubmit={submit}>
          <div className="editor-crumb">
            <Button variant="ghost" size="sm" icon="arrow-left" onClick={() => nav('/events')} disabled={busy}>
              Events
            </Button>
          </div>
          <PageHeader
            title={
              <span className="editor-title-row">
                {isNew ? 'New event' : 'Edit event'}
                <StatusBadge tone={statusTone}>{statusLabel}</StatusBadge>
              </span>
            }
            description={
              published && event ? (
                <a href={event.publicPath} target="_blank" rel="noopener noreferrer">
                  {event.publicPath}
                </a>
              ) : (
                'New events stay as drafts until you publish. Publishing saves your changes first.'
              )
            }
            actions={
              <div className="editor-head-actions" role="group" aria-label="Save">
                <span className="editor-bar-state" aria-live="polite">
                  {dirty && (
                    <>
                      <span className="editor-dot" aria-hidden="true" />
                      Unsaved changes
                    </>
                  )}
                </span>
                {event && !cancelled && published && (
                  <Button variant="secondary" onClick={() => setStatus.mutate('unpublish')} pending={setStatus.isPending} pendingLabel="Unpublishing…" disabled={save.isPending}>
                    Unpublish
                  </Button>
                )}
                <Button
                  type="submit"
                  variant={saveIsPrimary ? 'primary' : 'secondary'}
                  pending={save.isPending && !save.variables?.publish}
                  pendingLabel="Saving…"
                  disabled={setStatus.isPending || save.isPending || cancelled}>
                  {isNew ? 'Save draft' : 'Save changes'}
                </Button>
                {!published && !cancelled && (
                  <Button type="button" onClick={submitWith(true)} pending={save.isPending && save.variables?.publish} pendingLabel="Publishing…" disabled={setStatus.isPending || save.isPending}>
                    Publish
                  </Button>
                )}
              </div>
            }
          />

          <nav aria-label="Editor sections" className="editor-nav">
            {sections.map(([sid, label]) => (
              <a
                key={sid}
                href={`#sec-${sid}`}
                aria-current={active === sid ? 'true' : undefined}
                onClick={ev => {
                  ev.preventDefault();
                  setActive(sid);
                  document.getElementById(`sec-${sid}`)?.scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'});
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
              <Card title="Basics" description="What guests read first. The link follows the title until you change it.">
                <div className="form-stack">
                  <Field id="f-title" label="Title" error={form.error('title')}>
                    <input
                      {...form.field('title')}
                      className="editor-title-input"
                      maxLength={120}
                      autoComplete="off"
                      placeholder="Pricing Q&A with Clara"
                      onChange={ev => {
                        form.field('title').onChange?.(ev);
                        if (!slugEdited) form.set('slug', slugOf(ev.target.value));
                      }}
                    />
                  </Field>
                  <Field id="f-description" label="Description" hint="Shown on the event page. Leave a blank line between paragraphs." error={form.error('description')}>
                    <textarea {...form.field('description')} rows={6} />
                  </Field>
                  <Field
                    id="f-slug"
                    label="Link"
                    optional={isNew}
                    hint={`The public page is /events/${v.slug.trim() || 'your-title'}/. ${isNew ? 'It follows the title until you edit it.' : ''}${published ? ' Changing it breaks links you’ve already shared.' : ''}`}
                    error={form.error('slug')}>
                    <input
                      {...form.field('slug')}
                      maxLength={60}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={ev => {
                        setSlugEdited(true);
                        form.field('slug').onChange?.(ev);
                      }}
                    />
                  </Field>
                </div>
              </Card>
            </div>

            <div id="sec-cover" className="editor-section">
              <CoverPicker
                values={v}
                event={{title: v.title, startAt: fromLocalInput(v.startAt, v.timezone), timezone: v.timezone, format: v.format, venueName: v.venueName, capacity: v.capacity}}
                seed={event?.id ?? 'new-event'}
                set={(name, value) => form.set(name, value)}
                error={name => form.error(name)}
                inputProps={name => form.field(name) as Record<string, unknown>}
              />
            </div>

            <div id="sec-datetime" className="editor-section">
              <Card title="When & where" description="Guests see their own local time first, with the event’s timezone underneath.">
                <div className="form-stack">
                  <div className="form-grid">
                    <Field id="f-startAt" label="Starts" error={form.error('startAt')}>
                      <DateTimeField {...form.field('startAt')} />
                    </Field>
                    <Field id="f-endAt" label="Ends" error={form.error('endAt')}>
                      <DateTimeField {...form.field('endAt')} />
                    </Field>
                  </div>
                  <Field id="f-timezone" label="Timezone" error={form.error('timezone')}>
                    <Select {...form.field('timezone')} options={zones} />
                  </Field>
                  {event && v.startAt && (
                    <p className="muted">
                      Saved as {formatInZone(new Date(event.startAt), event.timezone)}.
                    </p>
                  )}
                  <hr className="editor-divider" />
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
                      <Field id="f-mapUrl" label="Map link" optional hint="A Google or Apple Maps link." error={form.error('mapUrl')}>
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

            <div id="sec-rsvp" className="editor-section">
              <Card title="Capacity & RSVP" description="Who can find the event, how many can come, and how guests get in.">
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
                  </div>
                  {checkbox('waitlistEnabled', 'Waitlist', 'When the event is full, guests can join a waitlist.')}
                  {checkbox('approvalRequired', 'Approve guests', 'You approve each RSVP before the guest is confirmed.')}
                  <Collapsible
                    open={advOpen || advErrors}
                    onOpenChange={setAdvOpen}
                    trigger={
                      <span className="editor-more">
                        More RSVP options
                        <span className="muted">Deadline, plus-ones, “Maybe”, guest list, thank-you link</span>
                      </span>
                    }>
                    <div className="form-stack editor-more-body">
                      <Field id="f-rsvpDeadline" label="RSVP deadline" optional hint="Guests can’t RSVP after this. Blank means until the event starts." error={form.error('rsvpDeadline')}>
                        <DateTimeField {...form.field('rsvpDeadline')} />
                      </Field>
                      {v.rsvpDeadline && (
                        <div>
                          <Button variant="ghost" size="sm" onClick={() => form.set('rsvpDeadline', '')}>
                            Remove deadline
                          </Button>
                        </div>
                      )}
                      <Field id="f-maxPlusOnes" label="Plus-ones per guest" hint={`0 to ${MAX_PLUS_ONES}.`} error={form.error('maxPlusOnes')}>
                        <input {...form.field('maxPlusOnes')} type="number" min={0} max={MAX_PLUS_ONES} inputMode="numeric" />
                      </Field>
                      {checkbox('allowMaybe', 'Allow “Maybe”', 'Guests can answer going, maybe or not going.')}
                      {checkbox('showGuestList', 'Show the guest list', 'Confirmed guests see who else is coming.')}
                      <Field id="f-thankYouLink" label="Thank-you link" optional hint="Where the thank-you email sends guests (a survey, a recording)." error={form.error('thankYouLink')}>
                        <input {...form.field('thankYouLink')} inputMode="url" placeholder="https://…" />
                      </Field>
                    </div>
                  </Collapsible>
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
                      <div key={q.id ?? `new-${i}`} className="form-stack editor-question">
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
                          <MoveButtons what={`question ${i + 1}`} index={i} count={questions.length} onMove={to => setQuestions(current => moved(current, i, to))} />
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

        <fieldset className="form-stack" disabled={cancelled}>
          {event ? (
            <>
              <div id="sec-tickets" className="editor-section">
                <Tickets event={event} />
              </div>
              <div id="sec-reminders" className="editor-section">
                <AutomaticEmails eventId={event.id} />
              </div>
              <div id="sec-polls" className="editor-section">
                <Polls eventId={event.id} />
              </div>
            </>
          ) : (
            <div id="sec-tickets" className="editor-section">
              <Card title="Tickets, reminders & polls" description="These open up once the draft exists.">
                <ul className="editor-later">
                  <li>
                    <strong>Tickets</strong> Free and paid ticket types. Without any, RSVPs are free.
                  </li>
                  <li>
                    <strong>Reminders</strong> Automatic emails. New events start with the defaults from Event settings.
                  </li>
                  <li>
                    <strong>Polls</strong> Prepare them here, then open them live from the event hub.
                  </li>
                </ul>
                <p className="muted">Use Save draft at the top, then come back to this page.</p>
              </Card>
            </div>
          )}
        </fieldset>
      </div>

      <aside className="editor-preview" aria-label="Live preview">
        <div className="editor-status">
          <div className="editor-status-row">
            <StatusBadge tone={statusTone}>{statusLabel}</StatusBadge>
            {dirty && <Badge tone="warning">Unsaved changes</Badge>}
          </div>
          <p className="muted">
            {cancelled
              ? 'Cancelled. The page shows a Cancelled banner.'
              : published
                ? 'Live. Guests can open the link and RSVP.'
                : 'Not live yet. Guests can’t open the link until you publish.'}
          </p>
        </div>
        <EventPreview values={v} eventId={event?.id ?? null} seed={event?.id ?? 'new-event'} />
      </aside>
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
  const reorder = useMutation({
    mutationFn: (ids: string[]) => read(siteFetch(`/site-api/admin-events/${encodeURIComponent(event.id)}/ticket-types/order`, {method: 'PATCH', headers: {'content-type': 'application/json', accept: 'application/json'}, body: JSON.stringify({ids})})),
    onMutate: async ids => {
      await queryClient.cancelQueries({queryKey: eventTicketsQuery(event.id).queryKey});
      const previous = queryClient.getQueryData(eventTicketsQuery(event.id).queryKey);
      queryClient.setQueryData(eventTicketsQuery(event.id).queryKey, current => current && {...current, ticketTypes: ids.flatMap(id => current.ticketTypes.filter(t => t.id === id))});
      return {previous};
    },
    onError: (_err, _ids, context) => {
      if (context?.previous) queryClient.setQueryData(eventTicketsQuery(event.id).queryKey, context.previous);
      toast.danger('Could not save the new order.');
    },
    onSettled: () => queryClient.invalidateQueries({queryKey: eventTicketsQuery(event.id).queryKey}),
  });
  const rows = tickets.data?.ticketTypes;
  const columns: Column<AdminTicketType>[] = [
    {
      key: 'order',
      header: 'Order',
      width: 'shrink',
      cell: t => {
        const at = rows?.findIndex(r => r.id === t.id) ?? 0;
        return <MoveButtons what={`ticket ${t.name}`} index={at} count={rows?.length ?? 0} pending={reorder.isPending} onMove={to => rows && reorder.mutate(moved(rows, at, to).map(r => r.id))} />;
      },
    },
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
            <DateTimeField id="t-ends" {...fieldAria('t-ends', errors.salesEndAt)} value={values.salesEndAt} onChange={ev => set({salesEndAt: ev.target.value})} />
          </Field>
        </div>
        {failed && <ErrorNote error={save.error!} />}
      </form>
    </Modal>
  );
}
