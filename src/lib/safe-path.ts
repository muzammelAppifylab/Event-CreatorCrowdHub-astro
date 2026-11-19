/**
 * A path on THIS site taken from the URL (a "Go back" link, a return address), or the fallback.
 *
 * Browsers read `\` as `/` in a URL, so `/\evil.example` and `//evil.example` both open another
 * site. The value must start with ONE `/` (not `//`, not `/\`), both as given and once decoded,
 * and carry no backslash or control character. Pure: no runtime imports (unit-tested).
 */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f\\]/;
const ONE_SLASH = /^\/(?![/\\])/;

export function sameSitePath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  for (const form of [value, decoded]) {
    if (!ONE_SLASH.test(form) || UNSAFE.test(form)) return fallback;
  }
  return value;
}
