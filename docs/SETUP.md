# Setup

## Requirements

- Node.js ≥ 22 (tested with 24).
- **Docker is not required** for the test suites: database tests run on a real embedded PostgreSQL 17 (`embedded-postgres`).
  Docker is only needed for `supabase start` (a full local Supabase stack).

## Commands

```bash
npm install
npm run lint
npm run typecheck
npm test              # unit + UI (jsdom) + database tests
npm run test:unit     # pure logic, cryptography and static security checks
npm run test:ui       # React components (jsdom)
npm run test:db       # migrations, RLS and concurrency (local PostgreSQL)
npm run test:supabase # validation against a REAL Supabase project (not part of npm test; see SUPABASE-VALIDATION.md)
npm run test:e2e      # Playwright + axe (desktop, iPhone/WebKit, Android) against REAL Supabase; builds the app and creates/deletes temporary users
npm run build
```

## Environment variables

Copy `.env.example` to `.env.local`. Generate the secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

| Variable | Purpose | Rotation |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (public) | — |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable (`anon`) key; `anon` has no access to any table | From the Supabase dashboard |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` client (server only) | From the Supabase dashboard |
| `SERVER_SECRET` | HKDF master secret for QR tokens, tickets, IP hashing and "Remember me" device tokens | Invalidates live QR codes/tickets and forgets remembered devices (students just identify themselves again) |
| `QR_GRACE_MS` | Grace period after each 10 s QR slot (0–15000, default 5000) | — |
| `TICKET_TTL_SECONDS` | Check-in ticket lifetime (60–600, default 180) | — |

Never commit `.env.local` (it is in `.gitignore`). Variables that are no longer read by the app are ignored and can be removed.

## Supabase (cloud, Free plan)

1. Create the project. Recommended region: US East, close to the Vercel region `iad1`.
2. **Disable public sign-ups**: Authentication → Sign In / Providers → turn off "Allow new users to sign up".
   (`supabase/config.toml` does this for the local stack only; in the cloud it is a dashboard setting.)
3. Apply the **15 migrations** in `supabase/migrations/` in order (from `…000000_schema.sql` to `…001400_session_audience_both_views.sql`)
   with the CLI (`npx supabase link`, then `npx supabase db push`) or by pasting them one by one into the SQL Editor. Never edit a migration
   that has already been applied; changes go in new migrations. **Migrations 14 (`…001300_session_audience_both.sql`) and 15
   (`…001400_session_audience_both_views.sql`) must run SEPARATELY, in that order**: PostgreSQL does not allow using a newly added enum
   value in the same transaction that added it. When pasting migration 1 into the SQL Editor, choose **"Run without RLS"** (migration 2
   enables RLS).
4. **Admins**: there is no admins table. **Every confirmed Supabase Auth user is an admin**: Authentication → Users → "Add user"
   (email + password of at least 12 characters, with *Auto Confirm User*), optionally with `{"display_name": "First Last"}` in the user
   metadata. No SQL is needed. Only create users who should be admins; see [ADMIN-ACCESS.md](ADMIN-ACCESS.md).

The migrations are tested against a real local PostgreSQL 17 (with a shim that mimics Supabase's roles and `auth` schema) **and against
Supabase Cloud**; see [SUPABASE-VALIDATION.md](SUPABASE-VALIDATION.md).

### Column-level grants

Admins have **column-level** privileges on the tables, so the application always lists columns explicitly
(`select id, asce_id, name, …`) instead of `select *`.

## Free-plan caveats

- **Inactivity pause**: Supabase Free pauses a project after about a week of low activity
  ([docs](https://supabase.com/docs/guides/platform/free-project-pausing)). A daily Vercel Hobby cron job running a trivial query is the
  planned mitigation, to be added together with the Vercel deployment.
- **Vercel Hobby is for non-commercial use only**
  ([Fair Use](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage)). A free attendance app for a student chapter fits
  that use.
