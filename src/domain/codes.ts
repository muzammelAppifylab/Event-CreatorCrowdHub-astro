/**
 * Short human-typeable codes: poll join codes (`/p/:code`) and ticket codes
 * (door check-in). The alphabet drops 0/O and 1/I/L so codes read aloud or
 * typed off a projector don't get confused.
 */

export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

export const POLL_JOIN_CODE_LENGTH = 6
export const TICKET_CODE_LENGTH = 8

/** Uniform random code; rejection sampling avoids modulo bias. */
export function randomCode(length: number, alphabet: string = CODE_ALPHABET): string {
  const limit = 256 - (256 % alphabet.length)
  let out = ""
  while (out.length < length) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length * 2))
    for (const b of bytes) {
      if (b >= limit) continue
      out += alphabet[b % alphabet.length]
      if (out.length === length) break
    }
  }
  return out
}

export function pollJoinCode() {
  return randomCode(POLL_JOIN_CODE_LENGTH)
}

export function ticketCode() {
  return randomCode(TICKET_CODE_LENGTH)
}

/**
 * Generates until `isTaken` says the value is free. The DB unique index is
 * still the final guard; this just keeps collisions from surfacing as errors.
 */
export async function withUniqueRetry<T>(
  gen: () => T,
  isTaken: (value: T) => boolean | Promise<boolean>,
  maxAttempts = 5
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const value = gen()
    if (!(await isTaken(value))) return value
  }
  throw new Error(`withUniqueRetry: no free value after ${maxAttempts} attempts`)
}
