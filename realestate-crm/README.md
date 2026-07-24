# Listing Matcher

Match new MLS listings to the right buyers in an agent's book of business, and
draft a personal email to each — straight into Gmail Drafts for review and
sending. Built for a Keller Williams agent; architected so it can grow into a
sellable SaaS. See [`PLAN.md`](./PLAN.md) for the full design.

> **Status: Phase-1 scaffold.** Auth, CSV import (with suppression-aware
> upsert), the contacts browser, contact lifecycle, and the public unsubscribe
> endpoint are in place. The three AI jobs (parse / match / draft) are typed
> stubs — they get wired up once we have a real KW Command CSV export to design
> prompts against. Not yet installed or run in CI.

## Stack

- **Next.js 14** (App Router) + React 18 + TypeScript
- **Prisma** + **PostgreSQL** — data model in `prisma/schema.prisma`
- **Auth.js (NextAuth v5)** — Google OAuth, hard 2-email allowlist
- **Anthropic Claude** — the AI jobs (server-side only)

## Setup

```bash
cd realestate-crm
npm install
cp .env.example .env.local        # fill in the values (see below)
npm run db:push                   # create tables in your Postgres
npm run dev                       # http://localhost:3000
```

### Environment (`.env.local`)

| Var | What |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `ALLOWED_EMAILS` | Comma-separated allowlist (Jordan + mom), lowercase |
| `ADMIN_EMAIL` | Which allowlisted account is admin |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth client (scope: `gmail.compose`) |
| `ANTHROPIC_API_KEY` | Server-side only |
| `SUPPRESSION_PEPPER` | `openssl rand -hex 32` — keep stable & secret |
| `APP_BASE_URL` | Public base URL for unsubscribe links |

### Google OAuth

Create an OAuth client in Google Cloud Console. Request scopes
`openid email profile https://www.googleapis.com/auth/gmail.compose`
(drafts only — the app **cannot send**). Keep the app in **Testing** mode and
add the two accounts as test users — no Google verification needed at this
scale. Redirect URI: `${APP_BASE_URL}/api/auth/callback/google`.

## What works now

- **Google sign-in** limited to the allowlist; admin vs agent role.
- **Import** (`/import`) — upload a KW Command CSV. Upsert by email:
  - skips anyone on the **suppression list** (unsubscribed/deleted) so they're
    never resurrected,
  - preserves hand-edited contacts,
  - never resets lifecycle status,
  - returns a diff summary (new / updated / notes-changed / skipped).
  - A synthetic `sample-data/sample-contacts.csv` is included for testing.
- **Contacts** (`/contacts`) — searchable/filterable list + detail page with
  the (to-be-parsed) buyer profile, notes, raw fields, and lifecycle actions.
- **Lifecycle** — mark bought / cold / do-not-contact, or delete (forget).
  Do-not-contact and delete write to the hashed suppression list.
- **Unsubscribe** (`/u/{token}`) — public, data-free, honored immediately.

## Next (needs the real CSV)

1. Lock the importer's column mapping to KW Command's actual export.
2. Phase 2 — `parseProfile`: notes → structured buyer profile + review screen.
3. Phase 3 — `extractListing` + `rankMatches`: paste listing → ranked buyers.
4. Phase 4 — `draftEmail`: personal emails → Gmail Drafts.

See `src/lib/ai.ts` for the typed contracts these implement.
