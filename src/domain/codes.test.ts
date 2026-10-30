import { describe, expect, it } from "vitest"
import { CODE_ALPHABET, pollJoinCode, randomCode, ticketCode, withUniqueRetry } from "./codes"

describe("codes", () => {
  it("excludes ambiguous characters", () => {
    for (const ch of "0O1IL") expect(CODE_ALPHABET).not.toContain(ch)
  })

  it("makes 6-char poll codes and 8-char ticket codes from the alphabet", () => {
    const valid = new RegExp(`^[${CODE_ALPHABET}]+$`)
    for (let i = 0; i < 200; i++) {
      const poll = pollJoinCode()
      const ticket = ticketCode()
      expect(poll).toHaveLength(6)
      expect(ticket).toHaveLength(8)
      expect(poll).toMatch(valid)
      expect(ticket).toMatch(valid)
    }
  })

  it("is random enough not to repeat in a small sample", () => {
    const seen = new Set(Array.from({ length: 500 }, () => ticketCode()))
    expect(seen.size).toBe(500)
  })

  it("supports a custom length", () => {
    expect(randomCode(12)).toHaveLength(12)
  })
})

describe("withUniqueRetry", () => {
  it("retries until a free value appears", async () => {
    const values = ["AAA", "BBB", "CCC"]
    let i = 0
    const result = await withUniqueRetry(() => values[i++]!, (v) => v !== "CCC")
    expect(result).toBe("CCC")
    expect(i).toBe(3)
  })

  it("accepts an async check", async () => {
    expect(await withUniqueRetry(() => "X", async () => false)).toBe("X")
  })

  it("gives up after maxAttempts", async () => {
    let calls = 0
    await expect(withUniqueRetry(() => ++calls, () => true, 3)).rejects.toThrow(/3 attempts/)
    expect(calls).toBe(3)
  })
})
