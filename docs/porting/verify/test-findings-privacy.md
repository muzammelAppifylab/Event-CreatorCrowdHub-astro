# Test findings: privacy, emails, analytics, lib

1. FIXED: `src/lib/seo.ts` (`eventJsonLd`) no longer falls back to the private `joinUrl`; test un-skipped in `tests/ported-lib-seo.test.ts`.

Not ported (no new code): `src/lib/notify.ts` (sonner toast helper), source `security/*` signing/csrf tests (replaced by template platform code; tokens already covered by `src/domain/tokens.test.ts`).
