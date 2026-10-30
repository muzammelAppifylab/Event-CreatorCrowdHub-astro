import {useInfiniteQuery, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useRef, useState} from 'react';

import {listTags} from '../../domain/mergeTags';
import {ApiError} from '../api';
import {
  type BroadcastResult,
  DEFAULT_RULE_COPY,
  describeOffset,
  type EmailPreview,
  insertAtCursor,
  joinOffset,
  messageLogQuery,
  type MessageLogRow,
  REMINDER_KIND_LABELS,
  type ReminderKind,
  RULE_OFFSET_LIMITS,
  type RuleRow,
  rulesQuery,
  SEGMENT_LABELS,
  type Segment,
  SEGMENTS,
  segmentsQuery,
  sendJson,
  splitOffset,
  type OffsetUnit,
} from '../guests-queries';
import {when} from '../shared';
import {
  Badge,
  Button,
  Card,
  type Column,
  DataTable,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  LoadingBlock,
  LoadMore,
  Menu,
  Modal,
  Notice,
  PageHeader,
  rules,
  Select,
  StatusBadge,
  Switch,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

const TAGS = listTags();
const COPY_RULES = {
  subject: [rules.required('Add a subject.'), rules.maxLength(200)],
  body: [rules.required('Add a message.'), rules.maxLength(10_000)],
};
const RULE_RULES = {...COPY_RULES, amount: [rules.pattern(/^\d{1,5}$/, 'Enter a whole number, 0 or more.')]};
const KINDS =Object.keys(REMINDER_KIND_LABELS) as ReminderKind[];

/** The merge tags as buttons that insert at the caret of a field. */
function TagButtons({onInsert}: {onInsert: (token: string) => void}) {
  return (
    <div className="toolbar-group" role="group" aria-label="Insert a merge tag">
      {TAGS.map(tag => (
        <Button key={tag.tag} size="sm" variant="ghost" title={`${tag.label}, for example ${tag.example}`} onClick={() => onInsert(tag.token)}>
          {tag.token}
        </Button>
      ))}
    </div>
  );
}

/** Text preview of an email, with the merge tags filled in. */
function PreviewModal({preview, onClose}: {preview: EmailPreview | null; onClose: () => void}) {
  return (
    <Modal open={Boolean(preview)} onClose={onClose} title="Email preview" size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {preview && (
        <>
          <p>
            <strong>Subject:</strong> {preview.subject || '(none)'}
            <br />
            <span className="muted">
              {preview.recipient.sample ? `Shown with a sample guest (${preview.recipient.name}).` : `Shown as ${preview.recipient.name} would see it.`}
            </span>
          </p>
          {preview.unknownTags.length > 0 && (
            <Notice tone="warning" title="Unknown merge tags">
              {preview.unknownTags.map(tag => `{{${tag}}}`).join(', ')} will be left blank.
            </Notice>
          )}
          {/* The page CSP blocks inline styles (and blob frames), so an HTML frame would show the email unstyled: text only. */}
          <pre>{preview.text}</pre>
        </>
      )}
    </Modal>
  );
}

/**
 * The messages tab of an event: send a broadcast to a segment of guests, the automatic emails
 * (confirmation, reminders, we're live, thank-you) and the log of what was sent.
 * `eventId` is the event's uuid.
 */
export function MessagesTab({eventId}: {eventId: string}) {
  return (
    <div className="app-page screen-messages">
      <PageHeader title="Messages" description="Email your guests, and set up the emails that go out by themselves." />
      <Broadcast eventId={eventId} />
      <AutomaticEmails eventId={eventId} />
      <MessageLog eventId={eventId} />
    </div>
  );
}

/* ── Broadcast ──────────────────────────────────────────────────────── */

function Broadcast({eventId}: {eventId: string}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const segments = useQuery(segmentsQuery(eventId));
  const form = useForm({segment: 'going' as string, subject: '', body: ''}, COPY_RULES);
  // Minted when the composer opens and again after a send: a double click or a retry sends once.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const counts = segments.data?.counts;
  const segment = form.values.segment as Segment;
  const expected = counts?.[segment] ?? 0;

  const send = useMutation({
    mutationFn: (values: {segment: string; subject: string; body: string}) =>
      sendJson<BroadcastResult>('POST', `/events/${eventId}/messages/broadcast`, {...values, expectedCount: expected, idempotencyKey: key}),
    onSuccess: data => {
      toast.success(
        data.failed ? `Sent to ${data.message.sentCount}. ${data.failed} could not be delivered.` : `Sent to ${data.message.sentCount} ${data.message.sentCount === 1 ? 'guest' : 'guests'}.`
      );
      form.reset({segment: form.values.segment, subject: '', body: ''});
      setKey(crypto.randomUUID());
      void queryClient.invalidateQueries({queryKey: ['messages', eventId]});
    },
    onError: err => err instanceof ApiError && form.setServerErrors(err.fields),
  });
  const previewMail = useMutation({
    mutationFn: () =>
      sendJson<EmailPreview>('POST', `/events/${eventId}/messages/preview`, {kind: 'broadcast', subject: form.values.subject, body: form.values.body}),
    onSuccess: setPreview,
  });

  const insert = (token: string) => {
    const area = bodyRef.current;
    const next = insertAtCursor(form.values.body, token, area?.selectionStart ?? null, area?.selectionEnd ?? null);
    form.set('body', next.value);
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(next.caret, next.caret);
    });
  };

  const options = SEGMENTS.map(value => ({
    value,
    label: `${SEGMENT_LABELS[value]}${counts ? ` (${counts[value]})` : ''}`,
  }));
  const submit = form.submit(values => {
    void confirm({
      title: `Send to ${expected} ${expected === 1 ? 'guest' : 'guests'}?`,
      body: `“${values.subject}” goes to everyone in “${SEGMENT_LABELS[segment]}”. This cannot be undone.`,
      confirmLabel: `Send to ${expected}`,
      pendingLabel: 'Sending…',
      tone: 'primary',
      action: () => send.mutateAsync(values),
    });
  });

  return (
    <Card title="Send a message" description="One email to a group of guests. It goes to everyone in the group, whatever their marketing consent.">
      <form onSubmit={submit} noValidate>
        {segments.data && !segments.data.eventEnded && (
          <p className="muted">No-shows appear once the event has ended.</p>
        )}
        {send.error && !(send.error instanceof ApiError && Object.keys(send.error.fields).length) && <ErrorNote error={send.error} />}
        <Field label="Send to" id="f-segment" error={form.error('segment')}>
          <Select {...form.field('segment')} options={options} />
        </Field>
        <Field label="Subject" id="f-subject" error={form.error('subject')}>
          <input type="text" maxLength={200} {...form.field('subject')} />
        </Field>
        <Field label="Message" id="f-body" error={form.error('body')} hint="Merge tags fill in each guest's details.">
          <textarea rows={7} maxLength={10_000} {...form.field('body')} ref={node => {
            bodyRef.current = node;
            form.field('body').ref(node);
          }} />
        </Field>
        <TagButtons onInsert={insert} />
        <div className="toolbar-group">
          <Button
            variant="secondary"
            icon="search"
            pending={previewMail.isPending}
            pendingLabel="Rendering…"
            onClick={() => previewMail.mutate()}>
            Preview
          </Button>
          <Button type="submit" icon="mail" disabled={!counts || expected === 0} pending={send.isPending} pendingLabel="Sending…">
            {counts && expected === 0 ? 'No guests in this group' : `Send to ${expected}`}
          </Button>
        </div>
        {previewMail.error && <ErrorNote error={previewMail.error} />}
      </form>
      <PreviewModal preview={preview} onClose={() => setPreview(null)} />
    </Card>
  );
}

