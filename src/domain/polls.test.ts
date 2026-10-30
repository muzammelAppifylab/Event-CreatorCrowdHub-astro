import { describe, expect, it } from "vitest"
import { appConfig } from "../config/app.config"
import {
  aggregateResults,
  applyVote,
  canVote,
  largestRemainderPercents,
  nextPollToOpen,
  pollingInterval,
  type Poll,
  type PollOption,
  type PollVote,
} from "./polls"

const t0 = new Date("2026-11-12T18:00:00Z")
const sec = (n: number) => new Date(t0.getTime() + n * 1000)

const poll = (type: Poll["type"], extra: Partial<Poll> = {}): Poll => ({ id: "p1", type, status: "open", sortOrder: 0, ...extra })
const options: PollOption[] = [
  { id: "c", label: "C", sortOrder: 2 },
  { id: "a", label: "A", sortOrder: 0 },
  { id: "b", label: "B", sortOrder: 1 },
]
let n = 0
const vote = (extra: Partial<PollVote>): PollVote => ({ voterToken: `v${n++}`, optionIds: [], createdAt: t0, ...extra })
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

describe("largestRemainderPercents", () => {
  it("sums to exactly 100 for thirds", () => {
    expect(largestRemainderPercents([1, 1, 1])).toEqual([34, 33, 33])
  })

  it("gives leftover points to the largest remainders", () => {
    expect(largestRemainderPercents([2, 1, 4])).toEqual([29, 14, 57])
    expect(sum(largestRemainderPercents([7, 13, 29, 51, 3]))).toBe(100)
  })

  it("returns zeros with no votes and handles empty input", () => {
    expect(largestRemainderPercents([0, 0])).toEqual([0, 0])
    expect(largestRemainderPercents([])).toEqual([])
  })

  it("is exact when there is no remainder", () => {
    expect(largestRemainderPercents([1, 0, 3])).toEqual([25, 0, 75])
  })
})

describe("aggregateResults (US-25)", () => {
  it("counts single-choice votes per option in builder order", () => {
    const votes = [vote({ optionIds: ["a"] }), vote({ optionIds: ["a"] }), vote({ optionIds: ["b"] })]
    const r = aggregateResults(poll("single_choice"), options, votes)
    expect(r.totalVoters).toBe(3)
    expect(r.options).toEqual([
      { id: "a", label: "A", count: 2, percent: 67 },
      { id: "b", label: "B", count: 1, percent: 33 },
      { id: "c", label: "C", count: 0, percent: 0 },
    ])
    expect(r.rating).toBeNull()
  })

  it("keeps percentages at 100 for a three-way tie", () => {
    const votes = ["a", "b", "c"].map((id) => vote({ optionIds: [id] }))
    const r = aggregateResults(poll("single_choice"), options, votes)
    expect(r.options.map((o) => o.percent)).toEqual([34, 33, 33])
  })

  it("uses the share of ticks for multi choice, counting each voter once", () => {
    const votes = [vote({ optionIds: ["a", "b"] }), vote({ optionIds: ["a", "a"] })]
    const r = aggregateResults(poll("multi_choice"), options, votes)
    expect(r.totalVoters).toBe(2)
    expect(r.options.map((o) => o.count)).toEqual([2, 1, 0])
    expect(sum(r.options.map((o) => o.percent))).toBe(100)
  })

  it("ignores unknown options and empty selections", () => {
    const votes = [vote({ optionIds: ["zzz"] }), vote({ optionIds: [] }), vote({ optionIds: ["c"] })]
    const r = aggregateResults(poll("single_choice"), options, votes)
    expect(r.totalVoters).toBe(1)
    expect(r.options.find((o) => o.id === "c")?.percent).toBe(100)
  })

  it("shows zeros, not NaN, with no votes", () => {
    const r = aggregateResults(poll("single_choice"), options, [])
    expect(r.totalVoters).toBe(0)
    expect(r.options.every((o) => o.count === 0 && o.percent === 0)).toBe(true)
  })

  it("averages ratings to one decimal with a 1–5 distribution", () => {
    const votes = [4, 5, 5, 3, 9, 0].map((ratingValue) => vote({ ratingValue }))
    const r = aggregateResults(poll("rating"), [], votes)
    expect(r.rating).toEqual({ average: 4.3, count: 4, distribution: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2 } })
    expect(r.totalVoters).toBe(4)
    expect(r.options).toEqual([])
  })

  it("returns a null average with no ratings", () => {
    expect(aggregateResults(poll("rating"), [], []).rating?.average).toBeNull()
  })

  it("lists the latest 20 text answers newest first", () => {
    const votes = Array.from({ length: 25 }, (_, i) => vote({ textValue: ` answer ${i} `, createdAt: sec(i) }))
    votes.push(vote({ textValue: "   " }))
    const r = aggregateResults(poll("short_text"), [], votes)
    expect(r.totalVoters).toBe(25)
    expect(r.textAnswers).toHaveLength(20)
    expect(r.textAnswers[0]).toEqual({ text: "answer 24", at: sec(24) })
    expect(r.textAnswers[19].text).toBe("answer 5")
  })
})

describe("canVote (US-23)", () => {
  it("allows open polls and rejects closed ones with 'Poll closed'", () => {
    expect(canVote({ status: "open" })).toEqual({ ok: true })
    expect(canVote({ status: "closed" })).toEqual({ ok: false, reason: "Poll closed" })
    expect(canVote({ status: "draft" })).toEqual({ ok: false, reason: "Poll not open" })
  })
})

