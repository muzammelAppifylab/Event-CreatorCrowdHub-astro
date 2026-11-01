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
import {LOGO_RULE, LOGO_TYPES, parseLogoUpload} from '../../lib/event-brand';
import {putFile} from '../../platform/files-browser';
import {api, ApiError, read} from '../api';
import {eventSettingsQuery, fieldAria, focusFirstInvalid} from '../events-queries';
import {useState as useTabState} from 'react';
import type {PaidTicketRow, PaymentsStatusDto, PriceStatus} from '../../server/payments-status';
import {BrandPreview, PosterPicker} from './branding-preview';
import {DefaultRemindersEditor} from './default-reminders-editor';
import {siteQuery} from '../queries';
import {Badge, Button, Card, Checkbox, type Column, DataTable, ErrorNote, Field, IconButton, LoadingBlock, PageHeader, RadioCards, Select, Tabs, useConfirm, useToast} from '../ui';

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
  const [tab, setTab] = useTabState<'branding' | 'defaults' | 'payments'>('branding');
  return (
    <div className="app-page screen-event-settings">
      <PageHeader title="Branding & defaults" description="How your events look and what new events start with." />
      {query.error && <ErrorNote error={query.error} />}
      {!settings ? (
        !query.error && <LoadingBlock rows={4} />
      ) : (
        <Tabs
          label="Settings sections"
          value={tab}
          onChange={setTab}
          items={[
            {value: 'branding', label: 'Branding'},
            {value: 'defaults', label: 'Defaults'},
            {value: 'payments', label: 'Payments'},
          ]}>
          {/* Both stay mounted so unsaved input survives switching tabs. */}
          <div className="app-page" hidden={tab !== 'branding'}>
            <LogoCard settings={settings} />
            {/* Keyed by its own values (not updatedAt) so a logo change never drops unsaved colour edits. */}
            <BrandingCard key={`b-${settings.brandColor}-${settings.fontPreset}-${settings.defaultCoverPoster}`} settings={settings} />
          </div>
          <div className="app-page" hidden={tab !== 'defaults'}>
            <DefaultsCard key={`d-${settings.updatedAt}`} settings={settings} />
            <EmailsCard key={`e-${settings.updatedAt}`} settings={settings} />
          </div>
          <div className="app-page" hidden={tab !== 'payments'}>
            <PaymentsCard active={tab === 'payments'} />
          </div>
        </Tabs>
      )}
    </div>
  );
}

