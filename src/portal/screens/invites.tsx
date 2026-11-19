import {useInfiniteQuery, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';
import {encode} from 'uqr';

import {ApiError} from '../api';
import {QrCode} from '../qr';
import {
  type CreateInvitesResult,
  invitesQuery,
  type InviteRow,
  resendPreviewQuery,
  SHARE_LABELS,
  type SharePlatform,
  sendJson,
  shareKitQuery,
  shareUrl,
} from '../guests-queries';
import {ago} from '../shared';
import {
  Button,
  buttonClass,
  Card,
  type Column,
  DataTable,
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
  StatusBadge,
  type Tone,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

const STATUS_TONES: Record<InviteRow['status'], Tone> = {queued: 'warning', sent: 'info', bounced: 'danger', responded: 'success'};
const STATUS_LABELS: Record<InviteRow['status'], string> = {queued: 'Queued', sent: 'Sent', bounced: 'Bounced', responded: 'Responded'};
const RESPONSE_LABELS = {going: 'Going', maybe: 'Maybe', not_going: 'Can’t go'} as const;

const EMAIL_SHAPE = /^[^\s@<>",;]+@[^\s@<>",;.]+(?:\.[^\s@<>",;.]+)+$/;
const NAMED_ADDRESS = /(?<=^|[,;\n])\s*(?:"[^"]*"|[^,;<>\n"@]*?)\s*<([^<>\s]*)>/g;
/** Live count of valid and invalid entries in the paste box (the server parses the same way). */
function countPasted(input: string): {valid: number; invalid: number} {
  const seen = new Set<string>();
  let invalid = 0;
  const check = (raw: string) => {
    const email = raw.replace(/^<|>$/g, '').trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email) || email.length > 254) invalid++;
    else seen.add(email);
  };
  const rest = input.replace(NAMED_ADDRESS, (_m, address: string) => {
    check(address);
    return '\n';
  });
  for (const raw of rest.split(/[\s,;]+/)) if (raw) check(raw);
  return {valid: seen.size, invalid};
}

const PASTE_RULES = {emails: [rules.required('Paste at least one email address.'), rules.maxLength(200_000)]};

async function copyText(text: string, toast: ReturnType<typeof useToast>, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.danger('Copying is blocked here. Select the text and copy it by hand.');
  }
}

/** Draws the QR on a 1024 px canvas (white quiet zone) and saves it as a PNG. */
function downloadQrPng(value: string, fileName: string): boolean {
  const {data, size} = encode(value, {border: 2});
  const px = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  const cell = px / size;
  data.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) ctx.fillRect(Math.floor(x * cell), Math.floor(y * cell), Math.ceil(cell), Math.ceil(cell));
    })
  );
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  return true;
}

/**
 * The invites tab of an event: invite people by pasting emails, nudge people who have not
 * answered, copy a personal link, and the share kit. `eventId` is the event's uuid.
 */
