# CreatorCrowdHub

The event platform for creators: branded event pages, email invites, RSVPs (questions, plus-ones,
approval, waitlist), reminders with calendar files and live polls behind one link. Guests never
need an account; every guest lands in the creator's own contacts list.

Built on the Astro app template: Astro 7 + Hono (`/site-api`) + Prisma 7 (Postgres) on one
Cloudflare Worker, with a React dashboard at `/dashboard`.

This file is the app's own guide, for its owner and their AI. The rules every change follows are in
`AGENTS.md` and `docs/agent/` (the template's, never edited here); what is particular to this app is
in [Rules for this app](#rules-for-this-app).

## Contents

- [Before you publish this update](#before-you-publish-this-update)
- [Payments](#payments)
- [Where things are](#where-things-are)
- [Quick start](#quick-start)
- [Setting up, step by step](#setting-up-step-by-step)
  - [Get the code](#get-the-code) · [Install](#install) · [Settings (.env)](#settings-env) ·
    [The database](#the-database) · [Run it](#run-it)
- [Local development mode](#local-development-mode)
- [Create your admin account](#create-your-admin-account)
- [Scripts](#scripts)
- [Rules for this app](#rules-for-this-app)
- [Building on it](#building-on-it)
- [Tests](#tests)
- [Staying up to date](#staying-up-to-date)
- [Troubleshooting](#troubleshooting)
- [On the platform](#on-the-platform)

## Before you publish this update

What to know when you publish it:

- **New database changes run on Publish**, in order (folders in `prisma/migrations/`): the
  `20261113…` and `20261116090000_query_indexes` changes, then `20261119100000_rate_attempts` (rate limits
  kept in the database) and `20261119120000_payment_providers` (the owner's payment provider choice).
  Nothing to do by hand; if one fails, the previous version keeps serving.
- **Uptime monitor**: point it at `/site-api/health/deep`. It checks the database too (200 when fine,
  503 when not); `/site-api/health` answers even when the database is down.
- **Payments**: tickets keep using the built-in checkout until the owner picks Ezypay, Stripe or PayPal under
  Dashboard → Settings → Payments (see [Payments](#payments)).
- **Read-only access**: the new `site:event:read` permission lets a role open the events screens without
  changing anything. Admins get it by default.
- **Live polls**: people who already voted count as a new device once after the update. Nothing is lost.
- **After one deploy**, remove the `rsvp-emails` line from `lists` in `background.json` and publish
  again. It is kept only to move old waiting jobs into the new guest email outbox.
- **The embed snippet is gone.** It could not work under the site's security headers and cookies.
  Share the event link instead.
- **CSV exports** (guests, contacts, poll votes) stop at 20,000 rows. A cut file is marked with the
  `X-Export-Truncated` header.
- **Guests of an unpublished event**: their manage link (`/r/<token>/`) shows a friendly "no longer
  available" page. Their "Your data" and "Unsubscribe" links keep working.

## Payments

Paid tickets use the platform's **built-in checkout** until the owner picks their own provider in
**Dashboard → Settings → Payments**: **Ezypay**, **their own Stripe** or **their own PayPal** account.
The screen shows, for each provider, which secrets are set (never their values), the mode (Test or
Live), what is wrong, the webhook URL to paste and the events to send. Only a provider whose keys are
all set can be chosen; "Built-in payments" goes back to the platform's checkout. Admins can change it
(`site:payments:manage`); the read-only demo role only sees it (`site:payments:read`).

Add the secrets on the app's **Secrets** page, each one twice: the sandbox value under **Staging** and
the live value under **Production**. The mode follows the keys; a live key in the Preview is refused.

| Provider | Secrets | Webhook URL | Events |
| --- | --- | --- | --- |
| Ezypay | `EZYPAY_SECRET_KEY`, `EZYPAY_PUBLISHABLE_KEY`, `EZYPAY_WEBHOOK_SECRET` | `<site address>/site-api/payment-webhooks/ezypay` | `payment.succeeded`, `payment.failed`, `payment.refunded` |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `<site address>/site-api/payment-webhooks/stripe` | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded` |
| PayPal | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, and `PAYPAL_MODE=live` under Production only | `<site address>/site-api/payment-webhooks/paypal` | `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED` |

Sandbox webhooks point at the staging site, live ones at the live site (or its custom domain). The
Preview gets no webhooks: the thanks page confirms the payment with the provider there. Whichever way
the money arrives, the ticket is confirmed by the same code as the built-in checkout (seat held while
paying, `refund_due` when it can't be honoured, the confirmation email). Refund a provider payment in
that provider's dashboard: the refund webhook closes the order and frees the seat.

Code: `src/server/payments/` (prices, checkout, PayPal Orders, confirm), `src/server/routes/provider-admin.ts`,
`src/server/routes/provider-webhooks.ts`, `src/portal/screens/payments.tsx`; tables in migration
`20261119120000_payment_providers`.

## Where things are

```
src/pages/            public pages: / (static), /about/, /events/ (SSR), /blog/, account/,
                      r/ (guest RSVP), i/ (invites), p/ (polls), privacy/, host/, checkout/
src/content/site.ts   marketing copy, nav, SITE description
src/server/           the backend (Hono routes, background jobs, mail)
src/domain/           pure event rules (codes, tokens, capacity…)
src/emails/           email templates
src/portal/           the creator dashboard (React SPA at /dashboard)
prisma/               schema, migrations, seed.sql (sample data)
scripts/seed-demo.mjs richer local demo data (npm run db:seed:demo)
docs/ARCHITECTURE.md  routes, data, jobs
docs/PORTING.md       source map and gaps of the port; docs/porting/ has per-area notes
AGENTS.md, docs/agent/  the template's rules for AI agents (managed: never edit)
```

## Quick start

With Node.js 22.12+ and Docker running:

```bash
npm install
docker compose up -d --wait db      # a local Postgres (docker-compose.yml)
npm run setup                       # .env with a new JWT_SECRET, database check, tables
npm run db:seed                     # sample data (prisma/seed.sql)
npm run dev                         # http://localhost:4321
```

Then [create your admin account](#create-your-admin-account): sign up at
http://localhost:4321/account/register/, type the code printed by `npm run dev`, and run
`npm run dev-admin -- you@example.com`. For a fuller dashboard (events with RSVPs, invites, polls,
messages and page views), also run `npm run db:seed:demo`.

## Setting up, step by step

`npm run setup` does [Settings](#settings-env) and [The database](#the-database) for you (not the
sample data); this is what it does, and how to do it by hand.

### Get the code

Clone this app's repository. If you also want template releases, keep the template repository as a
remote named `upstream` ([Staying up to date](#staying-up-to-date)).

### Install

```bash
npm install
```

Node.js 22.12 or later (`.nvmrc` says 22: `nvm use`), and the npm that comes with it.

### Settings (.env)

`npm run setup` makes `.env` from `.env.example`, generates a `JWT_SECRET` and points
`DATABASE_URL` at the local database. It never overwrites a value you set. By hand:
`cp .env.example .env` and fill in the two required values. `.env` stays on your computer (git
ignores it): never commit it. Restart `npm run dev` after changing it.

| Variable | On your computer | What it is |
| --- | --- | --- |
| `DATABASE_URL` | **required** | the Postgres connection string. Local: `postgresql://postgres:dev@localhost:5432/site`. |
| `JWT_SECRET` | **required**, 32+ random characters | signs sign-in tokens and keys the rate limits. Make one: `openssl rand -base64 48`. |
| `SITE_KEY` | **leave empty** | the secret the platform gives hosted sites to send emails. Empty turns on [local development mode](#local-development-mode). |
| `SITE_URL` | leave empty | the site's address on the platform, where it answers `/api/*`. |
| `SITE_PREVIEW` | leave empty | `1` only in the platform editor's Preview. |
| `SITE_OWNER_ID` | leave empty | the platform's opaque id for the account's owner. |
| `DB_PORT` | optional | the port `docker-compose.yml` publishes when 5432 is taken ([Troubleshooting](#troubleshooting)). The site never reads it. |

### The database

Postgres only (15 or later). `docker-compose.yml` runs Postgres 16 with a database named `site`
(user `postgres`, password `dev`), kept in a Docker volume between restarts:

```bash
docker compose up -d --wait db    # start (and wait until it is ready)
docker compose stop db            # stop, keeping the data
docker compose down -v            # delete it, data included: start from empty
```

Create the tables, and run it again after every new migration (yours or a template release's):

```bash
npm run db:migrate                # prisma migrate deploy
npm run db:seed                   # the sample data in prisma/seed.sql
npm run db:seed:demo              # optional: richer demo events (local databases only)
```

`db:seed:demo` replaces only its own `demo-` events each time it runs, never touches accounts, and
refuses a database that isn't on this computer (the editor's Preview Database only with
`SITE_PREVIEW=1` and `SEED_DEMO_HOST=<its host>`). It stops without changing anything when a
`demo-` slug belongs to an event it didn't create. It prints a few guest links at the end, since
manage tokens are stored hashed.

### Run it

```bash
npm run dev                       # http://localhost:4321
```

If `npm run dev` returns to the prompt with "Dev server running at…", it runs in the background:
`npx astro dev logs` shows its output, `npx astro dev stop` stops it.

## Local development mode

There is no `SITE_KEY` on your computer, so nothing can be emailed. While `npm run dev` runs with
an empty `SITE_KEY`, every account email (sign-up and sign-in codes, reset and confirmation links)
is printed where `npm run dev` runs (or in `npx astro dev logs`), under "LOCAL DEVELOPMENT ONLY",
instead of being sent:

```
────────── LOCAL DEVELOPMENT ONLY: this email was not sent ──────────
  sign_up_code → you@example.com
  code: 123456
  link: http://localhost:4321/account/verify/?signup=…
```

It is off as soon as `SITE_KEY` or `SITE_PREVIEW` is set, with `NODE_ENV=production`, and in every
`npm run build`, so it is never on a hosted site.

## Create your admin account

On a hosted site the admin is the account's owner, who opens it with "View as admin" in the
dashboard. On your computer nobody can press that, so you make a local admin:

1. Open http://localhost:4321/account/register/ and sign up with any address (`you@example.com`)
   and a password of 10 or more characters.
2. Type the 6-digit code printed by `npm run dev` ([Local development mode](#local-development-mode)).
3. In another terminal, in the project folder:
   ```bash
   npm run dev-admin -- you@example.com
   ```
4. Open (or reload) http://localhost:4321/dashboard/: events, guests, users, roles and activity are there.

`dev-admin` changes your LOCAL database only. It refuses when `SITE_KEY` or `SITE_PREVIEW` is set or
`NODE_ENV=production`, and when `DATABASE_URL` isn't on this computer. It never makes an owner, so
the few things only the owner can do (editing roles) can't be tried locally. There is no shared
admin password, and none is ever kept in this repository.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run setup` | checks Node.js and packages, makes `.env` (new `JWT_SECRET`), checks the database, creates the tables |
| `npm run dev` | the dev server, http://localhost:4321 |
| `npm run build` | the production build into `dist/` (what the platform builds) |
| `npm test` | unit tests; integration tests too with `TEST_DATABASE_URL` ([Tests](#tests)) |
| `npm run check` | `npm test`, then `npm run build`: run it before you push |
| `npm run db:migrate` | applies new migrations (`prisma migrate deploy`) |
| `npm run db:seed` | loads `prisma/seed.sql` (sample data) |
| `npm run db:seed:demo` | richer demo events, RSVPs, invites, polls (local only) |
| `npm run dev-admin -- <email>` | a local admin ([Create your admin account](#create-your-admin-account)) |
| `npm run studio` | Prisma Studio on http://localhost:5555, to browse the database |
| `npm run preview` | serves the last `npm run build` |
| `npm run platform -- jobs` | checks `background.json` and its handlers |
| `npm run platform -- check` | the template's own files untouched, and is a newer release out |

## Rules for this app

These come on top of `AGENTS.md` and `docs/agent/`, which stay exactly as the template ships them.
Details: `docs/ARCHITECTURE.md` (routes, data, jobs), `docs/PORTING.md` (source map, gaps),
`docs/porting/*.md`.

- **Code**: backend `src/server/routes/{admin-*,rsvp,events,event-*,polls-public,privacy,pageviews}.ts`,
  jobs `src/server/jobs/`, mail `src/server/mailer.ts` + `src/emails/`, pure rules `src/domain/`,
  shared validators `src/lib/event-schemas.ts`, dashboard `src/portal/screens/`, public pages
  `src/pages/{events,r,i,p,privacy,host}/`, schema `prisma/schema.prisma` (events section).
- **Public events** live at `/events/` and `/events/<slug>/`, server-rendered from the Site Database
  (`src/pages/events/`); a missing event is a 404, a database failure never is. The sitemap lists
  public events. There is no job board.
- **Permissions**: `site:event:manage` (`PERMISSIONS.EVENT_MANAGE`) and `site:event:checkin`
  (`EVENT_CHECKIN`; door routes also accept manage); roles `owner`, `admin`, `checkin-staff`.
  No workspaces: settings are the single `event_settings` row (id 1).
- **Owners** come only from the platform's "View as admin". Nothing in this app (an email list, a
  setting, the first account, the seed) makes an owner or an admin.
- **Ticket prices** come only from the payments catalogue (`ticketPriceKey`, `startTicketCheckout`):
  never an amount from the client, never a changed price (a new price is a new key). Tickets and
  refunds follow `docs/agent/orders-and-stock.md`: capacity is decided by the database, every
  charge carries an idempotency key.
- **Guest emails** are stored and compared lower-cased, and never shown to other guests.
- **Manage and invite tokens** are stored as sha256 (`hashToken` in `src/domain/secureToken.ts`):
  never store or log the raw token.

## Building on it

- **Your code**: `src/server/` (routes), `src/pages/` (pages), `src/portal/` (dashboard screens),
  `src/content/` (words), `src/domain/`, `src/lib/`, `src/styles/`, `prisma/`. `AGENTS.md` and
  `docs/agent/` have the rules for each: read them, or have your AI read them, before every change.
- **Never edit the template's own files**: `src/platform/`, `docs/agent/`, `AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`, `template.json`, `CHANGELOG.md`, `scripts/platform.mjs` and `scripts/managed-files.json`.
  Releases replace them (that is how security fixes arrive), and each is compared byte for byte with
  the release `template.json` names: `npm run platform -- check` lists any that changed. Put one back
  with `git checkout v<your version> -- <file>`. Describe this app here in `README.md` instead.
  `.gitattributes` keeps every text file LF, so a Windows checkout doesn't change them.
- **Changing the database**: a new migration for every change, never an edit to an applied one.
  ```bash
  npx prisma migrate dev --create-only --name add_bookings   # 1. write it
  # 2. wrap prisma/migrations/<…>/migration.sql in BEGIN; … COMMIT;
  npx prisma migrate dev                                      # 3. apply it
  npx prisma generate                                         # 4. the client gets the new model
  ```
  Change tables in steps (add, fill, switch, drop later): `docs/agent/database.md`.
- **Sample data, `prisma/seed.sql`**: made-up rows for this app's own tables, never for a live
  database. Wrapped in `BEGIN;` … `COMMIT;`, stops with `RAISE EXCEPTION` when real data is there,
  safe to run twice, `@example.com` addresses only, no users or passwords. It must keep at least one
  `INSERT`: a store listing loads it into its review copy and preview.
- **Before you push**: `npm run check` and `npm run platform -- check`. Follow `DEVELOPERS.md`
  "For your AI" (and its ready-to-submit checklist) before a store listing.

## Tests

```bash
npm test                          # unit tests
```

Integration tests run the real Site API on a real Postgres and **empty that database first**: give
them a database of their own, never the one you work in.

```bash
docker compose exec db createdb -U postgres site_test
DATABASE_URL=postgresql://postgres:dev@localhost:5432/site_test npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://postgres:dev@localhost:5432/site_test npm test
```

## Staying up to date

Template releases are tagged `vX.Y.Z` in the template repository (the `upstream` remote; add it once
with `git remote add upstream <the template repository's address>`). `CHANGELOG.md` says what each
changed and whether it is required. With your work committed:

```bash
git fetch upstream --tags
git describe --tags --abbrev=0 upstream/main   # the newest release
git merge "$(git describe --tags --abbrev=0 upstream/main)"
npm install
npm run db:migrate
npm run check
```

Then follow the new `docs/agent/upgrade.md` for anything that release asks of files you changed.

**Conflicts** (git lists them; search for `<<<<<<<`):
- `package-lock.json`: `git checkout --theirs package-lock.json`, then `npm install` (it rebuilds the
  lock for the merged `package.json`), then commit.
- The template's own files (`src/platform/`, `docs/agent/`, `scripts/platform.mjs`,
  `scripts/managed-files.json`, `template.json`, `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`): take the template's (`git checkout --theirs <file>`). Never keep changes of your own
  in them: describe the app in `README.md` instead.
- This app's files (pages, `src/content/site.ts`, styles, `README.md`): keep its words and look, and
  bring over what the template changed. The template's job board and dashboard setup checklist were
  removed on purpose: don't bring them back.
- `git merge --abort` puts everything back as it was.

### Started from a copy

No shared history with the template: connect it once, then merge releases as above.

```bash
git remote add upstream <the template repository's address>
git fetch upstream --tags
git merge v<the version in your template.json> --allow-unrelated-histories   # once
git merge "$(git describe --tags --abbrev=0 upstream/main)"                # then the newest release
```

The first merge lists every file that differs from that release: keep your side of the app's own
files (`git checkout --ours <file>`) and the template's side of its own files
(`git checkout --theirs <file>`), then commit.

## Troubleshooting

| What you see | Why | Fix |
| --- | --- | --- |
| `npm install` warns `EBADENGINE`, or `npm run setup` says Node.js is too old | Node.js below 22.12 | `nvm install 22`, then `nvm use 22` (or install 22.12+), then `npm install` again |
| `docker compose up` says `Bind for 0.0.0.0:5432 failed: port is already allocated` | another Postgres already uses port 5432 | put `DB_PORT=5433` in `.env` (and `:5433` in `DATABASE_URL` if it is already set), then `docker compose up -d --wait db` and `npm run setup` |
| `npm run setup` says `no database answers at localhost:5432` (or `ECONNREFUSED`) | the database isn't running, or Docker isn't | start Docker, then `docker compose up -d --wait db`, then `npm run setup` |
| sign-up answers 503 `auth_not_configured`: "Sign-in is not set up on this site yet" | `JWT_SECRET` is missing or shorter than 32 characters | `npm run setup` (or `openssl rand -base64 48` into `.env`), then restart `npm run dev` |
| pages, event pages or sign-in answer 503 `site_database_disabled` | `DATABASE_URL` is empty | `npm run setup`, then restart `npm run dev` |
| sign-up answers 500, and the dev server shows `relation "login_attempts" does not exist` or `The table public.permissions does not exist` | the tables aren't created (migrations pending) | `npm run db:migrate` |
| `/events/` is empty | no sample data loaded | `npm run db:seed` (and `npm run db:seed:demo` for more) |
| `db:seed` stops with an exception about existing data | `prisma/seed.sql` refuses a database that already holds real data | use a fresh local database (`docker compose down -v`, then up, `npm run setup`) |
| no code appears after signing up | `SITE_KEY` is set (codes are then emailed by the platform), or the dev server runs in the background | empty `SITE_KEY` in `.env` and restart; or read `npx astro dev logs` |
| no new code when you sign up again with the same address | account emails to one address are limited, so a repeat within a few minutes sends none | use the code printed the first time, wait a few minutes, or sign up with another address |
| `dev-admin` says `no account for …` | that address hasn't finished signing up in this database | sign up and type the code first |
| `dev-admin` says `refused (local development only)` | `SITE_KEY`, `SITE_PREVIEW` or `NODE_ENV=production` is set, or `DATABASE_URL` isn't on this computer | empty them in `.env` (it only ever changes a local database) |
| `npm run dev` says port 4321 is in use, or opens another port | another dev server is running | use the address it prints, or stop the other one (`npx astro dev stop`) |
| http://localhost:4321 shows a different project, or sign-up says "This form has expired" | another app already listens on 127.0.0.1:4321, so this one only got `[::1]:4321` | stop the other app, or run this one on a free port: `npx astro dev stop && npx astro dev --port 4322` |
| the dashboard shows nothing for admins after `dev-admin` | the page was open before | reload `/dashboard/` |

**How do I start over?** `docker compose down -v`, `docker compose up -d --wait db`,
`npm run setup`, `npm run db:seed`.

## On the platform

- **Enable the Site Database before the first Publish.** This app ships migrations; a version with
  migrations is refused until the site has a database.
- Publish installs with `npm ci`, runs `npm run build` (`prisma generate && astro build`), applies
  new migrations to the live database, then deploys. If a migration fails, the previous version keeps
  serving.
- The **owner** is the account's owner, who opens the admin with **View as admin** in the dashboard
  or the editor. There's no owner sign-up, password or owner list; anyone who signs up is a normal
  user, whatever email they use. Owners and admins manage users at `/dashboard/users` and roles at
  `/dashboard/roles`.
- Account emails, invites and reminders are sent by the platform on the site's behalf.
- Change how sign-up works in `src/server/auth-settings.ts`.
