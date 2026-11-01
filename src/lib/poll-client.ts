import {pollingInterval} from '../domain/polls';
import {siteFetch} from '../platform/browser';

/**
 * BROWSER: the guest voting page (`/p/<code>`, src/pages/p/[code].astro). The server renders the
 * first state into `#poll-initial`; this script draws it, keeps it fresh by short polling
 * (3s, paused while the tab is hidden, slower when nothing changes) and sends the vote.
 * The voter's identity is an HttpOnly cookie the server sets on the first vote: nothing to store here.
 * Everything is built with `textContent`, never `innerHTML` (poll text is guest/host input).
 */

type Option = {id: string; label: string};
type Poll = {
  id: string;
  question: string;
  type: 'single_choice' | 'multi_choice' | 'rating' | 'short_text';
  status: 'open' | 'closed';
  showResultsToVoters: boolean;
  options: Option[];
};
type MyVote = {optionIds: string[]; ratingValue: number | null; textValue: string | null};
export type Results = {
  totalVoters: number;
  options: {id: string; label: string; count: number; percent: number}[];
  rating: {average: number | null; count: number; distribution: {value: number; count: number}[]} | null;
  textAnswers: {text: string; at: string}[];
};
export type Active = {event: {title: string}; status: 'waiting' | 'open' | 'closed'; poll: Poll | null; myVote: MyVote | null};

const TEXT_MAX = 140;

type Attrs = Record<string, string | boolean | number | undefined>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  el.append(...kids);
  return el;
}

/** Bars + numbers for any poll type (the numbers are text, so colour is never the only signal). */
export function renderResults(results: Results, mine: string[] = []): HTMLElement {
  const box = h('div', {class: 'poll-results'});
  const bar = (label: string, count: number, percent: number, yours = false) => {
    const fill = h('span', {class: 'poll-bar-fill'});
    fill.style.width = `${percent}%`; // via the element, which the CSP allows
    return h(
      'div',
      {class: 'poll-row', 'data-mine': yours ? '' : undefined},
      h('div', {class: 'poll-row-head'}, h('span', {}, label, yours ? h('em', {class: 'poll-mine'}, 'Your pick') : ''), h('strong', {}, `${percent}%`)),
      h('span', {class: 'poll-bar', 'aria-hidden': 'true'}, fill),
      h('span', {class: 'poll-count'}, `${count} ${count === 1 ? 'vote' : 'votes'}`)
    );
  };
  if (results.options.length) {
    for (const o of results.options) box.append(bar(o.label, o.count, o.percent, mine.includes(o.id)));
  } else if (results.rating) {
    const total = results.rating.count || 1;
    box.append(h('p', {class: 'poll-average'}, results.rating.average === null ? '–' : results.rating.average.toFixed(1), h('span', {class: 'muted'}, ' out of 5')));
    for (const d of [...results.rating.distribution].reverse()) box.append(bar(`${d.value} / 5`, d.count, Math.round((d.count * 100) / total)));
  } else if (results.textAnswers.length) {
    const list = h('ul', {class: 'poll-answers'});
    for (const a of results.textAnswers) list.append(h('li', {}, a.text));
    box.append(list);
  } else {
    box.append(h('p', {class: 'muted'}, 'No answers yet.'));
  }
  box.append(h('p', {class: 'poll-total'}, `${results.totalVoters} ${results.totalVoters === 1 ? 'answer' : 'answers'} so far`));
  return box;
}

