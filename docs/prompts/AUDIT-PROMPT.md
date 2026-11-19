# Expert end-to-end audit prompt (universal)

Copy everything below the line into a fresh session at the root of the project.
Optional: fill the three settings at the top; leave them blank and the agent decides.

---

Audit the app in this project folder end to end, the way a team would: a staff engineer with
10+ years of experience, a security engineer, an SRE/DevOps engineer, a DBA and a product QA
lead. You are an independent reviewer, not the author. Assume nothing works until you have
proved it. Your job is to find what will hurt real users, lose data or money, leak data, or
wake someone up at 3 a.m., and to prove it.

Settings (blank = your judgement):
- Depth: quick (2-3 h equivalent) | standard | deep. Default: deep.
- Focus areas to weight more: …
- Known context (launch date, expected traffic, who uses it, what it sells): …

## Ground rules

- **Read-only.** No code changes, commits, pushes, deploys, migrations on shared databases, or
  outgoing emails/SMS/payments to real people. Never touch production or live data. Use a local
  or test database you can reset; record how you seeded it and clean up anything you started
  (servers, processes, temp files).
- **The project's own rules come first.** Read every agent/contributor rules file (`AGENTS.md`,
  `CLAUDE.md`, `CONTRIBUTING.md`, `docs/`, platform/hosting docs in the repo) before anything else.
  They define "correct" for this project, its platform limits (quotas, rate limits, memory/CPU,
  job limits) and its machine limits. A breach of the project's own rules is a finding.
  Then the stack's official conventions; then general best practice.
- **Secrets and personal data:** never print a value. Report the location only (file:line,
  commit hash, log line).
- **Evidence or it didn't happen.** Every finding has: location (file:line, or method + URL),
  how you verified it (ran it / reproduced live / test you wrote / code trace), a concrete failure
  scenario with inputs and the observed result, and its impact on users, money, data or the
  business. Label each **Confirmed** (reproduced), **Likely** (code trace, not reproduced, say why)
  or **Suspected**. No generic advice, no "consider adding…" without a concrete defect behind it.
- **If you can't run a check** (tool, credential, environment missing), say exactly what is
  missing and what it would take. Never guess a result.
- Save proof scripts, request logs and measurements under `docs/audit/evidence/` (no secrets) so
  every Critical/High can be re-run by someone else.

## Severity rubric (use it exactly)

- **Critical**: exploitable now or certain to happen; data breach, account takeover, money lost
  or charged wrongly, data loss/corruption, or the core flow is down for everyone.
- **High**: likely under normal use or with low attacker effort; a core flow broken for a real
  group of users, a privacy/legal promise broken, silent loss of messages/jobs, or the release
  gate (build/tests/typecheck) red.
- **Medium**: real defect with a workaround, limited blast radius, or needs unusual conditions.
- **Low**: hardening, polish, maintainability, minor a11y.
Rate on likelihood × impact. If a verifier downgrades or upgrades, show "V↓/V↑ from X".

## Step 0: Understand the product before the code

Read the PRD / README / docs / marketing and legal pages (privacy, terms) and write, in 10-20
lines: who uses it, what they do, what is sold or promised, what data it holds, and the top 5
things that must never go wrong (e.g. "a guest is double-charged", "a private event is visible
to strangers"). Write a short **threat model**: assets, actors (anonymous visitor, signed-in
user, other tenant/owner, admin, staff role, attacker with a leaked link, a compromised third
party), entry points and trust boundaries. Every later step is measured against these.

## Step 1: Map the system

Produce, in the report appendix:
- Routes/pages (with render mode: static/SSR/SPA, auth required, cache headers).
- **Every** API endpoint: method, path, auth, required permission/role, ownership rule, input
  schema, output shape, side effects (DB writes, emails, jobs, payments, webhooks).
- Data models: tables, relations, unique constraints, indexes, soft/hard delete, PII columns.
- **State machines** of the core entities (e.g. draft → published → cancelled; pending → paid →
  refunded): every transition, who can trigger it, and what must happen on it.
