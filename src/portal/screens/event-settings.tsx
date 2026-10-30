import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {type FormEvent, useRef, useState} from 'react';

import {
  DEFAULT_RULE_COPY,
  type EventSettingsDto,
  type EventSettingsValues,
  type FieldErrors,
  FONT_PRESETS,
  type FontPreset,
  MAX_DEFAULT_REMINDER_RULES,
  offsetLimitMessage,
  parseSettingsPatch,
  POSTER_DESIGNS,
  REMINDER_KINDS,
  type ReminderKind,
  type ReminderRuleValues,
  timeZoneOptions,
} from '../../lib/event-schemas';
import {api, ApiError, read} from '../api';
import {eventSettingsQuery, fieldAria, focusFirstInvalid} from '../events-queries';
import {Button, Card, Checkbox, ErrorNote, Field, IconButton, LoadingBlock, PageHeader, RadioCards, Select, useToast} from '../ui';

const FONT_INFO: Record<FontPreset, {title: string; description: string}> = {
  inter: {title: 'Sans', description: 'Clean and neutral (Inter).'},
  serif: {title: 'Serif', description: 'Editorial and warm.'},
  rounded: {title: 'Rounded', description: 'Friendly and soft.'},
};
const KIND_LABELS: Record<ReminderKind, string> = {
  confirmation: 'Confirmation (on RSVP)',
  reminder: 'Reminder (before the start)',
  live_now: 'We’re live (around the start)',
  thank_you: 'Thank-you (after the end)',
};

/** Saves a few keys of the settings row; the same rules as the server run first. */
function useSave(onFields: (fields: FieldErrors) => void) {
  const formEl = useRef<HTMLFormElement | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: (patch: Partial<EventSettingsValues>) => read<{settings: EventSettingsDto}>(api['event-settings'].$patch({json: patch as never})),
    onSuccess: () => {
      toast.success('Settings saved.');
      return queryClient.invalidateQueries({queryKey: ['event-settings']});
    },
    onError: err => {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        onFields(err.fields);
        focusFirstInvalid(formEl.current);
      }
    },
  });
  const save = (patch: Record<string, unknown>, form: HTMLFormElement) => {
    formEl.current = form;
    const parsed = parseSettingsPatch(patch);
    onFields(parsed.ok ? {} : parsed.fields);
    if (parsed.ok) mutation.mutate(patch as Partial<EventSettingsValues>);
    else focusFirstInvalid(form);
  };
  const failed = mutation.error && !(mutation.error instanceof ApiError && Object.keys(mutation.error.fields).length);
  return {save, pending: mutation.isPending, error: failed ? mutation.error : null};
}

/** `/dashboard/event-settings`: branding, defaults for new events, default emails (`site:event:manage`). */
export function EventSettings() {
  const query = useQuery(eventSettingsQuery);
  const settings = query.data?.settings;
  return (
    <div className="app-page screen-event-settings">
      <PageHeader title="Event settings" description="How your events look, what new events start with, and the emails every event sends." />
      {query.error && <ErrorNote error={query.error} />}
      {!settings ? (
        !query.error && <LoadingBlock rows={4} />
      ) : (
        <>
          <BrandingCard key={`b-${settings.updatedAt}`} settings={settings} />
          <DefaultsCard key={`d-${settings.updatedAt}`} settings={settings} />
          <EmailsCard key={`e-${settings.updatedAt}`} settings={settings} />
        </>
      )}
    </div>
  );
}

