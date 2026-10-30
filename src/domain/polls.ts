/**
 * Live poll rules (PRD US-22–26, §7). Pure: the results endpoint caches the
 * output of `aggregateResults` for ~1s per poll, the vote handler runs
 * `canVote` + `applyVote` before its upsert on unique (pollId, voterToken),
 * and the vote/presenter pages use `pollingInterval` for HTTP short polling.
 */
import { appConfig } from "../config/app.config"

export type PollType = "single_choice" | "multi_choice" | "rating" | "short_text"
export type PollStatus = "draft" | "open" | "closed"

export interface Poll {
  id: string
  type: PollType
  status: PollStatus
  sortOrder: number
  openedAt?: Date | null
  closedAt?: Date | null
}

export interface PollOption {
  id: string
  label: string
  sortOrder: number
}

export interface PollVote {
  voterToken: string
  optionIds: string[]
  ratingValue?: number | null
  textValue?: string | null
  createdAt: Date
  updatedAt?: Date | null
}

export const RATING_MIN = 1
export const RATING_MAX = 5
export const TEXT_ANSWERS_SHOWN = 20

/* ── Results ─────────────────────────────────────────────────────────── */

export interface OptionResult {
  id: string
  label: string
  count: number
  /** Whole percent; across options these sum to exactly 100 (or all 0). */
  percent: number
}

export interface PollResults {
  pollId: string
  type: PollType
  /** Distinct device tokens with a valid answer. */
  totalVoters: number
  options: OptionResult[]
  rating: { average: number | null; count: number; distribution: Record<number, number> } | null
  /** Newest first, at most 20. */
  textAnswers: Array<{ text: string; at: Date }>
}

/**
 * Largest-remainder (Hamilton) rounding: floor every share, then hand the
 * leftover points to the biggest remainders, so bars always add up to 100%.
 * Ties go to the earlier item, keeping the result stable between refreshes.
 */
export function largestRemainderPercents(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return counts.map(() => 0)
  const exact = counts.map((c) => (c * 100) / total)
  const floors = exact.map(Math.floor)
  let leftover = 100 - floors.reduce((a, b) => a + b, 0)
  const order = exact.map((v, i) => ({ i, rem: v - Math.floor(v) })).sort((a, b) => b.rem - a.rem || a.i - b.i)
  for (const { i } of order) {
    if (leftover <= 0) break
    floors[i] += 1
    leftover -= 1
  }
  return floors
}

const isValidRating = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= RATING_MIN && v <= RATING_MAX

/**
 * Per-option percentages are shares of all selections. For single choice
 * that is the share of voters; for multi choice it's the share of ticks, so
 * the bars still sum to 100 (the presenter view shows counts alongside).
 */
export function aggregateResults(poll: Poll, options: PollOption[], votes: PollVote[]): PollResults {
  const sortedOptions = [...options].sort((a, b) => a.sortOrder - b.sortOrder)
  const known = new Set(sortedOptions.map((o) => o.id))
  const counts = new Map(sortedOptions.map((o) => [o.id, 0]))
  const voters = new Set<string>()

  const distribution: Record<number, number> = {}
  for (let r = RATING_MIN; r <= RATING_MAX; r++) distribution[r] = 0
  let ratingSum = 0
  let ratingCount = 0
  const texts: Array<{ text: string; at: Date }> = []

  for (const vote of votes) {
    if (poll.type === "single_choice" || poll.type === "multi_choice") {
      let picked = [...new Set(vote.optionIds)].filter((id) => known.has(id))
      if (poll.type === "single_choice") picked = picked.slice(0, 1)
      if (picked.length === 0) continue
      for (const id of picked) counts.set(id, (counts.get(id) ?? 0) + 1)
      voters.add(vote.voterToken)
    } else if (poll.type === "rating") {
      if (!isValidRating(vote.ratingValue)) continue
      distribution[vote.ratingValue] += 1
      ratingSum += vote.ratingValue
      ratingCount += 1
      voters.add(vote.voterToken)
    } else {
      const text = vote.textValue?.trim()
      if (!text) continue
      texts.push({ text, at: vote.updatedAt ?? vote.createdAt })
      voters.add(vote.voterToken)
    }
  }

  const optionCounts = sortedOptions.map((o) => counts.get(o.id) ?? 0)
  const percents = largestRemainderPercents(optionCounts)
  const isChoice = poll.type === "single_choice" || poll.type === "multi_choice"

  return {
    pollId: poll.id,
    type: poll.type,
    totalVoters: voters.size,
    options: isChoice
      ? sortedOptions.map((o, i) => ({ id: o.id, label: o.label, count: optionCounts[i], percent: percents[i] }))
      : [],
    rating:
      poll.type === "rating"
        ? { average: ratingCount ? Math.round((ratingSum / ratingCount) * 10) / 10 : null, count: ratingCount, distribution }
        : null,
    textAnswers: texts.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, TEXT_ANSWERS_SHOWN),
  }
}