- Background jobs, schedules, queues, outboxes, webhooks in and out, third-party services, the
  hosting platform and its limits, environment variables (names only), feature flags.
- Money and limited-resource flows (payments, seats, stock, quotas, coupons, credits).
Use this map as the checklist for every later step; at the end, every endpoint and every state
transition must have been looked at by at least one area.

## Step 2: Baseline (run it, don't read about it)

Clean install with the lockfile, then: typecheck, lint, unit + integration tests (with
coverage), production build, dependency audit (`npm audit` / stack equivalent), outdated and
abandoned packages, install scripts (postinstall) and licenses, secret scan of the working tree
**and full git history**, and a check that the repo's own "check"/CI script matches what CI and
release really run. Record each command, exit code, counts, warnings and duration. Note which
critical paths (auth, payments, permissions, core flow, data deletion) have **no** test.

## Step 3: Audit areas in parallel

Launch one subagent per area. Give each: the product summary, the threat model, the system map,
the severity rubric, the evidence rules above, and the output format (one table row per finding
with every column below). Tell each to **actually exercise the app** on the local/test setup,
not only read code.

1. **Requirements & business logic.** Every PRD feature: complete / partial / missing / broken,
   proven by running the main user flows as each role. Walk every state-machine transition,
   including the illegal ones (unpublish then delete, cancel after pay, re-RSVP after decline,
   refund twice). Check that every promise in UI copy, emails, docs and legal pages is true in
   code ("we delete your data after 2 years", "unsubscribe always works"). Find shipped features
   that can't work (blocked by headers, config, permissions, a role that can't be assigned).
2. **API.** For each endpoint send valid, invalid, malformed (bad JSON, wrong content type, NUL
   bytes, unicode, huge strings, negative/huge numbers, bad cursors/ids), oversized and
   unauthorized requests, and requests as **another user/tenant** (IDOR). Check status codes
   (no 500 for client errors), consistent error format, validation before side effects,
   pagination limits, idempotency of anything that charges, books or sends, rate limits,
   CORS, response size and leaked fields (emails, hashes, internal ids, tokens).
