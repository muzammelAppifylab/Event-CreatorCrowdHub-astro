import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect, useState} from 'react';

import {type PaymentProvider, type PaymentSettings, paymentSettingsQuery, type ProviderStatus, savePaymentProvider} from '../payments-queries';
import {useMe} from '../shared';
import {Badge, Button, Card, ErrorNote, IconButton, LoadingBlock, Notice, PageHeader, RadioCards, useToast} from '../ui';

type Choice = PaymentProvider | 'builtin';

const toChoice = (p: PaymentProvider | null): Choice => p ?? 'builtin';
const fromChoice = (c: Choice): PaymentProvider | null => (c === 'builtin' ? null : c);

/** One plain line on what's wrong with a provider's keys, or null when it is ready. */
function problemOf(p: ProviderStatus): string | null {
  if (p.ready) return null;
  const missing = p.secrets.filter(s => !s.set).map(s => s.name);
  if (missing.length) return `Add ${missing.join(', ')} on the Secrets page.`;
  if (p.liveInPreview) return 'A live key is set here. The Preview only takes test payments: put the sandbox keys under Staging.';
  if (p.keyLooksWrong) return `The secret key doesn't look like a ${p.name} secret key. Check that you pasted the secret key, not the publishable one.`;
  if (p.modesDiffer) return 'The publishable key and the secret key are from different modes (Test and Live). Use the same mode for both.';
  return `${p.name} can't be used with these keys. Check them on the Secrets page.`;
}

const modeLabel = (mode: ProviderStatus['mode']) => (mode === 'live' ? 'Live mode' : mode === 'test' ? 'Test mode' : null);

function statusLine(p: ProviderStatus) {
  if (p.ready) return `Ready · ${modeLabel(p.mode)}`;
  const missing = p.secrets.filter(s => !s.set).length;
  return missing ? `${missing} secret${missing === 1 ? '' : 's'} missing` : 'Keys need attention';
}

