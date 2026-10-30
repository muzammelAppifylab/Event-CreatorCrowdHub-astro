import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {useState} from 'react';

import {ApiError} from '../api';
import {
  type AdminPoll,
  closePoll,
  createPoll,
  deletePoll,
  eventPollsQuery,
  openPoll,
  POLL_TYPE_LABELS,
  type PollStatus,
  type PollType,
  updatePoll,
} from '../polls-queries';
import {
  Button,
  buttonClass,
  Card,
  Checkbox,
  type Column,
  DataTable,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  Menu,
  PageHeader,
  RadioCards,
  rules,
  StatusBadge,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

const STATUS_TONES: Record<PollStatus, 'neutral' | 'success' | 'warning'> = {draft: 'neutral', open: 'success', closed: 'warning'};
const STATUS_LABELS: Record<PollStatus, string> = {draft: 'Draft', open: 'Open', closed: 'Closed'};
const MAX_OPTIONS = 10;
const CHOICE: PollType[] = ['single_choice', 'multi_choice'];

const EMPTY = {question: '', anonymous: true, showResultsToVoters: true};
/** The same limits `src/server/routes/admin-polls.ts` enforces. */
const RULES = {question: [rules.required('Write the question.'), rules.maxLength(200)]};

/**
 * The polls of ONE event (a tab of the event screen, or a screen of its own): build draft polls,
 * open one at a time for guests at `/p/<code>`, close it, and open the presenter view.
 * Only people with `site:event:manage` reach the API behind it.
 */
export function Polls({eventId}: {eventId: string}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const polls = useQuery(eventPollsQuery(eventId));
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [type, setType] = useState<PollType>('single_choice');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [optionsError, setOptionsError] = useState('');
  const form = useForm(EMPTY, RULES);
  const refresh = () => queryClient.invalidateQueries({queryKey: ['polls']});

  const save = useMutation({
    mutationFn: (values: typeof EMPTY) => {
      const input = {...values, type, options: CHOICE.includes(type) ? options.map(o => o.trim()) : []};
      return editing === 'new' ? createPoll(eventId, input) : updatePoll(String(editing), input);
    },
    onSuccess: () => {
      toast.success(editing === 'new' ? 'Poll added.' : 'Changes saved.');
      setEditing(null);
      return refresh();
    },
    onError: err => {
      if (!(err instanceof ApiError)) return;
      const {options: optionsMessage, type: typeMessage, ...rest} = err.fields;
      form.setServerErrors(rest);
      setOptionsError(optionsMessage ?? typeMessage ?? '');
    },
  });
  const act = useMutation({
    mutationFn: ({id, action}: {id: string; action: 'open' | 'close'}) => (action === 'open' ? openPoll(id) : closePoll(id)),
    onSuccess: (_, {action}) => {
      toast.success(action === 'open' ? 'Poll opened for voting.' : 'Poll closed.');
      return refresh();
    },
  });
  const remove = useMutation({mutationFn: (id: string) => deletePoll(id), onSuccess: refresh});

  const busyKey = (act.isPending && act.variables?.id) || (remove.isPending && remove.variables) || null;
  const list = polls.data?.polls;
  const event = polls.data?.event;

  const start = (poll?: AdminPoll) => {
    form.reset(poll ? {question: poll.question, anonymous: poll.anonymous, showResultsToVoters: poll.showResultsToVoters} : EMPTY);
    setType(poll?.type ?? 'single_choice');
    setOptions(poll && poll.options.length ? poll.options.map(o => o.label) : ['', '']);
    setOptionsError('');
    save.reset();
    setEditing(poll?.id ?? 'new');
  };
  const closeDrawer = () => {
    if (!save.isPending) setEditing(null);
  };
  const askDelete = (poll: AdminPoll) =>
    void confirm({
      title: 'Delete this poll?',
      body: `“${poll.question}” is removed. Only draft polls can be deleted.`,
      confirmLabel: 'Delete poll',
      pendingLabel: 'Deleting…',
      action: () => remove.mutateAsync(poll.id),
    }).then(ok => ok && toast.success('Poll deleted.'));

  const columns: Column<AdminPoll>[] = [
    {
      key: 'question',
      header: 'Question',
      cell: p => (
        <div>
          <span className="cell-title">{p.question}</span>
          <span className="cell-sub">{POLL_TYPE_LABELS[p.type].label}</span>
        </div>
      ),
    },
    {key: 'status', header: 'Status', width: 'shrink', cell: p => <StatusBadge tone={STATUS_TONES[p.status]}>{STATUS_LABELS[p.status]}</StatusBadge>},
    {key: 'answers', header: 'Answers', width: 'shrink', hideOnMobile: true, cell: p => (p.results ? p.results.totalVoters : '–')},
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: p =>
        busyKey === p.id ? (
          <IconButton icon="more" label="Working" size="sm" pending />
        ) : (
          <Menu
            label={`Actions for “${p.question}”`}
            disabled={busyKey !== null || save.isPending}
            items={[
              p.status === 'open'
                ? {label: 'Close poll', icon: 'ban', onSelect: () => act.mutate({id: p.id, action: 'close'})}
                : {label: p.status === 'closed' ? 'Reopen' : 'Open for voting', icon: 'zap', onSelect: () => act.mutate({id: p.id, action: 'open'})},
              ...(p.status === 'draft'
                ? [
                    {label: 'Edit', icon: 'pencil' as const, onSelect: () => start(p)},
                    'separator' as const,
                    {label: 'Delete', icon: 'trash' as const, danger: true, onSelect: () => askDelete(p)},
                  ]
                : []),
            ]}
          />
        ),
    },
  ];

  const isNew = editing === 'new';
  const saveFailed = save.error && !(save.error instanceof ApiError && Object.keys(save.error.fields).length);

  return (
    <div className="app-page screen-polls">
      <div className="toolbar">
        <p className="muted">{
          event ? (
            <>
              Guests vote at{' '}
              <strong>
                {window.location.host}/p/{event.pollJoinCode}
              </strong>
              . One poll is open at a time.
            </>
          ) : (
            'Ask the room a question and watch the answers arrive.'
          )
        }
        </p>
        <div className="toolbar-group">
          <>
            {event && (
              <Link to={`/polls/${event.pollJoinCode}/present` as never} className={buttonClass({variant: 'secondary'})}>
                Presenter view
              </Link>
            )}
            <Button icon="plus" onClick={() => start()} disabled={save.isPending}>
              New poll
            </Button>
          </>
        </div>
      </div>
      {act.error && <ErrorNote error={act.error} />}
      {remove.error && <ErrorNote error={remove.error} />}
      <Card flush>
        <DataTable
          caption="Polls"
          columns={columns}
          rows={list}
          rowKey={p => p.id}
          loading={polls.isPending}
          error={polls.error}
          busyKey={busyKey}
          empty={
            <EmptyState
              icon="zap"
              title="No polls yet"
              action={
                <Button variant="secondary" icon="plus" onClick={() => start()}>
                  New poll
                </Button>
              }>
              Build your questions ahead of time, then open them one by one during the event.
            </EmptyState>
          }
        />
      </Card>

      <Drawer
        open={editing !== null}
        onClose={closeDrawer}
        dismissible={!save.isPending}
        title={isNew ? 'New poll' : 'Edit poll'}
        description="A poll can be edited until it is first opened."
        onSubmit={form.submit(values => {
          if (CHOICE.includes(type)) {
            const labels = options.map(o => o.trim());
            const bad = labels.findIndex(l => !l);
            const message = bad >= 0 ? `Write option ${bad + 1}, or remove it.` : new Set(labels.map(l => l.toLowerCase())).size < labels.length ? 'Each option must be different.' : '';
            if (message) {
              setOptionsError(message);
              document.getElementById(`f-option-${bad >= 0 ? bad : 0}`)?.focus();
              return;
            }
          }
          setOptionsError('');
          save.mutate(values);
        })}
        footer={
          <>
            <Button variant="secondary" onClick={closeDrawer} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" pending={save.isPending} pendingLabel="Saving…">
              {isNew ? 'Add poll' : 'Save changes'}
            </Button>
          </>
        }>
        <div className="form-stack">
          <Field id="f-question" label="Question" error={form.error('question')}>
            <input {...form.field('question')} autoComplete="off" />
          </Field>
          <RadioCards
            legend="Answer type"
            name="type"
            value={type}
            onChange={setType}
            options={(Object.keys(POLL_TYPE_LABELS) as PollType[]).map(t => ({
              value: t,
              title: POLL_TYPE_LABELS[t].label,
              description: POLL_TYPE_LABELS[t].description,
            }))}
          />
          {CHOICE.includes(type) && (
            <fieldset className="poll-options">
              <legend>Options (2 to {MAX_OPTIONS})</legend>
              {options.map((label, i) => (
                <div key={i} className="poll-option-row">
                  <input
                    id={`f-option-${i}`}
                    aria-label={`Option ${i + 1}`}
                    aria-invalid={optionsError && !label.trim() ? true : undefined}
                    aria-describedby={optionsError ? 'f-options-error' : undefined}
                    value={label}
                    maxLength={100}
                    onChange={e => {
                      setOptionsError('');
                      setOptions(o => o.map((x, j) => (j === i ? e.target.value : x)));
                    }}
                  />
                  <IconButton
                    icon="x"
                    label={`Remove option ${i + 1}`}
                    size="sm"
                    disabled={options.length <= 2}
                    onClick={() => setOptions(o => o.filter((_, j) => j !== i))}
                  />
                </div>
              ))}
              {options.length < MAX_OPTIONS && (
                <Button type="button" variant="secondary" size="sm" icon="plus" onClick={() => setOptions(o => [...o, ''])}>
                  Add option
                </Button>
              )}
              {optionsError && (
                <p className="field-error" id="f-options-error" role="alert">
                  {optionsError}
                </p>
              )}
            </fieldset>
          )}
          <Checkbox
            label="Anonymous"
            description="Votes are never linked to a guest."
            checked={Boolean(form.values.anonymous)}
            onChange={v => form.set('anonymous', v)}
          />
          <Checkbox
            label="Show results to voters"
            description="Guests see the bars after they answer."
            checked={Boolean(form.values.showResultsToVoters)}
            onChange={v => form.set('showResultsToVoters', v)}
          />
          {saveFailed && <ErrorNote error={save.error!} />}
        </div>
      </Drawer>
    </div>
  );
}