/* ── Voting ──────────────────────────────────────────────────────────── */

export type CanVote = { ok: true } | { ok: false; reason: "Poll closed" | "Poll not open" }

export function canVote(poll: Pick<Poll, "status">): CanVote {
  if (poll.status === "open") return { ok: true }
  if (poll.status === "closed") return { ok: false, reason: "Poll closed" }
  return { ok: false, reason: "Poll not open" }
}

export interface VoteInput {
  optionIds?: string[]
  ratingValue?: number | null
  textValue?: string | null
}

export interface VoteValues {
  optionIds: string[]
  ratingValue: number | null
  textValue: string | null
}

export type VoteError =
  | "Choose one option"
  | "Choose at least one option"
  | "Unknown option"
  | "Rating must be 1–5"
  | "Answer can't be empty"
  | "Answer is too long"
  | "You've already answered"

export type ApplyVoteResult =
  | { ok: true; action: "create" | "update"; vote: VoteValues }
  | { ok: false; error: VoteError }

export interface ApplyVoteOptions {
  /** Option ids belonging to this poll; when given, others are rejected. */
  validOptionIds?: readonly string[]
  maxTextLength?: number
}

/**
 * One vote per device token per poll (US-24). Single choice and rating
 * overwrite the earlier vote, multi choice replaces the whole selection, and
 * a short-text answer can be given once (a second one is an error, so a
 * device can't flood the presenter's text wall).
 */
export function applyVote(
  existing: Pick<PollVote, "optionIds" | "ratingValue" | "textValue"> | null,
  input: VoteInput,
  pollType: PollType,
  opts: ApplyVoteOptions = {},
): ApplyVoteResult {
  const action = existing ? "update" : "create"
  const maxText = opts.maxTextLength ?? appConfig.pollTextMaxLength
  const valid = opts.validOptionIds ? new Set(opts.validOptionIds) : null
  const ids = [...new Set(input.optionIds ?? [])]
  const unknown = valid !== null && ids.some((id) => !valid.has(id))

  switch (pollType) {
    case "single_choice":
      if (ids.length !== 1) return { ok: false, error: "Choose one option" }
      if (unknown) return { ok: false, error: "Unknown option" }
      return { ok: true, action, vote: { optionIds: ids, ratingValue: null, textValue: null } }
    case "multi_choice":
      if (ids.length === 0) return { ok: false, error: "Choose at least one option" }
      if (unknown) return { ok: false, error: "Unknown option" }
      return { ok: true, action, vote: { optionIds: ids, ratingValue: null, textValue: null } }
    case "rating":
      if (!isValidRating(input.ratingValue)) return { ok: false, error: "Rating must be 1–5" }
      return { ok: true, action, vote: { optionIds: [], ratingValue: input.ratingValue, textValue: null } }
    case "short_text": {
      if (existing?.textValue?.trim()) return { ok: false, error: "You've already answered" }
      const text = input.textValue?.trim() ?? ""
      if (!text) return { ok: false, error: "Answer can't be empty" }
      if ([...text].length > maxText) return { ok: false, error: "Answer is too long" }
      return { ok: true, action, vote: { optionIds: [], ratingValue: null, textValue: text } }
    }
  }
}

/* ── Presenter ───────────────────────────────────────────────────────── */

/**
 * Presenter's → key (US-25): the next draft poll after the current one in
 * builder order. "Current" is the open poll, else the one opened most
 * recently. If nothing is left after it, wrap to the earliest unused draft so
 * a skipped poll is still reachable. Null when there is no draft left.
 * Closed polls are never reopened by →; the presenter can still press O.
 */
export function nextPollToOpen<T extends Poll>(polls: readonly T[]): T | null {
  const ordered = [...polls].sort((a, b) => a.sortOrder - b.sortOrder)
  const drafts = ordered.filter((p) => p.status === "draft")
  if (drafts.length === 0) return null

  const current =
    ordered.find((p) => p.status === "open") ??
    ordered
      .filter((p) => p.openedAt)
      .sort((a, b) => (b.openedAt?.getTime() ?? 0) - (a.openedAt?.getTime() ?? 0))[0]
  if (!current) return drafts[0]
  return drafts.find((p) => p.sortOrder > current.sortOrder) ?? drafts[0]
}

/* ── Short polling (PRD §7) ──────────────────────────────────────────── */

export interface PollingIntervalInput {
  msSinceLastChange: number
  hidden: boolean
  /** Vote page polls every 3s, presenter view every 2s. */
  role?: "voter" | "presenter"
}

/** Ms until the next fetch, or null to pause while the tab is hidden. */
export function pollingInterval(input: PollingIntervalInput): number | null {
  if (input.hidden) return null
  if (input.msSinceLastChange >= appConfig.pollIdleAfterMs) return appConfig.pollIdleBackoffMs
  return input.role === "presenter" ? appConfig.pollPresenterIntervalMs : appConfig.pollVoteIntervalMs
}