/** `/dashboard/payments`: the owner picks how guests pay for tickets (docs/agent/payments-providers.md). */
export function Payments() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const settings = useQuery(paymentSettingsQuery);
  const canManage = Boolean(useMe().data?.abilities?.managePayments);
  const [choice, setChoice] = useState<Choice>('builtin');
  const saved = settings.data ? toChoice(settings.data.provider) : null;
  useEffect(() => {
    if (saved) setChoice(saved);
  }, [saved]);

  const save = useMutation({
    mutationFn: (c: Choice) => savePaymentProvider(fromChoice(c)),
    onSuccess: data => {
      queryClient.setQueryData<PaymentSettings>(paymentSettingsQuery.queryKey, data);
      toast.success(data.provider ? `Ticket payments now go to your ${data.providers.find(p => p.provider === data.provider)?.name} account.` : 'Ticket payments use the built-in checkout.');
    },
  });

  if (settings.isPending) {
    return (
      <div className="app-page screen-payments">
        <PageHeader title="Payments" description="Choose how guests pay for tickets." />
        <Card>
          <LoadingBlock rows={4} />
        </Card>
      </div>
    );
  }
  if (settings.error) {
    return (
      <div className="app-page screen-payments">
        <PageHeader title="Payments" description="Choose how guests pay for tickets." />
        <ErrorNote error={settings.error} title="The payment settings could not be loaded" />
        <Button variant="secondary" icon="refresh" onClick={() => void settings.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const data = settings.data;
  const chosen = choice === 'builtin' ? null : data.providers.find(p => p.provider === choice) ?? null;
  const current = data.provider ? data.providers.find(p => p.provider === data.provider) ?? null : null;
  const dirty = choice !== saved;
  const chosenReady = !chosen || chosen.ready;
  const saveBlocked = !canManage ? 'You can see these settings but not change them.' : chosen && !chosen.ready ? `${chosen.name} can't be chosen until its keys are added.` : null;

  return (
    <div className="app-page screen-payments">
      <PageHeader
        title="Payments"
        description="Choose how guests pay for tickets: Ezypay, your own Stripe or PayPal account, or the built-in checkout."
        actions={
          canManage ? (
            <Button icon="check" pending={save.isPending} pendingLabel="Saving…" disabled={!dirty || !chosenReady} onClick={() => save.mutate(choice)}>
              Save
            </Button>
          ) : undefined
        }
      />

      {!canManage && (
        <Notice tone="info" title="View only">
          You can see how payments are set up, but only an admin who may manage payments can change it.
        </Notice>
      )}
      {current && !current.ready && (
        <Notice tone="warning" title={`Ticket sales are paused: ${current.name} can't take payments`}>
          {problemOf(current)} Until then, guests who choose a paid ticket see "payments unavailable".
        </Notice>
      )}
      {save.error && <ErrorNote error={save.error} title="Not saved" />}

      <Card title="Payment provider" description="Guests pay for tickets with the provider you choose. Money goes straight to your own account.">
        <RadioCards<Choice>
          legend="How guests pay"
          name="payment-provider"
          value={choice}
          onChange={value => {
            save.reset();
            setChoice(value);
          }}
          columns={2}
          options={[
            {value: 'builtin', title: 'Built-in payments', description: 'The platform\'s own checkout. Nothing to set up.', disabled: !canManage},
            ...data.providers.map(p => ({value: p.provider as Choice, title: p.name, description: statusLine(p), disabled: !canManage})),
          ]}
        />
        {saveBlocked && dirty && (
          <p className="field-hint" role="status">
            {saveBlocked}
          </p>
        )}
      </Card>

      {data.providers.map(p => (
        <ProviderCard key={p.provider} status={p} selected={choice === p.provider} preview={data.preview} />
      ))}

      <p className="muted">
        Add each secret on the app's Secrets page in the dashboard, twice: the sandbox value under Staging (the editor, the Preview and the staging
        site use it) and the live value under Production (the live site). The mode follows the keys, so test and live payments never mix.
      </p>
    </div>
  );
}

function ProviderCard({status: p, selected, preview}: {status: ProviderStatus; selected: boolean; preview: boolean}) {
  const toast = useToast();
  const problem = problemOf(p);
  const copy = () =>
    void navigator.clipboard
      ?.writeText(p.webhookUrl)
      .then(() => toast.success('Webhook URL copied.'))
      .catch(() => toast.danger('Could not copy. Select the URL and copy it by hand.'));
  return (
    <Card
      title={p.name}
      description={p.keySource}
      actions={
        <>
          {selected && <Badge tone="brand">Selected</Badge>}
          {p.ready ? <Badge tone="success">{modeLabel(p.mode)}</Badge> : <Badge tone="warning">Not ready</Badge>}
        </>
      }>
      <div className="payments-provider">
        <div>
          <h4>Secrets</h4>
          <ul className="payments-secrets">
            {p.secrets.map(s => (
              <li key={s.name}>
                <code>{s.name}</code> {s.set ? <Badge tone="success">Set</Badge> : <Badge tone="danger">Missing</Badge>}
              </li>
            ))}
            {p.modeSetting && (
              <li>
                <code>{p.modeSetting}</code> <Badge tone="neutral">{p.mode === 'live' ? 'live' : 'sandbox'}</Badge>
                <span className="cell-sub">Set it to live under Production only.</span>
              </li>
            )}
          </ul>
          {problem && <p className="field-error">{problem}</p>}
        </div>
        <div>
          <h4>Webhook</h4>
          <p className="cell-sub">
            Add this endpoint in {p.name}
            {preview ? ' (the Preview gets no webhooks: the thanks page confirms payments there)' : ''}. Sandbox webhooks point at the staging site,
            live ones at the live site.
          </p>
          <p className="payments-webhook">
            <code>{p.webhookUrl}</code>
            <IconButton icon="copy" label={`Copy the ${p.name} webhook URL`} onClick={copy} />
          </p>
          <p className="cell-sub">Events to send:</p>
          <ul className="payments-events">
            {p.webhookEvents.map(e => (
              <li key={e}>
                <code>{e}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
