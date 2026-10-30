# CreatorCrowdHub

The event platform for creators: branded event pages, email invites, RSVPs (questions, plus-ones,
approval, waitlist), reminders with calendar files and live polls behind one link. Guests never
need an account; every guest lands in the creator's own contacts list.

Built on the Astro app template: Astro 7 + Hono (`/site-api`) + Prisma 7 on one Cloudflare Worker.
Port of the TanStack Start app in `../CreatorCrowdHub`.

## Where things are

```
src/pages/            public pages: / (static), /about/, /events/ (SSR), /blog/, /jobs/, account/
src/content/site.ts   marketing copy, nav, SITE description
src/server/           the backend (Hono routes, background jobs, mail)
src/portal/           the creator dashboard (React SPA at /dashboard)
prisma/               schema, migrations, seed
docs/agent/           platform docs for coding agents (AGENTS.md is the rulebook)
docs/porting/         notes about the port (SEO, etc.)
```

## Run it

```bash
cp .env.example .env        # SITE_URL, JWT_SECRET, DATABASE_URL
npm install
npx prisma migrate deploy
npm run dev                 # http://localhost:4321
npm test
npm run build               # prisma generate && astro build
```

`.env` is local only: never commit it.

## Platform notes

- Publish builds with `npm run build` and applies new migrations first; enable the Site Database
  before the first Publish.
- Owner accounts come from the platform's owner emails (see `AGENTS.md`, `docs/agent/auth.md`).
- `npm run platform -- check | upgrade | docs` keeps the template core current; `src/platform/`
  and `docs/agent/` are managed, never edit them. `template.json` is the template's record.
