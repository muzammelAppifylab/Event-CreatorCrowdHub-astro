import { describe, expect, it } from "vitest"
import { signToken, verifyToken } from "./tokens"

const secret = "test-secret-please-ignore"
const payload = { rsvpId: "r_123", eventId: "e_9" }

function flipLastChar(s: string) {
  const last = s.at(-1) === "A" ? "B" : "A"
  return s.slice(0, -1) + last
}

describe("tokens", () => {
  it("round-trips a payload", () => {
    const token = signToken("manage", payload, secret)
    expect(verifyToken(token, "manage", secret)).toEqual(payload)
  })

  it("is URL-safe", () => {
    const token = signToken("invite", { email: "ünïcødé+tag@example.com" }, secret)
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  })

  it("rejects a tampered payload", () => {
    const [, sig] = signToken("manage", payload, secret).split(".")
    const forged = Buffer.from(JSON.stringify({ p: "manage", d: { rsvpId: "r_999" } })).toString("base64url")
    expect(verifyToken(`${forged}.${sig}`, "manage", secret)).toBeNull()
  })

  it("rejects a tampered signature", () => {
    const token = signToken("manage", payload, secret)
    expect(verifyToken(flipLastChar(token), "manage", secret)).toBeNull()
    expect(verifyToken(token.split(".")[0] + ".", "manage", secret)).toBeNull()
  })

  it("rejects a token signed for another purpose", () => {
    const token = signToken("manage", payload, secret)
    expect(verifyToken(token, "session", secret)).toBeNull()
  })

  it("rejects a wrong secret", () => {
    const token = signToken("checkin", payload, secret)
    expect(verifyToken(token, "checkin", "another-secret")).toBeNull()
  })

  it("honours expiry", () => {
    const now = new Date("2026-11-01T10:00:00Z")
    const token = signToken("session", payload, secret, { expiresInSeconds: 60, now })
    expect(verifyToken(token, "session", secret, new Date("2026-11-01T10:00:59Z"))).toEqual(payload)
    expect(verifyToken(token, "session", secret, new Date("2026-11-01T10:01:00Z"))).toBeNull()
  })

  it("rejects garbage", () => {
    expect(verifyToken("", "manage", secret)).toBeNull()
    expect(verifyToken("not-a-token", "manage", secret)).toBeNull()
    expect(verifyToken("a.b.c", "manage", secret)).toBeNull()
  })

  // L28: Node's base64url decoder is lenient, so several strings decode to the same bytes.
  it("accepts only the canonical encoding of the signature and body", () => {
    const token = signToken("manage", payload, secret)
    const [body, sig] = token.split(".") as [string, string]
    expect(verifyToken(`${body}.${sig}=`, "manage", secret)).toBeNull()
    expect(verifyToken(`${body}.${sig}==`, "manage", secret)).toBeNull()
    // Standard-base64 characters decode like their URL-safe twins.
    const alt = signToken("manage", { n: Array.from({ length: 40 }, (_, i) => i) }, secret)
    let found = 0
    for (let i = 0; i < 64 && found < 2; i++) {
      const t = signToken("manage", { i }, secret)
      const [b, s] = t.split(".") as [string, string]
      if (!/[-_]/.test(s)) continue
      found++
      expect(verifyToken(t, "manage", secret)).toEqual({ i })
      expect(verifyToken(`${b}.${s.replace(/-/g, "+").replace(/_/g, "/")}`, "manage", secret)).toBeNull()
    }
    expect(found).toBeGreaterThan(0)
    // 32 bytes leave 2 spare bits in the last char: "A" and "B" can decode alike.
    const [ab, as] = alt.split(".") as [string, string]
    const last = as.at(-1)!
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const twin = alphabet[alphabet.indexOf(last) ^ 1]!
    expect(verifyToken(`${ab}.${as.slice(0, -1)}${twin}`, "manage", secret)).toBeNull()
    expect(verifyToken(`${ab}=.${as}`, "manage", secret)).toBeNull()
  })
})
