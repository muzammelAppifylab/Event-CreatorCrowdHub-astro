import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {ApiError} from '../api';
import {contactsExportUrl, downloadExport, EMPTY_CONTACT_FILTER} from '../guests-queries';
import {
  createWebhook,
  deleteWebhook,
  testWebhook,
  updateWebhook,
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_EVENT_NAMES,
  webhooksQuery,
  type WebhookEndpoint,
  type WebhookEventName,
} from '../webhooks-queries';
import {
  Button,
  Card,
  Checkbox,
  type Column,
  DataTable,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  Menu,
  Notice,
  PageHeader,
  StatusBadge,
  useConfirm,
  useForm,
  useToast,
  rules,
} from '../ui';

const URL_RULES = {url: [rules.required('Enter the receiver URL.'), rules.pattern(/^https:\/\/\S+$/i, 'The URL must start with https://'), rules.maxLength(500)]};

/** `/dashboard/integrations` (holders of `site:event:manage`): outbound webhooks for Zapier, Make and friends. */
export function Integrations() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const hooks = useQuery(webhooksQuery);
  const [exporting, setExporting] = useState(false);
  const exportContacts = async () => {
    setExporting(true);
    try {
      await downloadExport(contactsExportUrl(EMPTY_CONTACT_FILTER), 'contacts.csv');
      toast.success('Contacts exported.');
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : 'The export failed.');
    } finally {
      setExporting(false);
    }
  };
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<WebhookEventName[]>([...WEBHOOK_EVENT_NAMES]);
  const [eventsError, setEventsError] = useState<string>();
  const [secret, setSecret] = useState<string | null>(null);
  const form = useForm({url: ''}, URL_RULES);
  const refresh = () => queryClient.invalidateQueries({queryKey: ['webhooks']});

  const create = useMutation({
    mutationFn: createWebhook,
    onSuccess: ({secret}) => {
      setOpen(false);
      setSecret(secret);
      form.reset();
      return refresh();
    },
    onError: err => {
      if (!(err instanceof ApiError)) return;
      if (err.fields.url) form.setServerErrors({url: err.fields.url});
      if (err.fields.events) setEventsError(err.fields.events);
    },
  });
  const toggle = useMutation({
    mutationFn: ({id, active}: {id: string; active: boolean}) => updateWebhook(id, {active}),
    onSuccess: (_, {active}) => {
      toast.success(active ? 'Webhook resumed.' : 'Webhook paused.');
      return refresh();
    },
  });
  const remove = useMutation({mutationFn: deleteWebhook, onSuccess: refresh});
  const test = useMutation({
    mutationFn: testWebhook,
    onSuccess: (r) =>
      r.ok ? toast.success(`Test delivered (${r.status}, ${r.durationMs} ms).`) : toast.danger(`Test failed: ${r.error ?? 'the receiver did not accept it'}.`),
  });

  const busyKey =
    (toggle.isPending && toggle.variables?.id) || (remove.isPending && remove.variables) || (test.isPending && test.variables) || null;

  const startNew = () => {
    form.reset();
    create.reset();
    setEvents([...WEBHOOK_EVENT_NAMES]);
    setEventsError(undefined);
    setOpen(true);
  };
  const closeDrawer = () => {
    if (!create.isPending) setOpen(false);
  };
  const askDelete = (hook: WebhookEndpoint) =>
    void confirm({
      title: 'Delete this webhook?',
      body: `Nothing more is sent to ${hostOf(hook.url)}. This can't be undone.`,
      confirmLabel: 'Delete webhook',
      pendingLabel: 'Deleting…',
      action: () => remove.mutateAsync(hook.id),
    }).then(ok => ok && toast.success('Webhook deleted.'));

  const columns: Column<WebhookEndpoint>[] = [
    {
      key: 'url',
      header: 'Receiver',
      cell: h => (
        <>
          <span className="cell-title">{hostOf(h.url)}</span>
          <span className="cell-sub">Secret ending {h.secretHint}</span>
        </>
      ),
    },
    {
      key: 'events',
      header: 'Events',
      hideOnMobile: true,
      cell: h => (h.events.length === WEBHOOK_EVENT_NAMES.length ? 'All events' : h.events.map(e => WEBHOOK_EVENT_LABELS[e]).join(', ')),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'shrink',
      cell: h => <StatusBadge tone={h.active ? 'success' : 'neutral'}>{h.active ? 'Active' : 'Paused'}</StatusBadge>,
    },
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: h => (
        <Menu
          label={`Actions for ${hostOf(h.url)}`}
          disabled={busyKey !== null}
          items={[
            {label: 'Send test event', icon: 'zap', onSelect: () => test.mutate(h.id)},
            {label: h.active ? 'Pause' : 'Resume', icon: h.active ? 'ban' : 'refresh', onSelect: () => toggle.mutate({id: h.id, active: !h.active})},
            'separator',
            {label: 'Delete', icon: 'trash', danger: true, onSelect: () => askDelete(h)},
          ]}
        />
      ),
    },
  ];

  const pickEvent = (name: WebhookEventName, on: boolean) => {
    setEventsError(undefined);
    setEvents(current => (on ? [...current, name] : current.filter(e => e !== name)));
  };
  const submit = form.submit(({url}) => {
    if (events.length === 0) return setEventsError('Pick at least one event.');
    create.mutate({url: url.trim(), events});
  });
  const createFailed = create.error && !(create.error instanceof ApiError && Object.keys(create.error.fields).length);

  return (
    <div className="app-page integrations-screen">
      <PageHeader
        title="Integrations"
        description="Send each event to Zapier, Make or your own server as a signed JSON POST."
        actions={
          <>
            <Button variant="secondary" icon="file" pending={exporting} onClick={() => void exportContacts()}>
              Export contacts (CSV)
            </Button>
            <Button icon="plus" onClick={startNew}>
              Add webhook
            </Button>
          </>
        }
      />

      {secret && (
        <Notice
          tone="success"
          title="Copy your signing secret now. You will not see it again"
          action={
            <Button variant="secondary" icon="copy" onClick={() => void navigator.clipboard
                ?.writeText(secret)
                .then(() => toast.success('Secret copied.'))
                .catch(() => toast.danger('Could not copy. Select the secret and copy it by hand.'))}>
              Copy
            </Button>
          }>
          <code>{secret}</code>
          <br />
          It is shown only once. Use it to verify each delivery (see "Verify deliveries" below).{' '}
          <Button variant="secondary" size="sm" onClick={() => setSecret(null)}>
            I saved it
          </Button>
        </Notice>
      )}
      {(toggle.error || test.error) && <ErrorNote error={(toggle.error ?? test.error)!} />}

      <Card flush>
        <DataTable
          caption="Webhooks"
          columns={columns}
          rows={hooks.data?.endpoints}
          rowKey={h => h.id}
          loading={hooks.isPending}
          error={hooks.error}
          busyKey={busyKey}
          empty={
            <EmptyState
              icon="zap"
              title="No webhooks yet"
              action={
                <Button variant="secondary" icon="plus" onClick={startNew}>
                  Add webhook
                </Button>
              }>
              Add an endpoint to start receiving events when someone RSVPs, pays or checks in.
            </EmptyState>
          }
        />
      </Card>
      <p className="muted">
        A delivery that cannot be sent right away, or that a receiver refuses with a temporary error, is kept and retried with growing delays for up to a
        day. Each try is signed again. Final refusals are listed in the platform's Jobs tab.
      </p>

      <Card title="Verify deliveries" description="Check every request before you trust it. The secret is the one shown when you added the webhook.">
        <ol>
          <li>
            Read the raw request body exactly as received (before any JSON parsing) and the <code>X-Ezy-Timestamp</code> header (unix seconds).
          </li>
          <li>
            Reject the request when the timestamp is more than 5 minutes away from your clock. This stops someone replaying a captured request later.
          </li>
          <li>
            Compute the HMAC-SHA256 of <code>timestamp + "." + raw body</code> with your secret, as hex, and prefix it with <code>v2=</code>. Compare it
            with the <code>X-Ezy-Signature-V2</code> header in constant time (for example <code>crypto.timingSafeEqual</code>), never with <code>==</code>.
          </li>
          <li>
            Remember each <code>X-Ezy-Delivery</code> id for a day and ignore one you have already processed. A delivery can arrive twice and is
            retried with the same id.
          </li>
        </ol>
        <p className="muted">
          The older <code>X-Ezy-Signature</code> header (<code>sha256=</code> and the HMAC of the body alone) is still sent, but it does not protect
          against replay: prefer the V2 header.
        </p>
      </Card>

      <Drawer
        open={open}
        onClose={closeDrawer}
        dismissible={!create.isPending}
        title="Add webhook"
        description="We send a signed POST to this address when the events you pick happen."
        onSubmit={submit}
        footer={
          <>
            <Button variant="secondary" onClick={closeDrawer} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" pending={create.isPending} pendingLabel="Adding…">
              Add webhook
            </Button>
          </>
        }>
        <div className="form-stack">
          <Field id="f-url" label="Receiver URL" hint="A public https:// address, such as a Zapier or Make catch hook." error={form.error('url')}>
            <input {...form.field('url')} inputMode="url" autoComplete="off" placeholder="https://hooks.zapier.com/hooks/catch/…" />
          </Field>
          <fieldset className="form-stack" aria-describedby={eventsError ? 'f-events-error' : undefined}>
            <legend>Events</legend>
            {WEBHOOK_EVENT_NAMES.map(name => (
              <Checkbox key={name} label={WEBHOOK_EVENT_LABELS[name]} description={name} checked={events.includes(name)} onChange={on => pickEvent(name, on)} />
            ))}
            {eventsError && (
              <p className="field-error" id="f-events-error" role="alert">
                {eventsError}
              </p>
            )}
          </fieldset>
          {createFailed && <ErrorNote error={create.error!} />}
        </div>
      </Drawer>
    </div>
  );
}

/** Only the host is shown: Zapier and Make URLs carry a secret in the path. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'Invalid URL';
  }
}
