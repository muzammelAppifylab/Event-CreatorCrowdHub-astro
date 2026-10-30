/**
 * Signed, URL-safe tokens (PRD §16 security) for manage links, invites,
 * check-in codes and the admin session cookie.
 *
 * Format: `base64url(json body) + "." + base64url(HMAC-SHA256(body))`.
 * The purpose lives inside the signed body, so a manage token can never be
 * replayed as a session or check-in token. Server-only: uses node:crypto.
 */
import { createHmac, timingSafeEqual } from "node:crypto"

// poll: a guest's personal vote link (low privilege, separate from manage tokens).
// consent: the one-time "yes, send me updates" link that only the inbox owner receives.
export type TokenPurpose = "manage" | "invite" | "checkin" | "session" | "poll" | "consent"

interface TokenBody<T> {
  /** purpose */
  p: TokenPurpose
  /** payload */
  d: T
  /** expiry, unix seconds; absent = never expires */
  e?: number
}

export interface SignOptions {
  expiresInSeconds?: number
  /** Injected clock for tests. */
  now?: Date
}

function hmac(body: string, secret: string) {
  return createHmac("sha256", secret).update(body).digest()
}

export function signToken<T>(purpose: TokenPurpose, payload: T, secret: string, options: SignOptions = {}): string {
  if (!secret) throw new Error("signToken: secret is required")
  const body: TokenBody<T> = { p: purpose, d: payload }
  if (options.expiresInSeconds !== undefined) {
    const nowSec = Math.floor((options.now ?? new Date()).getTime() / 1000)
    body.e = nowSec + options.expiresInSeconds
  }
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url")
  return `${encoded}.${hmac(encoded, secret).toString("base64url")}`
}

/** Returns the payload, or null for any malformed, tampered, mis-purposed or expired token. */
export function verifyToken<T = unknown>(token: string, purpose: TokenPurpose, secret: string, now: Date = new Date()): T | null {
  const verified = verifyTokenWithExpiry<T>(token, purpose, secret, now)
  return verified ? verified.data : null
}

/** Like verifyToken, plus the expiry (unix seconds, null = never) for rolling sessions. */
export function verifyTokenWithExpiry<T = unknown>(
  token: string,
  purpose: TokenPurpose,
  secret: string,
  now: Date = new Date()
): { data: T; expiresAt: number | null } | null {
  if (!secret || typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [encoded, signature] = parts as [string, string]

  const expected = hmac(encoded, secret)
  const given = Buffer.from(signature, "base64url")
  // Length check first: timingSafeEqual throws on unequal lengths.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  // The decoder is lenient ("=", "+/", spare bits): only the one canonical spelling is a valid token.
  if (given.toString("base64url") !== signature) return null

  const bodyBytes = Buffer.from(encoded, "base64url")
  if (bodyBytes.toString("base64url") !== encoded) return null
  let body: TokenBody<T>
  try {
    body = JSON.parse(bodyBytes.toString("utf8")) as TokenBody<T>
  } catch {
    return null
  }
  if (!body || typeof body !== "object" || body.p !== purpose) return null
  if (body.e !== undefined && Math.floor(now.getTime() / 1000) >= body.e) return null
  return { data: body.d, expiresAt: body.e ?? null }
}