function BrandingCard({settings}: {settings: EventSettingsDto}) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [color, setColor] = useState(settings.brandColor ?? '');
  const [font, setFont] = useState<FontPreset>(settings.fontPreset);
  const [poster, setPoster] = useState(settings.defaultCoverPoster ?? '');
  const site = useQuery(siteQuery).data?.site;
  const siteName = site?.name || 'Your site';
  const {save, pending, error} = useSave(setErrors);
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    save({brandColor: color.trim() === '' ? null : color, fontPreset: font, defaultCoverPoster: poster || null}, ev.currentTarget as HTMLFormElement);
  };
  const dirty = color !== (settings.brandColor ?? '') || font !== settings.fontPreset || poster !== (settings.defaultCoverPoster ?? '');
  const isDefault = color === '' && font === 'inter' && poster === '';
  const reset = () => {
    setColor('');
    setFont('inter');
    setPoster('');
    setErrors({});
  };
  return (
    <form noValidate onSubmit={submit} className="bp-layout">
      <Card
        title="Branding"
        description="Colour, font and cover for public event pages and emails. The preview updates as you change them."
        actions={
          <Button type="button" variant="ghost" size="sm" disabled={isDefault} onClick={reset}>
            Reset to default
          </Button>
        }
        footer={
          <Button type="submit" pending={pending} pendingLabel="Saving…" disabled={!dirty}>
            Save branding
          </Button>
        }>
        <div className="form-stack">
          <Field id="s-brandColor" label="Brand colour" optional hint="A hex colour like #4f46e5. Blank keeps the default black and white." error={errors.brandColor}>
            <input id="s-brandColor" {...fieldAria('s-brandColor', errors.brandColor, true)} value={color} onChange={ev => setColor(ev.target.value)} maxLength={7} autoComplete="off" spellCheck={false} placeholder="#4f46e5" />
          </Field>
          <RadioCards legend="Font" name="fontPreset" columns={3} value={font} onChange={setFont} options={FONT_PRESETS.map(f => ({value: f, title: FONT_INFO[f].title, description: FONT_INFO[f].description}))} />
          <PosterPicker value={poster} onChange={setPoster} />
          <div className="bp-site">
            <strong>Site name and fallback logo</strong>
            <div className="bp-site-row">
              {site?.logo ? <img className="bp-logo" src={site.logo} alt="" /> : null}
              <span>{siteName}</span>
            </div>
            <p className="muted">
              The name comes from the platform (<strong>change it in the platform dashboard</strong>). Its logo is used on event pages and in emails until you upload your own above.
            </p>
          </div>
          {error && <ErrorNote error={error} />}
        </div>
      </Card>
      <BrandPreview color={color} font={font} poster={poster} siteName={siteName} />
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
  const {save, pending, error} = useSave(setErrors);
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    save({
      defaultTimezone: timezone,
      senderName,
      replyToEmail,
      allowMaybeDefault: allowMaybe,
      showGuestListDefault: showGuests,
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
          <Checkbox label="Allow “Maybe”" description="New events let guests answer maybe." checked={allowMaybe} onChange={setAllowMaybe} />
          <Checkbox label="Show the guest list" description="New events show who is coming to confirmed guests." checked={showGuests} onChange={setShowGuests} />
          {error && <ErrorNote error={error} />}
        </div>
      </Card>
    </form>
  );
}

function EmailsCard({settings}: {settings: EventSettingsDto}) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [rules, setRules] = useState<ReminderRuleValues[]>(settings.defaultReminderRules);
  const {save, pending, error} = useSave(setErrors);
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    save({defaultReminderRules: rules}, ev.currentTarget as HTMLFormElement);
  };
  return (
    <form noValidate onSubmit={submit}>
      <Card
        title="Default emails"
        description={`Copied to every new event, where they can be edited. Up to ${MAX_DEFAULT_REMINDER_RULES}. Existing events keep theirs.`}
        footer={
          <Button type="submit" pending={pending} pendingLabel="Saving…">
            Save emails
          </Button>
        }>
        <div className="form-stack">
          <DefaultRemindersEditor value={rules} onChange={setRules} error={errors.defaultReminderRules} />
          {error && <ErrorNote error={error} />}
        </div>
      </Card>
    </form>
  );
}

const PRICE_STATUS: Record<PriceStatus, {tone: 'success' | 'danger' | 'warning' | 'neutral'; label: string}> = {
  listed: {tone: 'success', label: 'On sale'},
  missing: {tone: 'danger', label: 'No price yet'},
  mismatch: {tone: 'warning', label: 'Price differs'},
  unknown: {tone: 'neutral', label: 'Unknown'},
};

const money = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, {style: 'currency', currency}).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
};

const paymentColumns: Column<PaidTicketRow>[] = [
  {key: 'event', header: 'Event', cell: r => r.eventTitle},
  {key: 'ticket', header: 'Ticket', cell: r => r.name},
  {key: 'price', header: 'Price', width: 'shrink', cell: r => money(r.priceCents, r.currency)},
  {
    key: 'status',
    header: 'Status',
    width: 'shrink',
    cell: r => <Badge tone={PRICE_STATUS[r.priceStatus].tone}>{PRICE_STATUS[r.priceStatus].label}</Badge>,
  },
];