function BrandingCard({settings}: {settings: EventSettingsDto}) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [color, setColor] = useState(settings.brandColor ?? '');
  const [font, setFont] = useState<FontPreset>(settings.fontPreset);
  const {save, pending, error} = useSave(setErrors);
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    save({brandColor: color.trim() === '' ? null : color, fontPreset: font}, ev.currentTarget as HTMLFormElement);
  };
  return (
    <form noValidate onSubmit={submit}>
      <Card
        title="Branding"
        description="Colour and font for public event pages and emails."
        footer={
          <Button type="submit" pending={pending} pendingLabel="Saving…">
            Save branding
          </Button>
        }>
        <div className="form-stack">
          <Field id="s-brandColor" label="Brand colour" optional hint="A hex colour like #4f46e5. Blank keeps the default black and white." error={errors.brandColor}>
            <input id="s-brandColor" {...fieldAria('s-brandColor', errors.brandColor, true)} value={color} onChange={ev => setColor(ev.target.value)} maxLength={7} autoComplete="off" spellCheck={false} placeholder="#4f46e5" />
          </Field>
          <RadioCards legend="Font" name="fontPreset" columns={3} value={font} onChange={setFont} options={FONT_PRESETS.map(f => ({value: f, title: FONT_INFO[f].title, description: FONT_INFO[f].description}))} />
          {error && <ErrorNote error={error} />}
        </div>
      </Card>
    </form>
  );
}

function DefaultsCard({settings}: {settings: EventSettingsDto}) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [timezone, setTimezone] = useState(settings.defaultTimezone);
  const [senderName, setSenderName] = useState(settings.senderName);
  const [replyToEmail, setReplyToEmail] = useState(settings.replyToEmail);
  const [allowMaybe, setAllowMaybe] = useState(settings.allowMaybeDefault);
  const [showGuests, setShowGuests] = useState(settings.showGuestListDefault);
  const [poster, setPoster] = useState(settings.defaultCoverPoster ?? '');
  const {save, pending, error} = useSave(setErrors);
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    save({
      defaultTimezone: timezone,
      senderName,
      replyToEmail,
      allowMaybeDefault: allowMaybe,
      showGuestListDefault: showGuests,
      defaultCoverPoster: poster || null,
    }, ev.currentTarget as HTMLFormElement);
  };
  return (
    <form noValidate onSubmit={submit}>
      <Card
        title="Defaults for new events"
        description="New events start with these; each event can change them."
        footer={
          <Button type="submit" pending={pending} pendingLabel="Saving…">
            Save defaults
          </Button>
        }>
        <div className="form-stack">
          <Field id="s-timezone" label="Timezone" error={errors.defaultTimezone}>
            <Select id="s-timezone" {...fieldAria('s-timezone', errors.defaultTimezone)} value={timezone} onChange={ev => setTimezone(ev.target.value)} options={timeZoneOptions(timezone)} />
          </Field>
          <div className="form-grid">
            <Field id="s-senderName" label="Email sender name" hint="Guests see this as the sender." error={errors.senderName}>
              <input id="s-senderName" {...fieldAria('s-senderName', errors.senderName, true)} value={senderName} onChange={ev => setSenderName(ev.target.value)} maxLength={80} autoComplete="off" />
            </Field>
            <Field id="s-replyTo" label="Reply-to email" hint="Where guests’ replies go." error={errors.replyToEmail}>
              <input id="s-replyTo" {...fieldAria('s-replyTo', errors.replyToEmail, true)} type="email" value={replyToEmail} onChange={ev => setReplyToEmail(ev.target.value)} maxLength={254} autoComplete="off" />
            </Field>
          </div>
          <Field id="s-poster" label="Default poster" optional error={errors.defaultCoverPoster}>
            <Select id="s-poster" {...fieldAria('s-poster', errors.defaultCoverPoster)} value={poster} onChange={ev => setPoster(ev.target.value)} options={[{value: '', label: 'Automatic'}, ...POSTER_DESIGNS.map(p => ({value: p, label: p[0]!.toUpperCase() + p.slice(1)}))]} />
          </Field>
          <Checkbox label="Allow “Maybe”" description="New events let guests answer maybe." checked={allowMaybe} onChange={setAllowMaybe} />
          <Checkbox label="Show the guest list" description="New events show who is coming to confirmed guests." checked={showGuests} onChange={setShowGuests} />
          {error && <ErrorNote error={error} />}
        </div>
      </Card>
    </form>
  );
}

type RuleDraft = {kind: ReminderKind; offsetMinutes: string; enabled: boolean; subject: string; body: string};
const draftOf = (r: ReminderRuleValues): RuleDraft => ({...r, offsetMinutes: String(r.offsetMinutes)});

