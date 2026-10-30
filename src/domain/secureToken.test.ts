import { describe, expect, it } from "vitest"
import { hashToken, newToken } from "./secureToken"

describe("secureToken", () => {
  it("makes 32-byte base64url tokens that never repeat", () => {
    const a = newToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(a, "base64url")).toHaveLength(32)
    expect(new Set(Array.from({ length: 50 }, newToken)).size).toBe(50)
  })

  it("hashes with sha256 hex, deterministically", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    const t = newToken()
    expect(hashToken(t)).toBe(hashToken(t))
    expect(hashToken(t)).not.toBe(t)
  })
})