/** Payments are the platform's built-in checkout: nothing to connect, so this only reports status (read-only). */
function PaymentsCard({active}: {active: boolean}) {
  const query = useQuery({
    queryKey: ['event-settings', 'payments'],
    queryFn: () => read<PaymentsStatusDto>(api['event-settings'].payments.$get()),
    enabled: active,
  });
  const data = query.data;
  const checking = query.isFetching;
  return (
    <Card
      title="Payments"
      description="Paid tickets are charged with the built-in checkout. Money goes to your payment account; there is no key to connect here."
      actions={data && <Badge tone={data.mode === 'live' ? 'success' : 'warning'}>{data.mode === 'live' ? 'Live' : data.mode === 'test' ? 'Sandbox: test payments' : 'Status unknown'}</Badge>}
      footer={
        <Button type="button" variant="secondary" pending={checking} pendingLabel="Checking…" onClick={() => void query.refetch()}>
          Check again
        </Button>
      }>
      <div className="form-stack">
        {query.error && !data && <ErrorNote error={query.error} />}
        {!data && !query.error && <LoadingBlock rows={3} />}
        {data && (
          <>
            <p className="muted">
              {data.mode === 'test'
                ? 'Payments are in test mode: gateway test cards work and no real money moves. They switch to real payments once a live gateway is connected in the platform dashboard.'
                : data.mode === 'live'
                  ? 'Payments are live: guests are charged real money.'
                  : 'The payment platform could not be reached just now. Try again in a moment.'}
              {data.mode && !data.ready && ' The payment account cannot take a payment yet.'}
            </p>
            <p>
              <strong>{data.paidCount}</strong> paid ticket {data.paidCount === 1 ? 'type' : 'types'}
              {data.catalogueReachable && (data.missingCount > 0 ? <>, <strong>{data.missingCount}</strong> without a catalogue price.</> : data.paidCount > 0 ? ', all on sale.' : '.')}
            </p>
            {data.missingCount > 0 && (
              <p className="muted">
                A ticket with no catalogue price shows guests “Tickets for this event are not on sale yet” (<code>ticket_price_missing</code>). The price is published the first time a
                guest starts checkout from the editor or Preview; the live site cannot create prices itself. If a price differs, the ticket was changed after its price was published.
              </p>
            )}
            <DataTable
              caption="Paid ticket types"
              columns={paymentColumns}
              rows={data.paidTicketTypes}
              rowKey={r => r.id}
              empty={<p className="muted">No paid tickets yet. Add a price to a ticket type on an event to sell it.</p>}
            />
            <p className="muted">Refunds are issued in the platform dashboard.</p>
          </>
        )}
      </div>
    </Card>
  );
}

/** The creator's own logo: upload (type and size checked first), replace, remove. Acts immediately, apart from the branding form. */
function LogoCard({settings}: {settings: EventSettingsDto}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const site = useQuery(siteQuery).data?.site;
  const logoUrl = settings.logoUrl ?? null;
  const refresh = () => queryClient.invalidateQueries({queryKey: ['event-settings']});

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const checked = parseLogoUpload({name: file.name, contentType: file.type, size: file.size});
      if (!checked.ok) throw new Error(checked.message);
      const grant = await read<{fileId: string; upload: Parameters<typeof putFile>[0]}>(api['event-settings'].logo.$post({json: checked.value as never}));
      const put = await putFile(grant.upload, file);
      if (!put.ok) throw new Error(put.message);
      await read(api['event-settings'].logo.complete.$post({json: {fileId: grant.fileId}}));
    },
    onSuccess: () => {
      setError(null);
      toast.success('Logo updated.');
      return refresh();
    },
    onError: err => setError(err instanceof Error ? err.message : 'The logo could not be uploaded. Try again.'),
    onSettled: () => {
      if (input.current) input.current.value = '';
    },
  });
  const remove = useMutation({
    mutationFn: () => read(api['event-settings'].logo.$delete()),
    onSuccess: () => {
      setError(null);
      toast.success('Logo removed.');
      return refresh();
    },
    onError: err => setError(err instanceof Error ? err.message : 'The logo could not be removed. Try again.'),
  });
  const busy = upload.isPending || remove.isPending;
  const shown = logoUrl ?? site?.logo ?? null;

  return (
    <Card title="Logo" description="Shown in the header of public event pages and at the top of emails. Without one, the site logo is used.">
      <div className="form-stack">
        <div className="bp-site-row">
          {shown ? <img className="bp-logo" src={shown} alt={logoUrl ? 'Your logo' : 'Site logo'} /> : null}
          <span className="muted">{logoUrl ? 'Your logo' : shown ? 'Using the site logo' : 'No logo yet'}</span>
        </div>
        <div className="toolbar">
          <input
            ref={input}
            id="s-logo"
            type="file"
            hidden
            accept={LOGO_TYPES.join(',')}
            onChange={ev => {
              const file = ev.target.files?.[0];
              if (file) {
                setError(null);
                upload.mutate(file);
              }
            }}
          />
          <Button type="button" variant="secondary" pending={upload.isPending} pendingLabel="Uploading…" disabled={busy} onClick={() => input.current?.click()}>
            {logoUrl ? 'Replace logo' : 'Upload logo'}
          </Button>
          {logoUrl && (
            <Button type="button" variant="secondary" pending={remove.isPending} pendingLabel="Removing…" disabled={busy} onClick={() => void confirm({title: 'Remove your logo?', body: 'Event pages and emails go back to the site logo.', confirmLabel: 'Remove logo', pendingLabel: 'Removing…', action: () => remove.mutateAsync()})}>
              Remove logo
            </Button>
          )}
        </div>
        <p className="muted">{LOGO_RULE}</p>
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
    </Card>
  );
}