/* ── Automatic emails (reminder rules) ──────────────────────────────── */

type RuleForm = {kind: ReminderKind; amount: string; unit: OffsetUnit; after: boolean; subject: string; body: string};

function ruleToForm(rule: RuleRow): RuleForm {
  const {amount, unit} = splitOffset(rule.offsetMinutes);
  return {kind: rule.kind, amount: String(amount), unit, after: rule.offsetMinutes > 0, subject: rule.subject, body: rule.body};
}

function newRuleForm(kind: ReminderKind): RuleForm {
  const copy = DEFAULT_RULE_COPY[kind];
  const {amount, unit} = splitOffset(copy.offsetMinutes);
  return {kind, amount: String(amount), unit, after: copy.offsetMinutes > 0, subject: copy.subject, body: copy.body};
}

function AutomaticEmails({eventId}: {eventId: string}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const query = useQuery(rulesQuery(eventId));
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const form = useForm<RuleForm>(newRuleForm('reminder'), RULE_RULES);
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const refresh = () => queryClient.invalidateQueries({queryKey: ['messages', eventId, 'rules']});
  const rows = query.data?.rules;
  const hasConfirmation = rows?.some(r => r.kind === 'confirmation') ?? false;

  const v = form.values;
  const offsetMinutes = () => joinOffset(v.kind, Number(v.amount) || 0, v.unit, v.after);
  const save = useMutation({
    mutationFn: () => {
      const body = {offsetMinutes: offsetMinutes(), subject: v.subject, body: v.body};
      return editing === 'new'
        ? sendJson<RuleRow>('POST', `/events/${eventId}/messages/rules`, {kind: v.kind, enabled: true, ...body})
        : sendJson<RuleRow>('PATCH', `/events/${eventId}/messages/rules/${editing}`, body);
    },
    onSuccess: () => {
      toast.success(editing === 'new' ? 'Email added.' : 'Changes saved.');
      setEditing(null);
      return refresh();
    },
    onError: err => {
      if (!(err instanceof ApiError)) return;
      const {offsetMinutes: offset, ...rest} = err.fields;
      form.setServerErrors({...rest, ...(offset ? {amount: offset} : {})});
    },
  });
  const toggle = useMutation({
    mutationFn: ({id, enabled}: {id: string; enabled: boolean}) =>
      sendJson<RuleRow>('POST', `/events/${eventId}/messages/rules/${id}/toggle`, {enabled}),
    onSuccess: refresh,
    onError: err => toast.danger(err instanceof Error ? err.message : 'The email could not be updated.'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => sendJson<{ok: true}>('DELETE', `/events/${eventId}/messages/rules/${id}`),
    onSuccess: refresh,
  });
  const previewMail = useMutation({
    mutationFn: () => sendJson<EmailPreview>('POST', `/events/${eventId}/messages/preview`, {kind: v.kind, subject: v.subject, body: v.body}),
    onSuccess: setPreview,
  });

  const openNew = (kind: ReminderKind) => {
    form.reset(newRuleForm(kind));
    save.reset();
    setEditing('new');
  };
  const openEdit = (rule: RuleRow) => {
    form.reset(ruleToForm(rule));
    save.reset();
    setEditing(rule.id);
  };
  const closeDrawer = () => {
    if (!save.isPending) setEditing(null);
  };
  const askRemove = (rule: RuleRow) =>
    void confirm({
      title: `Delete the ${REMINDER_KIND_LABELS[rule.kind].toLowerCase()} email?`,
      body: 'Guests stop getting it. Emails already sent stay in the log.',
      confirmLabel: 'Delete email',
      pendingLabel: 'Deleting…',
      action: () => remove.mutateAsync(rule.id),
    }).then(ok => ok && toast.success('Email deleted.'));
  const insert = (token: string) => {
    const area = bodyRef.current;
    const next = insertAtCursor(v.body, token, area?.selectionStart ?? null, area?.selectionEnd ?? null);
    form.set('body', next.value);
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(next.caret, next.caret);
    });
  };

  const busyKey = (toggle.isPending && toggle.variables?.id) || (remove.isPending && remove.variables) || null;
  const columns: Column<RuleRow>[] = [
    {
      key: 'email',
      header: 'Email',
      cell: r => (
        <div>
          <span className="cell-title">{REMINDER_KIND_LABELS[r.kind]}</span>
          <span className="cell-sub">{r.subject}</span>
        </div>
      ),
    },
    {key: 'when', header: 'When', hideOnMobile: true, cell: r => describeOffset(r.kind, r.offsetMinutes)},
    {
      key: 'on',
      header: 'Status',
      width: 'shrink',
      cell: r => (
        <Switch
          label={r.enabled ? 'On' : 'Off'}
          checked={r.enabled}
          pending={busyKey === r.id && toggle.isPending}
          disabled={busyKey !== null && busyKey !== r.id}
          onChange={enabled => toggle.mutate({id: r.id, enabled})}
        />
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: r => (
        <Menu
          label={`Actions for the ${REMINDER_KIND_LABELS[r.kind].toLowerCase()} email`}
          disabled={busyKey !== null}
          items={[
            {label: 'Edit', icon: 'pencil', onSelect: () => openEdit(r)},
            'separator',
            {label: 'Delete', icon: 'trash', danger: true, onSelect: () => askRemove(r)},
          ]}
        />
      ),
    },
  ];

  const limits = RULE_OFFSET_LIMITS[v.kind];
  return (
    <Card
      title="Automatic emails"
      description="Sent once to each confirmed guest. Times already past when someone RSVPs are skipped."
      flush
      actions={
        <Menu
          label="Add an automatic email"
          trigger={<span>Add email</span>}
          items={KINDS.map(kind => ({
            label: REMINDER_KIND_LABELS[kind],
            icon: 'plus' as const,
            disabled: kind === 'confirmation' && hasConfirmation,
            onSelect: () => openNew(kind),
          }))}
        />
      }>
      <DataTable
        caption="Automatic emails"
        columns={columns}
        rows={rows}
        rowKey={r => r.id}
        busyKey={busyKey}
        loading={query.isPending}
        error={query.error}
        empty={
          <EmptyState icon="bell" title="No automatic emails">
            Add a confirmation, a reminder before the event or a thank-you after it.
          </EmptyState>
        }
      />
      <Drawer
        open={editing !== null}
        onClose={closeDrawer}
        title={editing === 'new' ? `New ${REMINDER_KIND_LABELS[v.kind].toLowerCase()} email` : `${REMINDER_KIND_LABELS[v.kind]} email`}
        dismissible={!save.isPending}
        onSubmit={form.submit(() => save.mutate())}
        footer={
          <>
            <Button variant="secondary" onClick={closeDrawer} disabled={save.isPending}>
              Cancel
            </Button>
            <Button variant="secondary" pending={previewMail.isPending} pendingLabel="Rendering…" onClick={() => previewMail.mutate()}>
              Preview
            </Button>
            <Button type="submit" pending={save.isPending} pendingLabel="Saving…">
              {editing === 'new' ? 'Add email' : 'Save changes'}
            </Button>
          </>
        }>
        {save.error && !(save.error instanceof ApiError && Object.keys(save.error.fields).length) && <ErrorNote error={save.error} />}
        {previewMail.error && <ErrorNote error={previewMail.error} />}
        {v.kind !== 'confirmation' && (
          <div className="toolbar-group">
            <Field label="Amount" id="f-amount" error={form.error('amount')}>
              <input type="number" min={0} {...form.field('amount')} />
            </Field>
            <Field label="Unit" id="f-unit">
              <Select {...form.field('unit')} options={[{value: 'minutes', label: 'Minutes'}, {value: 'hours', label: 'Hours'}, {value: 'days', label: 'Days'}]} />
            </Field>
            {v.kind === 'live_now' && (
              <Field label="Relative to the start" id="f-after">
                <Select
                  id="f-after"
                  value={v.after ? 'after' : 'before'}
                  onChange={event => form.set('after', event.target.value === 'after')}
                  options={[{value: 'before', label: 'Before'}, {value: 'after', label: 'After'}]}
                />
              </Field>
            )}
          </div>
        )}
        <p className="muted">
          {describeOffset(v.kind, offsetMinutes())}
          {limits.min !== limits.max && ` (allowed: ${describeOffset(v.kind, v.kind === 'reminder' ? limits.min : limits.max)} at most)`}
        </p>
        <Field label="Subject" id="rule-subject" error={form.error('subject')}>
          <input type="text" maxLength={200} {...form.field('subject')} id="rule-subject" aria-describedby="rule-subject-error" />
        </Field>
        <Field label="Message" id="rule-body" error={form.error('body')}>
          <textarea rows={8} maxLength={10_000} {...form.field('body')} id="rule-body" aria-describedby="rule-body-error" ref={node => {
            bodyRef.current = node;
            form.field('body').ref(node);
          }} />
        </Field>
        <TagButtons onInsert={insert} />
      </Drawer>
      <PreviewModal preview={preview} onClose={() => setPreview(null)} />
    </Card>
  );
}