export function mountPoll(root: HTMLElement): void {
  const code = root.dataset.code ?? '';
  const guest = root.dataset.guest ?? ''; // manage token from `?g=`: sent in the POST body only, never in a requested URL
  const api = `/site-api/polls-public/${encodeURIComponent(code)}`;
  const initial = document.getElementById('poll-initial')?.textContent;
  let active: Active | null = initial ? (JSON.parse(initial) as Active) : null;
  let results: Results | null = null;
  let error = '';
  let sent = false;
  let draft: MyVote | null = null; // what the voter has picked but not sent
  let lastChange = Date.now();
  let timer: number | undefined;
  let formKey = '';

  const status = h('p', {class: 'poll-status', role: 'status', 'aria-live': 'polite'});
  const body = h('div', {class: 'poll-body'});
  root.replaceChildren(status, body);

  async function send(poll: Poll, vote: MyVote, button: HTMLButtonElement) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Sending…';
    error = '';
    status.textContent = 'Sending…';
    try {
      const res = await siteFetch(`${api}/votes`, {
        method: 'POST',
        headers: {'content-type': 'application/json', accept: 'application/json'},
        body: JSON.stringify({pollId: poll.id, type: poll.type, ...vote, ...(guest ? {g: guest} : {})}),
      });
      const answer = (await res.json().catch(() => null)) as {message?: string; myVote?: MyVote; results?: Results | null} | null;
      if (!res.ok) throw new Error(answer?.message ?? 'Your answer was not sent. Try again.');
      if (active) active.myVote = answer?.myVote ?? vote;
      results = answer?.results ?? results;
      sent = true;
      lastChange = Date.now();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Your answer was not sent. Check your connection.';
    }
    status.textContent = '';
    draw(true);
  }

  function form(poll: Poll): HTMLElement {
    const mine = active?.myVote ?? null;
    const current: MyVote = draft ?? {optionIds: [...(mine?.optionIds ?? [])], ratingValue: mine?.ratingValue ?? null, textValue: mine?.textValue ?? null};
    draft = current;
    const f = h('form', {class: 'poll-form', novalidate: true});
    const live = h('p', {class: 'poll-live'}, h('span', {class: 'poll-live-dot', 'aria-hidden': 'true'}), 'Live · answer now');
    const fieldset = h('fieldset', {class: 'poll-fieldset'}, h('legend', {class: 'poll-question'}, poll.question));
    const answered = mine && (mine.optionIds.length || mine.ratingValue !== null || mine.textValue);
    const submit = h('button', {class: 'button button-lg button-block', type: 'submit'}, poll.type === 'short_text' ? 'Send answer' : answered ? 'Update answer' : 'Send answer');
    // Nothing to send until something is chosen: the button says so instead of failing later.
    const ready = () =>
      poll.type === 'rating' ? current.ratingValue !== null : poll.type === 'short_text' ? Boolean(current.textValue?.trim()) : current.optionIds.length > 0;
    const sync = () => {
      submit.disabled = !ready() || Boolean(poll.type === 'short_text' && mine?.textValue);
    };

    if (poll.type === 'single_choice' || poll.type === 'multi_choice') {
      const multi = poll.type === 'multi_choice';
      for (const o of poll.options) {
        const input = h('input', {type: multi ? 'checkbox' : 'radio', name: 'option', value: o.id, checked: current.optionIds.includes(o.id)});
        input.addEventListener('change', () => {
          current.optionIds = multi ? [...f.querySelectorAll<HTMLInputElement>('input:checked')].map(i => i.value) : [o.id];
          sync();
        });
        fieldset.append(h('label', {class: 'poll-choice'}, input, h('span', {}, o.label)));
      }
      fieldset.append(h('p', {class: 'muted small'}, multi ? 'Choose all that apply.' : 'Choose one.'));
    } else if (poll.type === 'rating') {
      const row = h('div', {class: 'poll-rating'});
      for (let n = 1; n <= 5; n++) {
        const input = h('input', {type: 'radio', name: 'rating', value: n, checked: current.ratingValue === n, 'aria-label': `${n} out of 5`});
        input.addEventListener('change', () => {
          current.ratingValue = n;
          sync();
        });
        row.append(h('label', {class: 'poll-star'}, input, h('span', {}, String(n))));
      }
      fieldset.append(row, h('p', {class: 'poll-scale muted small'}, h('span', {}, '1 · Lowest'), h('span', {}, 'Highest · 5')));
    } else {
      const area = h('textarea', {name: 'text', rows: 3, maxlength: TEXT_MAX, 'aria-label': 'Your answer', disabled: Boolean(mine?.textValue)});
      area.value = current.textValue ?? '';
      const count = h('span', {class: 'poll-counter'}, `${area.value.length}/${TEXT_MAX}`);
      area.addEventListener('input', () => {
        current.textValue = area.value;
        count.textContent = `${area.value.length}/${TEXT_MAX}`;
        sync();
      });
      fieldset.append(area, h('p', {class: 'poll-hint muted small'}, h('span', {}, mine?.textValue ? 'Thanks, your answer is in.' : 'One answer per device.'), count));
    }
    sync();
    f.append(live, fieldset, h('div', {class: 'poll-actions'}, submit));
    f.addEventListener('submit', event => {
      event.preventDefault();
      void send(poll, current, submit);
    });
    return f;
  }

  function draw(force = false) {
    if (!active) {
      body.replaceChildren(h('p', {class: 'notice'}, 'Poll unavailable. Check the code and try again.'));
      return;
    }
    const {poll} = active;
    const key = `${active.status}:${poll?.id ?? ''}`;
    const nodes: Node[] = [];
    if (error) nodes.push(h('p', {class: 'notice', role: 'alert', 'data-tone': 'error'}, error));
    if (!poll || active.status === 'waiting') {
      nodes.push(
        h(
          'div',
          {class: 'g-poll-waiting'},
          h('span', {class: 'poll-pulse', 'aria-hidden': 'true'}, h('i'), h('i'), h('i')),
          h('p', {class: 'poll-wait-title'}, 'Waiting for the host'),
          h('p', {class: 'muted'}, 'Keep this page open. The question appears here the moment the host opens it.')
        )
      );
    } else if (poll.status === 'open') {
      // Keep a form the voter is filling in: only rebuild it when the question changes or after a send.
      if (!force && key === formKey && body.querySelector('form')) {
        if (error) body.querySelector('.notice')?.remove();
        renderLive(poll);
        return;
      }
      if (key !== formKey) draft = null;
      formKey = key;
      nodes.push(form(poll));
      if (sent) nodes.push(h('p', {class: 'poll-done', role: 'status'}, h('span', {class: 'poll-done-icon', 'aria-hidden': 'true'}), h('span', {}, h('strong', {}, 'Your answer is in. '), 'You can change it while the poll is open.')));
      body.replaceChildren(...nodes);
      renderLive(poll);
      return;
    } else {
      formKey = key;
      nodes.push(h('h2', {class: 'poll-question'}, poll.question), h('p', {class: 'muted'}, 'This poll is closed.'));
    }
    if (poll && poll.showResultsToVoters && (poll.status === 'closed' || active.myVote) && results) nodes.push(renderResults(results, active.myVote?.optionIds ?? []));
    body.replaceChildren(...nodes);
  }

  /** Results under an open poll's form, once the voter has answered. */
  function renderLive(poll: Poll) {
    body.querySelector('.poll-results')?.remove();
    if (poll.showResultsToVoters && active?.myVote && results) body.append(renderResults(results, active.myVote.optionIds));
  }

  async function refresh() {
    if (!root.isConnected) return; // navigated away (ClientRouter): stop polling
    try {
      const res = await fetch(`${api}/active`, {headers: {accept: 'application/json'}, credentials: 'same-origin'});
      if (res.ok) {
        const next = (await res.json()) as Active;
        if (JSON.stringify(next.poll) !== JSON.stringify(active?.poll) || next.status !== active?.status) lastChange = Date.now();
        // Keep a vote just sent from this tab if the server answer is older.
        active = next;
        const poll = next.poll;
        const wantsResults = poll && poll.showResultsToVoters && (poll.status === 'closed' || next.myVote);
        if (wantsResults) {
          const r = await fetch(`${api}/results`, {headers: {accept: 'application/json'}, credentials: 'same-origin'});
          if (r.ok) results = (await r.json()) as Results;
        } else results = null;
        draw();
      }
    } catch {
      // Offline for a moment: the next tick tries again.
    }
  }

  function schedule() {
    window.clearTimeout(timer);
    const wait = pollingInterval({msSinceLastChange: Date.now() - lastChange, hidden: document.hidden, role: 'voter'});
    // Hidden: check again when the tab returns (visibilitychange below).
    if (wait === null || !root.isConnected) return;
    timer = window.setTimeout(async () => {
      await refresh();
      schedule();
    }, wait);
  }
  const onVisible = () => {
    if (!root.isConnected) return document.removeEventListener('visibilitychange', onVisible);
    if (!document.hidden) void refresh().then(schedule);
  };
  document.addEventListener('visibilitychange', onVisible);

  draw(true);
  if (active?.myVote && active.poll?.showResultsToVoters) void refresh();
  schedule();
}