describe("applyVote (US-24)", () => {
  const ids = ["a", "b", "c"]

  it("creates a single-choice vote, then overwrites it", () => {
    expect(applyVote(null, { optionIds: ["a"] }, "single_choice", { validOptionIds: ids })).toEqual({
      ok: true,
      action: "create",
      vote: { optionIds: ["a"], ratingValue: null, textValue: null },
    })
    expect(applyVote({ optionIds: ["a"] }, { optionIds: ["b"] }, "single_choice")).toMatchObject({
      ok: true,
      action: "update",
      vote: { optionIds: ["b"] },
    })
  })

  it("requires exactly one option for single choice", () => {
    expect(applyVote(null, { optionIds: [] }, "single_choice")).toEqual({ ok: false, error: "Choose one option" })
    expect(applyVote(null, { optionIds: ["a", "b"] }, "single_choice")).toEqual({ ok: false, error: "Choose one option" })
    expect(applyVote(null, { optionIds: ["a", "a"] }, "single_choice").ok).toBe(true)
  })

  it("replaces the whole multi-choice set and dedupes", () => {
    const r = applyVote({ optionIds: ["a", "b"] }, { optionIds: ["c", "c"] }, "multi_choice", { validOptionIds: ids })
    expect(r).toEqual({ ok: true, action: "update", vote: { optionIds: ["c"], ratingValue: null, textValue: null } })
    expect(applyVote(null, {}, "multi_choice")).toEqual({ ok: false, error: "Choose at least one option" })
  })

  it("rejects options from another poll", () => {
    expect(applyVote(null, { optionIds: ["x"] }, "single_choice", { validOptionIds: ids })).toEqual({ ok: false, error: "Unknown option" })
    expect(applyVote(null, { optionIds: ["a", "x"] }, "multi_choice", { validOptionIds: ids })).toEqual({ ok: false, error: "Unknown option" })
  })

  it("overwrites ratings and enforces integers 1–5", () => {
    expect(applyVote({ optionIds: [], ratingValue: 2 }, { ratingValue: 5 }, "rating")).toMatchObject({ ok: true, action: "update", vote: { ratingValue: 5 } })
    for (const bad of [0, 6, 3.5, null, undefined]) {
      expect(applyVote(null, { ratingValue: bad }, "rating")).toEqual({ ok: false, error: "Rating must be 1–5" })
    }
  })

  it("allows one text answer per device, trimmed and capped at 140 characters", () => {
    expect(applyVote(null, { textValue: "  Great talk  " }, "short_text")).toMatchObject({ ok: true, vote: { textValue: "Great talk" } })
    expect(applyVote({ optionIds: [], textValue: "first" }, { textValue: "second" }, "short_text")).toEqual({
      ok: false,
      error: "You've already answered",
    })
    expect(applyVote(null, { textValue: "   " }, "short_text")).toEqual({ ok: false, error: "Answer can't be empty" })
    expect(appConfig.pollTextMaxLength).toBe(140)
    expect(applyVote(null, { textValue: "x".repeat(140) }, "short_text").ok).toBe(true)
    expect(applyVote(null, { textValue: "x".repeat(141) }, "short_text")).toEqual({ ok: false, error: "Answer is too long" })
    expect(applyVote(null, { textValue: "🎉".repeat(140) }, "short_text").ok).toBe(true)
  })
})

describe("nextPollToOpen (presenter →)", () => {
  const p = (id: string, sortOrder: number, status: Poll["status"], openedAt?: Date): Poll => ({
    id,
    type: "single_choice",
    sortOrder,
    status,
    openedAt: openedAt ?? null,
  })

  it("opens the first draft when nothing has run yet", () => {
    expect(nextPollToOpen([p("b", 1, "draft"), p("a", 0, "draft")])?.id).toBe("a")
  })

  it("moves to the next draft after the open poll", () => {
    expect(nextPollToOpen([p("a", 0, "closed", sec(1)), p("b", 1, "open", sec(2)), p("c", 2, "draft")])?.id).toBe("c")
  })

  it("continues from the most recently opened poll when none is open", () => {
    const polls = [p("a", 0, "draft"), p("b", 1, "closed", sec(5)), p("c", 2, "closed", sec(1)), p("d", 3, "draft")]
    expect(nextPollToOpen(polls)?.id).toBe("d")
  })

  it("wraps to an earlier skipped draft at the end", () => {
    expect(nextPollToOpen([p("a", 0, "draft"), p("b", 1, "open", sec(1))])?.id).toBe("a")
  })

  it("returns null when every poll has run or there are none", () => {
    expect(nextPollToOpen([p("a", 0, "closed", sec(1)), p("b", 1, "open", sec(2))])).toBeNull()
    expect(nextPollToOpen([])).toBeNull()
  })
})

describe("pollingInterval (PRD §7)", () => {
  it("polls every 3s on the vote page and 2s on the presenter view", () => {
    expect(pollingInterval({ msSinceLastChange: 0, hidden: false })).toBe(3000)
    expect(pollingInterval({ msSinceLastChange: 0, hidden: false, role: "presenter" })).toBe(2000)
  })

  it("backs off to 10s after 5 minutes without change", () => {
    expect(pollingInterval({ msSinceLastChange: 5 * 60 * 1000 - 1, hidden: false })).toBe(3000)
    expect(pollingInterval({ msSinceLastChange: 5 * 60 * 1000, hidden: false })).toBe(10000)
    expect(pollingInterval({ msSinceLastChange: 60 * 60 * 1000, hidden: false, role: "presenter" })).toBe(10000)
  })

  it("pauses while the tab is hidden", () => {
    expect(pollingInterval({ msSinceLastChange: 0, hidden: true })).toBeNull()
  })
})
