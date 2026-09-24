# ASCE Concrete Canoe | UTEP

**Status: 🚧 In Progress**

A web platform to support the management and organization of the ASCE Concrete Canoe Team at UTEP.

The first module, **Attendance**, is complete and validated against a real Supabase project (not yet deployed). The platform is
designed to grow into a team and project management tool; see the [Roadmap](#roadmap).

## Current module: Attendance

A mobile-first check-in system for team meetings. An admin opens a check-in session and projects a QR code that changes every
10 seconds; members scan it with their phone's native camera, confirm who they are, and the server records their attendance.
No app to install, no student accounts.

### The problem

Paper sign-in sheets and shared spreadsheets are slow, easy to fill in on someone else's behalf, and make it hard to answer simple
questions such as *"what is this member's attendance rate?"* This app replaces them with a check-in that takes a few seconds per
person, requires having seen the QR code shown in the room, and keeps an auditable attendance history in PostgreSQL.

### Features

**Student check-in**
- Rotating QR code (new code every 10 s) opened with the phone's native camera.
- Scanning exchanges the QR token for a short-lived, signed check-in ticket (3 min), so a slow typist is not rushed by the QR rotation.
- Identification with **ASCE ID + name**; optional **"Remember me"** so a returning device only needs to tap *Check in*.
- One attendance per member per session, enforced by the database.

**Admin panel** (Supabase Auth; no public sign-up)
- **Members:** create, edit, deactivate/reactivate, position, and *Design Team* membership.
- **Sessions:** start a check-in (full-screen QR view with a live attendee counter), close it, or delete it.
- **Team audiences:** a session can target *Design Team*, *Rowing & Construction*, or both teams; each member's percentage only counts
  the meetings aimed at their group.
- **Attendance:** history of closed meetings (present / expected / rate, filterable by team), per-member history, and a dashboard with
  every active member's attendance percentage.
- **Manual corrections:** Present ↔ Absent on closed meetings, stored separately from real check-ins.
- **Audit log:** manual attendance changes and session deletions are recorded by database triggers in an append-only `audit_log`.

## Architecture

```
Phone camera ──► /c/<qr-token> ──► server verifies QR (HMAC, server time) ──► issues signed ticket
                                                                                   │
Admin QR screen ◄── /api/admin/sessions/[id]/qr (tokens for current + next slot)   ▼
                                                        ASCE ID + name (or remembered device)
                                                                                   │
                                                  Server Action ──► checks ticket, rate limits,
                                                                    active session, active member
                                                                                   │
                                                                   PostgreSQL (constraints, triggers, RLS)
```

- **Next.js App Router** with Server Components and Server Actions. The browser never talks to Supabase directly
  (`connect-src 'self'`); every read and write goes through the server.
- **Two Supabase clients, both server-only.** The admin panel uses the admin's session cookie, so every query runs under **Row Level
  Security**. The public check-in path uses a `service_role` client confined to `server-only` modules with narrowly scoped grants.
- **Pure core, injected dependencies.** QR/ticket verification (`src/lib/checkin/gate.ts`) and check-in submission
  (`src/lib/checkin/submit.ts`) receive the clock, keys and data store as arguments, so the security logic is unit-tested without a
  network or a database.
- **The database is the source of truth.** Attendance percentages, expected attendees and manual corrections are computed by SQL views
  (`session_attendance`, `member_attendance`, `session_attendance_summary`), not reassembled in JavaScript.

```
src/
  app/            routes: public landing, /c/[token] check-in, /admin panel, admin API routes
  components/     admin, check-in, brand and UI components
  lib/            tokens, tickets, device tokens, check-in gate/submission, validation, data access, auth
  proxy.ts        per-request CSP nonce, session refresh, optimistic /admin redirect
supabase/migrations/   schema, RLS, grants, triggers and views (15 migrations)
tests/            unit · ui (jsdom) · db (real Postgres 17) · supabase (live project) · e2e (Playwright)
```

## Security

- **Signed, stateless QR tokens.** `v1.<session>.<slot>.<mac>`: HMAC-SHA256 over the session id and a 10-second time slot, validated
  only against server time (5 s grace by default). Nothing about validity is decided by the browser or the phone's clock.
- **Separate keys per purpose.** QR, ticket, IP-hash and device keys are derived from a single `SERVER_SECRET` with HKDF, so a MAC for
  one purpose is never valid for another. MACs are compared in constant time.
- **Rate limiting** of failed check-ins per ticket, per ASCE ID and per (HMAC-hashed) IP address, backed by the `checkin_attempts` table.
- **No member enumeration.** An unknown ASCE ID, an inactive member and a wrong name all return the same generic error.
- **"Remember me" without stored credentials.** A random 256-bit token lives in an `HttpOnly`, path-scoped cookie; the database only
  stores its HMAC. Devices expire (180 days after last use, 365 days max), are capped at 5 per member, and are revoked when a member is
  deactivated. A remembered device never replaces the QR scan.
- **Row Level Security on every table**, column-level grants for admins, no table access for `anon`, an append-only `audit_log`,
  and database-enforced invariants (one active session, sessions never reopen, one check-in per member and session, single-use tickets).
- **Defense in depth on the web layer:** nonce-based Content-Security-Policy, `X-Frame-Options: DENY`, HSTS, `no-store` on
  admin/API/check-in routes, and an authoritative `requireAdmin()` check in every admin page, Server Action and API route.

More detail: [docs/TOKENS.md](docs/TOKENS.md) (what QR tokens and tickets do and do not prove) and
[docs/ADMIN-ACCESS.md](docs/ADMIN-ACCESS.md). *(The design notes in `docs/` are written in Spanish.)*

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Supabase (PostgreSQL + Auth) · Zod · Vitest · Playwright + axe-core ·
GitHub Actions · Vercel (planned hosting)

## Testing

| Suite | Command | What it covers |
|---|---|---|
| Unit | `npm run test:unit` | Tokens, tickets, crypto, validation, check-in logic, static security checks |
| UI | `npm run test:ui` | React components in jsdom |
| Database | `npm run test:db` | Migrations, RLS, grants, triggers, views and concurrency on a real embedded PostgreSQL 17 (no Docker) |
| Supabase | `npm run test:supabase` | The same guarantees against a live Supabase project ([docs/SUPABASE-VALIDATION.md](docs/SUPABASE-VALIDATION.md)) |
| End-to-end | `npm run test:e2e` | Playwright on desktop Chrome, iPhone (WebKit) and Android, with axe accessibility checks |

`npm test` runs the unit, UI and database suites (~800 tests); CI runs lint, typecheck, those tests and a production build on every push.

## Getting started

Requirements: Node.js 22+ and a Supabase project.

```bash
npm install
cp .env.example .env.local   # then fill in the values (see below)
npm run dev
```

Apply the migrations in `supabase/migrations/` in order and create admin users in Supabase Auth — step-by-step instructions in
[docs/SETUP.md](docs/SETUP.md).

### Environment variables

| Variable | Required | Visibility | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Public | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes | Public | Publishable (anon) key, used by the admin session client |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | **Secret** | Server-only client for the public check-in path |
| `SERVER_SECRET` | Yes | **Secret** | Master secret (≥ 32 chars) for QR, ticket, IP-hash and device keys |
| `QR_GRACE_MS` | No | Server | Grace period after each 10 s QR slot (0–15000, default 5000) |
| `TICKET_TTL_SECONDS` | No | Server | Check-in ticket lifetime (60–600, default 180) |

Server variables are validated with Zod at first use; error messages name the variable but never print its value.

## Project status

- ✅ Members, sessions, rotating-QR check-in, "Remember me", team audiences, attendance history, percentages and manual corrections.
- ✅ Validated against a real Supabase project, with end-to-end tests on desktop, iPhone and Android device profiles.
- 🚧 Not yet deployed. Remaining work is infrastructure: Vercel deployment, production environment variables and a daily keep-alive for
  the Supabase free tier.

## Roadmap

Attendance is the first module of a broader platform for managing the team's project. The following modules are
**planned and not yet implemented**:

| Module | Status |
|---|---|
| Documentation management | 🗓️ Planned |
| Project document organization (uploads, categories) | 🗓️ Planned |
| Project progress tracking | 🗓️ Planned |
| Task assignment | 🗓️ Planned |
| Task completion tracking (completion percentages) | 🗓️ Planned |
| Time allocation / tracking | 🗓️ Planned |
| Additional team management tools | 🗓️ Planned |
