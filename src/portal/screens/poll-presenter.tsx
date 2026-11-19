import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link, useParams} from '@tanstack/react-router';
import {useCallback, useEffect} from 'react';

import {nextPollToOpen} from '../../domain/polls';
import {type AdminPoll, closePoll, exportPollCsv, formatJoinCode, openPoll, presenterPollsQuery} from '../polls-queries';
import {QrCode} from '../qr';
import {BarChart, Button, buttonClass, EmptyState, Icon, ErrorNote, LoadingBlock, StatusBadge, Stat, useToast} from '../ui';

/** The poll on screen: the open one, else the last opened (its final results), else the first. */
function displayed(polls: AdminPoll[]): AdminPoll | null {
  const open = polls.find(p => p.status === 'open');
  if (open) return open;
  const lastOpened = polls.filter(p => p.openedAt).sort((a, b) => Date.parse(b.openedAt!) - Date.parse(a.openedAt!))[0];
  return lastOpened ?? polls[0] ?? null;
}

const asDomain = (p: AdminPoll, i: number) => ({
  id: p.id,
  type: p.type,
  status: p.status,
  sortOrder: i,
  openedAt: p.openedAt ? new Date(p.openedAt) : null,
});

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

/**
 * `/dashboard/polls/<code>/present`: the projector view (US-25). Results refresh by react-query
 * `refetchInterval` (2s); every number is printed as text next to its bar. Keys: `→` opens the
 * next draft, `C` closes the open poll, `F` toggles full screen. Styles: `.screen-poll-present`.
 */
