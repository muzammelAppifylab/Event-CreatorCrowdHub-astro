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
// unsubscribe: a signed, non-expiring link that only switches marketing off (src/server/privacy.ts).
export type TokenPurpose = "manage" | "invite" | "checkin" | "session" | "poll" | "consent" | "unsubscribe"

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

/**
 * Stateless poll guest identity for links in EMAILS (the manage token is stored hashed, so an
 * email cannot carry it). `pg_` + a signed "poll" token over {rsvpId, eventId}. The prefix tells
 * it apart from a raw manage token (`newToken()` is base64url, never contains a ".").
 */
export const POLL_GUEST_PREFIX = "pg_"
export const POLL_GUEST_TTL_SECONDS = 180 * 24 * 60 * 60

export function pollGuestToken(rsvpId: string, eventId: string, secret: string, now: Date = new Date()): string {
  return POLL_GUEST_PREFIX + signToken("poll", { r: rsvpId, e: eventId }, secret, { expiresInSeconds: POLL_GUEST_TTL_SECONDS, now })
}

/** `{rsvpId, eventId}` for a valid, unexpired signed poll guest token; null otherwise (never throws). */
export function verifyPollGuestToken(value: string, secret: string, now: Date = new Date()): { rsvpId: string; eventId: string } | null {
  if (typeof value !== "string" || !value.startsWith(POLL_GUEST_PREFIX)) return null
  const d = verifyToken<{ r?: unknown; e?: unknown }>(value.slice(POLL_GUEST_PREFIX.length), "poll", secret, now)
  return d && typeof d.r === "string" && typeof d.e === "string" ? { rsvpId: d.r, eventId: d.e } : null
}

/** `<base>/p/<code>/` plus `?g=<signed>` when a secret is available. Keeps the trailing slash. */
export function pollLinkFor(base: string, code: string, rsvpId: string, eventId: string, secret: string | null | undefined, now?: Date): string {
  const url = `${base.replace(/\/+$/, "")}/p/${encodeURIComponent(code)}/`
  return secret ? `${url}?g=${encodeURIComponent(pollGuestToken(rsvpId, eventId, secret, now))}` : url
}
