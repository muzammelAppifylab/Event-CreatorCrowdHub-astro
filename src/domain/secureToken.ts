/**
 * Random bearer tokens that are stored hashed (security audit M19): manage
 * links. Unlike signed tokens (tokens.ts) they carry no data, so a database
 * leak gives away only hashes, never working links. Server-only: node:crypto.
 */
import { createHash, randomBytes } from "node:crypto"

/** 32 random bytes, base64url (43 chars): safe in a URL path. */
export function newToken(): string {
  return randomBytes(32).toString("base64url")
}

/** sha256 hex. Tokens are high-entropy, so no salt or slow hash is needed. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}