export function InvitesTab({eventId}: {eventId: string}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [result, setResult] = useState<CreateInvitesResult | null>(null);
  const form = useForm({emails: ''}, PASTE_RULES);
  const pasted = countPasted(form.values.emails);

  const invites = useInfiniteQuery(invitesQuery(eventId));
  const preview = useQuery(resendPreviewQuery(eventId));
  const rows = invites.data?.pages.flatMap(page => page.items);
  const refresh = () => queryClient.invalidateQueries({queryKey: ['invites', eventId]});

  const create = useMutation({
    mutationFn: (values: {emails: string}) => sendJson<CreateInvitesResult>('POST', `/events/${eventId}/invites`, values),
    onSuccess: data => {
      setResult(data);
      toast.success(`${data.queued} invite${data.queued === 1 ? '' : 's'} created, ${data.sent} sent.`);
      form.reset();
      return refresh();
    },
    onError: err => err instanceof ApiError && form.setServerErrors(err.fields),
  });
  const resendAll = useMutation({
    mutationFn: () => sendJson<{resent: number; remaining: number}>('POST', `/events/${eventId}/invites/resend`),
    onSuccess: data => {
      toast.success(data.remaining ? `Resent to ${data.resent}. ${data.remaining} more can be resent now.` : `Resent to ${data.resent}.`);
      return refresh();
    },
  });
  const resendOne = useMutation({
    mutationFn: (id: string) => sendJson<{ok: true}>('POST', `/events/${eventId}/invites/${id}/resend`),
    onSuccess: () => {
      toast.success('Invite sent again.');
      return refresh();
    },
    // The server's 409s say why in words (resend_cooldown, invite_pending, invite_bounced,
    // daily_invite_limit, already_responded, event_not_published): show that message as it is.
    onError: err => toast.danger(err instanceof ApiError ? err.message : 'The invite could not be sent. Check your connection and try again.'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => sendJson<{ok: true}>('DELETE', `/events/${eventId}/invites/${id}`),
    onSuccess: refresh,
  });

  const close = () => {
    if (create.isPending) return;
    setInviting(false);
    setResult(null);
    form.reset();
    create.reset();
  };
  const count = preview.data?.count ?? 0;
  const askResend = () =>
    void confirm({
      title: `Resend to ${count} ${count === 1 ? 'person' : 'people'}?`,
      body: 'Only people who have not answered, have not bounced and were last contacted over 48 hours ago get another email.',
      confirmLabel: 'Resend',
      pendingLabel: 'Sending…',
      tone: 'primary',
      action: () => resendAll.mutateAsync(),
    });
  const askRemove = (invite: InviteRow) =>
    void confirm({
      title: `Delete the invite for ${invite.email}?`,
      body: 'Their personal link stops working. If they already RSVP’d, the RSVP stays.',
      confirmLabel: 'Delete invite',
      pendingLabel: 'Deleting…',
      action: () => remove.mutateAsync(invite.id),
    }).then(ok => ok && toast.success('Invite deleted.'));

  const busyKey = (resendOne.isPending && resendOne.variables) || (remove.isPending && remove.variables) || null;
  const columns: Column<InviteRow>[] = [
    {
      key: 'who',
      header: 'Invitee',
      cell: i => (
        <div>
          <span className="cell-title">{i.name ?? i.email}</span>
          {i.name && <span className="cell-sub">{i.email}</span>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'shrink',
      cell: i => (
        <StatusBadge tone={STATUS_TONES[i.status]}>
          {STATUS_LABELS[i.status]}
          {i.rsvpResponse ? ` · ${RESPONSE_LABELS[i.rsvpResponse]}` : ''}
        </StatusBadge>
      ),
    },
    {key: 'sent', header: 'Last sent', width: 'shrink', hideOnMobile: true, cell: i => ago(i.lastResentAt ?? i.sentAt)},
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: i => (
        <Menu
          label={`Actions for ${i.email}`}
          disabled={busyKey !== null}
          items={[
            {label: 'Copy link', icon: 'copy', onSelect: () => void copyText(i.link, toast, 'Invite link')},
            {label: 'Send again', icon: 'mail', disabled: i.status === 'responded', onSelect: () => resendOne.mutate(i.id)},
            'separator',
            {label: 'Delete invite', icon: 'trash', danger: true, onSelect: () => askRemove(i)},
          ]}
        />
      ),
    },
  ];

  return (
    <div className="app-page screen-invites">
      <div className="toolbar">
        <p className="muted">Send each person a personal RSVP link.</p>
        <div className="toolbar-group">
          <>
            <Button
              variant="secondary"
              icon="refresh"
              disabled={count === 0}
              pending={resendAll.isPending}
              pendingLabel="Resending…"
              onClick={askResend}>
              {count ? `Resend to ${count}` : 'Resend'}
            </Button>
            <Button icon="user-plus" onClick={() => setInviting(true)}>
              Invite people
            </Button>
          </>
        </div>
      </div>

      <div className="grid-main-side">
      <div className="app-page">
      <Card flush>
        <DataTable
          caption="Invites"
          columns={columns}
          rows={rows}
          rowKey={i => i.id}
          busyKey={busyKey}
          loading={invites.isPending}
          error={invites.error}
          empty={
            <EmptyState icon="mail" title="No invites yet" action={<Button icon="user-plus" onClick={() => setInviting(true)}>Invite people</Button>}>
              Paste a list of emails and each person gets a personal link.
            </EmptyState>
          }
        />
        <LoadMore query={invites} count={rows?.length} noun={['invite', 'invites']} />
      </Card>
      </div>

      <ShareKit eventId={eventId} />
      </div>

      <Modal
        open={inviting}
        onClose={close}
        title="Invite people"
        description="Paste emails separated by commas, spaces or new lines. “Name <email>” works too."
        dismissible={!create.isPending}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={create.isPending}>
              {result ? 'Done' : 'Cancel'}
            </Button>
            <Button
              pending={create.isPending}
              pendingLabel="Sending…"
              onClick={form.submit(values => {
                setResult(null);
                create.mutate(values);
              })}>
              Send invites
            </Button>
          </>
        }>
        {result && (
          <Notice tone={result.sent === result.queued ? 'success' : 'warning'} title={`${result.queued} invite${result.queued === 1 ? '' : 's'} created, ${result.sent} sent`}>
            {result.sent < result.queued && 'Some emails could not be sent. They stay queued: use Resend later. '}
            {result.skippedDuplicate.length > 0 && `${result.skippedDuplicate.length} already invited. `}
            {result.skippedInvalid.length > 0 && `Not email addresses: ${result.skippedInvalid.slice(0, 5).join(', ')}${result.skippedInvalid.length > 5 ? '…' : ''}.`}
          </Notice>
        )}
        {create.error && !(create.error instanceof ApiError && Object.keys(create.error.fields).length) && <ErrorNote error={create.error} />}
        <Field
          label="Emails"
          id="f-emails"
          error={form.error('emails')}
          hint={`Up to 200 people at a time.${pasted.valid + pasted.invalid > 0 ? ` ${pasted.valid} valid${pasted.invalid ? `, ${pasted.invalid} invalid` : ''}.` : ''}`}>
          <textarea rows={6} placeholder={'sam@example.com\nAnn Lee <ann@example.com>'} {...form.field('emails')} />
        </Field>
      </Modal>
    </div>
  );
}

/** The public link, share buttons and a QR code. */
function ShareKit({eventId}: {eventId: string}) {
  const toast = useToast();
  const kit = useQuery(shareKitQuery(eventId));
  const data = kit.data;
  return (
    <Card title="Share" description="Share the public event page, not a personal invite.">
      {kit.isPending && <LoadingBlock rows={2} />}
      {kit.error && <ErrorNote error={kit.error} />}
      {data && (
        <>
          {!data.published && (
            <Notice tone="warning" title="This event is not published yet">
              The link works once you publish the event.
            </Notice>
          )}
          <Field label="Event link" id="share-link">
            <input id="share-link" type="text" readOnly value={data.eventUrl} onFocus={event => event.target.select()} />
          </Field>
          <div className="toolbar-group">
            <Button variant="secondary" icon="copy" onClick={() => void copyText(data.eventUrl, toast, 'Link')}>
              Copy link
            </Button>
            {(Object.keys(SHARE_LABELS) as SharePlatform[]).map(platform => (
              <a
                key={platform}
                className={buttonClass({variant: 'secondary'})}
                href={shareUrl(platform, data.eventUrl, data.title)}
                target="_blank"
                rel="noopener noreferrer">
                {SHARE_LABELS[platform]}
              </a>
            ))}
          </div>
          <QrCode value={data.eventUrl} label={`QR code for ${data.title}`} />
          <Button
            variant="secondary"
            icon="file"
            onClick={() => (downloadQrPng(data.eventUrl, `${data.slug}-qr.png`) ? toast.success('QR code downloaded.') : toast.danger('Your browser could not draw the QR code.'))}>
            Download QR (PNG)
          </Button>
        </>
      )}
    </Card>
  );
}