export function PollPresenter({code: codeProp}: {code?: string}) {
  const params = useParams({strict: false}) as {code?: string};
  const code = codeProp ?? params.code ?? '';
  const queryClient = useQueryClient();
  const toast = useToast();
  const list = useQuery(presenterPollsQuery(code));
  const polls = list.data?.polls ?? [];
  const shown = displayed(polls);
  const refresh = () => queryClient.invalidateQueries({queryKey: ['polls']});
  const open = useMutation({
    mutationFn: openPoll,
    onSuccess: () => {
      toast.success('Next poll opened.');
      return refresh();
    },
  });
  const close = useMutation({
    mutationFn: closePoll,
    onSuccess: () => {
      toast.success('Poll closed.');
      return refresh();
    },
  });
  const busy = open.isPending || close.isPending;

  const openNext = useCallback(() => {
    const next = nextPollToOpen(polls.map(asDomain));
    if (!next) return void toast.success('No more draft polls to open.');
    if (!busy) open.mutate(next.id);
  }, [polls, busy, open, toast]);
  const closeOpen = useCallback(() => {
    const current = polls.find(p => p.status === 'open');
    if (current && !busy) close.mutate(current.id);
  }, [polls, busy, close]);
  const openShown = useCallback(() => {
    if (shown && shown.status !== 'open' && !busy) open.mutate(shown.id);
  }, [shown, busy, open]);
  const fullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'ArrowRight') openNext();
      else if (event.key.toLowerCase() === 'o') openShown();
      else if (event.key.toLowerCase() === 'c') closeOpen();
      else if (event.key.toLowerCase() === 'f') fullscreen();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openNext, openShown, closeOpen, fullscreen]);

  if (list.isPending) return <div className="app-page"><LoadingBlock rows={4} /></div>;
  if (list.error) return <div className="app-page"><ErrorNote error={list.error} /></div>;
  const event = list.data!.event;
  const results = shown?.results ?? null;
  const voteUrl = `${window.location.host}/p/${event.pollJoinCode}`;

  return (
    <div className="app-page screen-poll-present">
      <header className="poll-present-top">
        <div className="toolbar-group">
          <Link className={buttonClass({variant: 'ghost', size: 'sm'})} to={`/events/${event.id}` as never} search={{tab: 'polls'} as never}>
            <Icon name="arrow-left" size={16} /> Back to event
          </Link>
          {shown && (
            <StatusBadge tone={shown.status === 'open' ? 'success' : 'neutral'}>
              {shown.status === 'open' ? 'Open' : shown.status === 'closed' ? 'Closed' : 'Draft'}
            </StatusBadge>
          )}
          <p className="muted">
            {event.title}
            {shown && polls.length > 1 && ` · ${polls.indexOf(shown) + 1} / ${polls.length}`}
          </p>
        </div>
        {results && <p><strong>{results.totalVoters} {results.totalVoters === 1 ? 'voter' : 'voters'}</strong></p>}
      </header>
      {(open.error ?? close.error) && <ErrorNote error={(open.error ?? close.error)!} />}
      <div className="poll-present-layout">
        <section aria-label="Poll" className="poll-present-main">
          {!shown ? (
            <EmptyState icon="zap" title="No polls yet">Add polls to this event, then come back to present them.</EmptyState>
          ) : (
            <>
              <h2 className="poll-present-question">{shown.question}</h2>
              {shown.status === 'draft' || !results ? (
                <p className="muted poll-present-note">Press Next poll to open this question to the room.</p>
              ) : (
                <PresenterResults poll={shown} />
              )}
            </>
          )}
        </section>
        <aside aria-label="How to join" className="poll-present-join">
          <span className="muted">Join at {window.location.host}</span>
          <strong className="poll-present-code">{formatJoinCode(event.pollJoinCode)}</strong>
          <QrCode value={`${window.location.origin}/p/${event.pollJoinCode}`} label="QR code to join the poll" size={192} />
          <span className="muted poll-present-url">{voteUrl}</span>
        </aside>
      </div>
      <div className="poll-present-controls toolbar-group" role="group" aria-label="Presenter controls">
        <Button variant="secondary" onClick={openNext} pending={open.isPending} disabled={busy}>
          <kbd>→</kbd> Next
        </Button>
        <Button variant="secondary" onClick={() => openShown()} disabled={busy || !shown || shown.status === 'open'}>
          <kbd>O</kbd> Open
        </Button>
        <Button variant="secondary" onClick={closeOpen} disabled={busy || !polls.some(p => p.status === 'open')}>
          <kbd>C</kbd> Close
        </Button>
        <Button variant="ghost" onClick={() => shown && void exportPollCsv(shown.id, toast)} disabled={!shown || shown.status === 'draft'}>
          Export CSV
        </Button>
        <Button variant="ghost" onClick={fullscreen}>
          <kbd>F</kbd> Full screen
        </Button>
      </div>
    </div>
  );
}

function PresenterResults({poll}: {poll: AdminPoll}) {
  const results = poll.results!;
  const total = <Stat label="Answers" value={results.totalVoters} />;
  if (results.options.length) {
    return (
      <div className="poll-present-body">
        {total}
        <BarChart label={`Results: ${poll.question}`} data={results.options.map(o => ({label: o.label, value: o.count}))} />
        <ul className="poll-present-list">
          {results.options.map(o => (
            <li key={o.id}>
              <span>{o.label}</span>
              <strong>{o.percent}% · {o.count}</strong>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (results.rating) {
    const {average, distribution} = results.rating;
    return (
      <div className="poll-present-body">
        <Stat label="Average rating (out of 5)" value={average === null ? '–' : average.toFixed(1)} hint={`${results.rating.count} ratings`} />
        <BarChart label={`Ratings: ${poll.question}`} data={distribution.map(d => ({label: `${d.value}`, value: d.count}))} />
      </div>
    );
  }
  return (
    <div className="poll-present-body">
      {total}
      {results.textAnswers.length === 0 ? (
        <p className="muted poll-present-note">No answers yet.</p>
      ) : (
        <ul className="poll-present-answers">
          {results.textAnswers.map((a, i) => (
            <li key={`${a.at}-${i}`}>{a.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