3. **Security** (OWASP Top 10 + ASVS basics). Authn and sessions (cookie flags, rotation,
   logout, reset, 2FA, account enumeration, takeover via sign-up/email change), authorization on
   every route and every query's `where`, privilege escalation between roles, injection (SQL,
   command, template, header/email header), XSS and unsafe HTML, CSRF, SSRF (including DNS to
   private IPs), file uploads (type, size, path, serving), open redirects (`//`, `/\`, encoded),
   secrets in code/history/client bundles/logs, security headers and CSP, tokens in URLs and
   logs, webhook signature checks, supply-chain risk. Try each attack, don't just grep for it.
4. **Data & concurrency.** Schema, constraints that enforce business rules (unique, FK, check),
   indexes per real query shape (run `EXPLAIN` on the hot ones), N+1, unbounded queries,
   migrations (forward-only, safe to re-run, safe on a big table, rollback path), transactions
   and locks. **Race tests**: fire 20-50 concurrent requests at every limited resource (last
   seat, coupon, vote, sign-up with the same email, double-click pay) and report what got
   oversold or duplicated. **Scale tests**: seed realistic volumes (e.g. 1,000+ rows per list,
   10k+ for exports) and time the heavy paths. Deletion, retention, erasure, backup and restore
   (does a restore resurrect erased people?).
5. **Ops & reliability (SRE).** Config and env separation (dev/preview/prod), build
   reproducibility, deploy and rollback steps, health checks that check real dependencies,
   logging (structured, no PII/tokens), monitoring/alerting/error tracking, timeouts and retries
   on every outbound call (with caps and backoff), idempotency keys on retries, behaviour when
   each dependency is down (DB, mail, payments, jobs), work done inside a request that should be
   a job, **platform quota and cost risks** (job/email rate limits, per-request CPU/memory,
   billed queries, fan-out loops), cron overlap, dead-letter handling.
6. **Performance (measured).** Build output and per-route JS/CSS size, what ships to every
   page, Lighthouse (or equivalent) on the key public pages mobile + desktop, server timing of
   slow routes and queries, caching headers and server cache use, images, fonts, render
   blocking, polling intervals and their DB cost under N viewers.
7. **Frontend & accessibility.** Every screen: loading, empty, error, success states; forms
   (validation, server errors on fields, double-submit, pending state); keyboard-only use, focus
   order and traps, labels, contrast (light and dark), screen-reader names, headings; layouts at
   375, 768, 1024 and 1440 px; console errors and failed network calls; consistency with the
   design system; time zones and date edge cases (overnight, DST, locale).
8. **Code quality & maintainability.** Structure vs the project's architecture rules,
   duplication that has already drifted, dead code and leftovers, type holes (`any`, casts,
   `as never`), swallowed errors, fire-and-forget promises, test quality (do tests assert
   behaviour or just run code? flaky tests?), and what will make the next change risky.
9. **Privacy, legal & communications.** Personal data inventory (what, where, why, how long),
   consent and unsubscribe (in every marketing email + `List-Unsubscribe`), export and erasure
   actually reaching every table (orders, invites, logs, third parties), retention jobs,
   processors named in the policy, trackers and cookies, dependency licenses, email
   deliverability basics (sender, SPF/DKIM/DMARC notes if visible).

## Step 4: Independent verification

For every Critical and High (and any Medium you're unsure of), start a fresh verifier subagent
given **only the code location and the claim**, not your reasoning, and ask it to prove or
disprove it. Keep the finding only if it reproduces; otherwise drop it or mark it
"Unconfirmed". Record the verdict and any severity change. Then merge duplicates and group
findings that share a **root cause** into a "Systemic issues" section (e.g. "no outbox: every
fan-out send can be dropped").

## Output

Write `docs/AUDIT-REPORT.md` with:

1. **Verdict**: ready to ship / ship with fixes / not ready, with the top 3-5 reasons in plain
   words a non-engineer owner understands.
2. **Top risks in one paragraph each**: the 3-5 things most likely to cause an incident.
3. **Baseline results**: each check, command, status, counts, notable warnings.
4. **Findings table** sorted by severity: id, area, title, location, evidence + verification
   label, failure scenario, impact, recommended fix (specific), regression test to add,
   effort (S < 2 h, M < 1 day, L > 1 day).
5. **Systemic issues** (root causes behind several findings).
6. **PRD coverage table**: feature, status, evidence.
7. **Coverage of the map**: endpoints and state transitions reviewed vs total; anything skipped.
8. **What was not checked and why**, and what it would take to check it.
9. **What is good** (short): solid parts that must not be rewritten.
10. **Fix plan**: ordered waves; inside a wave, group fixes that touch different files so they can
    run in parallel; mark dependencies; put "stop the bleeding" fixes first. Leave an empty
    "Fix status" table (id, status, note) to fill in later.

Also write `docs/audit/findings.json` (one object per finding with the same fields) so
fixes can be tracked.

In chat, give me only: the verdict, the counts by severity, the top 5 findings in one line each,
and the fix plan waves. **Don't fix anything until I approve the plan.**

---

## Follow-up prompt: fixing (after you approve)

> Fix the approved waves from `docs/AUDIT-REPORT.md` in order. For each finding: write the
> regression test first and watch it fail, fix it following the project's rules, watch it pass.
> Run independent fixes in parallel subagents only when they touch different files. After each
> wave: typecheck, lint, full tests, build, and re-run that wave's evidence scripts. Then have a
> fresh subagent re-verify each fixed Critical/High against the original failure scenario.
> Update the "Fix status" table and `findings.json`. Don't commit or push until I say so.

## Follow-up prompt: re-audit (before release)

> Re-audit this app using `docs/AUDIT-REPORT.md` as the previous baseline. Re-run every
> evidence script, confirm each "Fixed" finding is really fixed, look for regressions the fixes
> introduced, and audit everything changed since the last audit (`git diff <audit commit>`)
> with the full method above. Report only new findings and status changes.