/* ── Log ────────────────────────────────────────────────────────────── */

function MessageLog({eventId}: {eventId: string}) {
  const log = useInfiniteQuery(messageLogQuery(eventId));
  const rows = log.data?.pages.flatMap(page => page.items);
  const columns: Column<MessageLogRow>[] = [
    {
      key: 'subject',
      header: 'Message',
      cell: m => (
        <div>
          <span className="cell-title">{m.subject}</span>
          <span className="cell-sub">To {SEGMENT_LABELS[m.segment]}</span>
        </div>
      ),
    },
    {
      key: 'result',
      header: 'Delivered',
      width: 'shrink',
      cell: m => (
        <>
          <Badge tone="success">{m.sentCount} sent</Badge>
          {m.failedCount > 0 && <StatusBadge tone="danger">{m.failedCount} failed</StatusBadge>}
        </>
      ),
    },
    {key: 'when', header: 'Sent', width: 'shrink', hideOnMobile: true, cell: m => when(m.createdAt)},
  ];
  return (
    <>
      <Card title="Message log" description="Every broadcast sent for this event, newest first." flush>
        <DataTable
          caption="Sent messages"
          columns={columns}
          rows={rows}
          rowKey={m => m.id}
          loading={log.isPending}
          error={log.error}
          empty={
            <EmptyState icon="mail" title="Nothing sent yet">
              Broadcasts you send show here.
            </EmptyState>
          }
        />
      </Card>
      <LoadMore query={log} />
    </>
  );
}