function EmailsCard({settings}: {settings: EventSettingsDto}) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [rules, setRules] = useState<RuleDraft[]>(settings.defaultReminderRules.map(draftOf));
  const {save, pending, error} = useSave(setErrors);
  const update = (index: number, patch: Partial<RuleDraft>) => setRules(current => current.map((r, i) => (i === index ? {...r, ...patch} : r)));
  const add = (kind: ReminderKind) => {
    const copy = DEFAULT_RULE_COPY[kind];
    setRules(current => [...current, {kind, offsetMinutes: String(copy.offsetMinutes), enabled: true, subject: copy.subject, body: copy.body}]);
  };
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    save({defaultReminderRules: rules.map(r => ({kind: r.kind, offsetMinutes: r.offsetMinutes.trim() === '' ? NaN : Number(r.offsetMinutes), enabled: r.enabled, subject: r.subject, body: r.body}))}, ev.currentTarget as HTMLFormElement);
  };
  return (
    <form noValidate onSubmit={submit}>
      <Card
        title="Default emails"
        description={`Copied to every new event, where they can be edited. Up to ${MAX_DEFAULT_REMINDER_RULES}. Existing events keep theirs.`}
        actions={
          <Select
            aria-label="Add an email"
            value=""
            disabled={rules.length >= MAX_DEFAULT_REMINDER_RULES}
            onChange={ev => ev.target.value && add(ev.target.value as ReminderKind)}
            options={[{value: '', label: 'Add an email…'}, ...REMINDER_KINDS.map(k => ({value: k, label: KIND_LABELS[k]}))]}
          />
        }
        footer={
          <Button type="submit" pending={pending} pendingLabel="Saving…">
            Save emails
          </Button>
        }>
        <div className="form-stack">
          {rules.length === 0 && <p className="muted">No default emails. New events send nothing automatically until you add some.</p>}
          {rules.map((r, i) => (
            <div key={i} className="form-stack">
              <div className="toolbar">
                <strong>{KIND_LABELS[r.kind]}</strong>
                <IconButton icon="trash" label={`Remove ${KIND_LABELS[r.kind]}`} size="sm" onClick={() => setRules(current => current.filter((_, at) => at !== i))} />
              </div>
              <div className="form-grid">
                <Field id={`r-${i}-offset`} label="Minutes from the start" hint={offsetLimitMessage(r.kind)} error={errors[`defaultReminderRules.${i}.offsetMinutes`]}>
                  <input id={`r-${i}-offset`} {...fieldAria(`r-${i}-offset`, errors[`defaultReminderRules.${i}.offsetMinutes`], true)} type="number" inputMode="numeric" value={r.offsetMinutes} disabled={r.kind === 'confirmation'} onChange={ev => update(i, {offsetMinutes: ev.target.value})} />
                </Field>
                <Field id={`r-${i}-subject`} label="Subject" error={errors[`defaultReminderRules.${i}.subject`]}>
                  <input id={`r-${i}-subject`} {...fieldAria(`r-${i}-subject`, errors[`defaultReminderRules.${i}.subject`])} value={r.subject} maxLength={200} onChange={ev => update(i, {subject: ev.target.value})} />
                </Field>
              </div>
              <Field id={`r-${i}-body`} label="Message" hint="Merge tags like {{event.title}} and {{guest.first_name}} work here." error={errors[`defaultReminderRules.${i}.body`]}>
                <textarea id={`r-${i}-body`} {...fieldAria(`r-${i}-body`, errors[`defaultReminderRules.${i}.body`], true)} rows={5} value={r.body} onChange={ev => update(i, {body: ev.target.value})} />
              </Field>
              <Checkbox label="Send this email" checked={r.enabled} onChange={enabled => update(i, {enabled})} />
            </div>
          ))}
          {errors.defaultReminderRules && <p className="field-error" role="alert">{errors.defaultReminderRules}</p>}
          {error && <ErrorNote error={error} />}
        </div>
      </Card>
    </form>
  );
}
