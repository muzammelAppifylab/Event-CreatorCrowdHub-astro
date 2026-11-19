/**
 * Shared input checks (browser-safe: no server imports).
 *
 * Postgres refuses a NUL character in text (`22021`), so a NUL that reaches a query is a 500;
 * refuse it as a field error instead. A cursor or id that the database casts to `uuid` must be a
 * real UUID, not just 36 characters, or the cast fails the same way.
 */

/** True when the string holds a NUL character, which Postgres text cannot store. */
export const hasNul = (value: string): boolean => value.includes('\u0000');

/** The field error for a NUL character. */
export const NUL_MESSAGE = 'Remove the invisible control character from this text.';

/** A canonical UUID (any version), as Postgres `uuid` accepts it. */
export const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isStrictUuid = (value: unknown): value is string => typeof value === 'string' && STRICT_UUID.test(value);

/**
 * THE id check for the whole site (audit L-37: one copy, not eleven). Any version, either case,
 * exactly what Postgres `uuid` accepts. A stricter check (version/variant nibbles) is kept only
 * where a value is minted by our own code and must look like a v4, e.g. the composer's
 * `idempotencyKey` in `admin-messages.ts`.
 */
export const isUuid = isStrictUuid;

/**
 * A keyset cursor `<ISO date>_<uuid>`. `undefined`/empty means "first page" (`null`);
 * anything else malformed is `'invalid'`, which the caller answers with 400.
 */
export function parseKeysetCursor(raw: string | undefined | null): {startAt: Date; id: string} | null | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw.length > 80) return 'invalid';
  const sep = raw.lastIndexOf('_');
  if (sep <= 0) return 'invalid';
  const iso = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  const startAt = new Date(iso);
  if (!isStrictUuid(id) || Number.isNaN(startAt.getTime())) return 'invalid';
  return {startAt, id: id.toLowerCase()};
}

/**
 * A dashboard list's `?before=<ISO>_<uuid>` cursor, read leniently: anything missing or
 * malformed means "the first page" (`null`), never an error. Same format as
 * `parseKeysetCursor` (which it uses); the id comes back lower-cased.
 */
export function parsePageCursor(raw: unknown): {at: Date; id: string} | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseKeysetCursor(raw);
  return parsed && parsed !== 'invalid' ? {at: parsed.startAt, id: parsed.id} : null;
}

/** The Prisma `where` part `keysetAfter` builds: a time range on `field`, then the id tie-break. */
export type KeysetWhere<F extends string> = {
  OR: Array<{[K in F]: {gte?: Date; lt?: Date}} & {id?: {gt: string} | {lt: string}}>;
};

/**
 * The rows after a `<time>_<id>` cursor, for a list ordered by `[{[field]: dir}, {id: dir}]`.
 *
 * The cursor's time is a JS Date (milliseconds, the database value truncated), but the columns are
 * `timestamptz(6)` (microseconds): a row stamped `10:00:00.123456` comes back as `.123`. Comparing the
 * column with `.123` directly repeats the cursor row (ascending) or skips its ties (descending, rows
 * from one INSERT share `now()`). So compare the column at millisecond precision, as
 * `(date_trunc('milliseconds', field), id) > (at, id)` would, written as a range Prisma can use with
 * the `(field, id)` index: the cursor's millisecond `[at, at + 1 ms)` is one tie group broken by id.
 * Values the app stores itself (whole milliseconds) give exactly the old comparison.
 * The cursors assume whole-millisecond timestamps: the app's writes and prisma/seed.sql (which stamps
 * `date_trunc('milliseconds', now())`) both are. Rows from separate raw `now()` calls under 1 ms apart
 * can still tie in one millisecond; the id tie-break orders them, not their insert time.
 */
export function keysetAfter<F extends string>(field: F, dir: 'asc' | 'desc', cursor: {at: Date; id: string}): KeysetWhere<F> {
  const from = cursor.at;
  const to = new Date(from.getTime() + 1);
  const range = (r: {gte?: Date; lt?: Date}) => ({[field]: r}) as {[K in F]: {gte?: Date; lt?: Date}};
  return dir === 'asc'
    ? {OR: [range({gte: to}), {...range({gte: from, lt: to}), id: {gt: cursor.id}}]}
    : {OR: [range({lt: from}), {...range({gte: from, lt: to}), id: {lt: cursor.id}}]};
}

/**
 * A JSON body (raw text) that carries an escaped NUL (`\u0000`), counting only unescaped
 * backslashes (`\\u0000` is a literal backslash followed by "u0000", not a NUL).
 */
export const jsonHasNul = (text: string): boolean => hasNul(text) || /(?:^|[^\\])(?:\\\\)*\\u0000/i.test(text);
