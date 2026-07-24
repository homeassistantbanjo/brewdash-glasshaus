# Real-Estate CRM Matcher — Plan

A hosted web app that helps a Keller Williams agent (mom) stop keeping a
notebook of "which house to send to which buyer." She uploads her CRM
contacts, pastes a new MLS listing, and the app shows which of her buyers
match — and why — then drafts a personalized email to each, straight into
her Gmail Drafts for her to review and send.

> Status: **planning**. The one hard blocker before building the importer is
> a **sample KW Command CSV export** (can be anonymized). It defines the data
> model, whether "what they're looking for" notes come through, and the
> upsert key.

---

## Product positioning: build for two, architect for SaaS

Ship a **single-tenant** app for two users (Jordan + mom) now. But make
"going multi-tenant to sell it" a **refactor, not a rewrite** by paying a few
cheap costs up front:

- **`tenant_id` (owner) on every table from day one** — even with one tenant.
  Retrofitting tenancy later is the expensive migration; this avoids it.
- **Auth stays pluggable** — a 2-email allowlist now, swappable for self-serve
  signup + per-tenant provisioning later.
- **Gmail strictly per-account** — each user connects their own Google; no
  shared/global mail credentials.
- Keep billing, ToS/Privacy/DPA, and Google OAuth verification out of scope
  now, but leave seams for them (see "Future: selling it").

⚠️ **Known gate for selling:** `gmail.compose` is a Google *restricted* scope
— free in Testing mode (≤100 users), but public launch needs OAuth
verification + an annual third-party CASA assessment (~$500–$4k/yr). Decide
Gmail-core vs copy/paste fallback before public launch.

---

## Who it's for (now)

- **Agent (mom)** — uploads CRM exports, browses contacts, matches listings,
  generates and reviews email drafts.
- **Admin (Jordan)** — everything the agent can do, plus manages the login
  allowlist and app config.

Exactly **two Google accounts** may sign in (hard allowlist). Everyone else
is rejected.

---

## Look & feel

Simple, modern, clean — but colorful and professional. Not a sterile
enterprise CRM; not a toy. Direction:

- Generous whitespace, clear type hierarchy, one confident accent color plus
  supporting tints (colorful but disciplined — think a couple of vivid
  gradients/accent chips, not a rainbow).
- Rounded cards, soft shadows, smooth micro-interactions; fast and calm.
- Content-first layouts: the contact list, the match results, and the draft
  review are the hero screens and should feel effortless.
- Fully responsive (she may use a laptop or tablet).
- Design tokens (color, spacing, radius, type) centralized so the whole look
  can be re-skinned for a sellable brand later.

---

## The flow

```
1. Export contacts from KW Command  →  upload CSV to the app (anytime)
                                           │  upsert: update changed, add new,
                                           │  KEEP her hand edits
                                           ▼
2. AI parses each contact's notes/criteria into a structured buyer profile
   → she reviews/fixes on a per-contact screen
                                           ▼
3. A listing comes up  →  she pastes the MLS text/URL/fields
   → AI extracts the home's features
   → hard-filter buyers (price, min beds)  →  AI-rank survivors w/ fit + reason
                                           ▼
4. She picks which buyers to contact
   → AI drafts a personal email per buyer, in HER voice, citing THAT buyer's
     specific reasons
   → creates Gmail DRAFTS (never auto-sends)
                                           ▼
5. She reviews each draft in Gmail and sends.  App records who got which
   listing so she never re-pitches the same house to the same person.
```

## Why AI (not just a spreadsheet filter)

1. **Parse messy notes.** "wants acreage for horses, mid-6s, hates HOAs" →
   `price 550–650k`, `must_haves: [acreage]`, `dealbreakers: [HOA]`.
2. **Personal drafts, not mail-merge.** Each email references that buyer's
   own reasons — this is what drives the interest she gets doing it by hand.

---

## Architecture

```
Browser (React / Next.js)                Serverless API (Next.js routes)
 • Upload CSV                             • Anthropic API key (server only)
 • Contacts browser + detail/edit        • Google OAuth + token storage (enc.)
 • Paste listing → ranked matches        • /import  /parse  /match  /draft
 • Select buyers → drafts                          │
                                          Postgres (encrypted PII)   Gmail API
                                          contacts, profiles,        (compose /
                                          listings, send-history     drafts only)
```

**Stack:** Next.js on Vercel · Postgres (Supabase or Neon) · Anthropic Claude
API · Google OAuth (`gmail.compose` scope). Evolves the React/TS already used
in this repo.

---

## Data model (first cut — refine against real CSV)

Every table carries `tenant_id` (owner) even though there is one tenant now.

- **contact** — `id`, `tenant_id`, `crm_id?`, `name`, `email`, `phone`,
  `raw_fields (jsonb)`, `source_notes (text)`, `status (enum)`,
  `status_changed_at`, `created_at`, `updated_at`, `hand_edited (bool)`,
  `unsubscribe_token`
- **buyer_profile** — `contact_id`, `price_min`, `price_max`, `beds_min`,
  `baths_min`, `location[]`, `must_haves[]`, `nice_to_haves[]`,
  `lifestyle_tags[]`, `dealbreakers[]`, `confidence`, `edited_by_user (bool)`
- **listing** — `id`, `tenant_id`, `raw_text`, `address`, `price`, `beds`,
  `baths`, `features[]`, `created_at`
- **match** — `listing_id`, `contact_id`, `score`, `reasons[]`, `status`
- **email_draft** — `match_id`, `subject`, `body`, `gmail_draft_id`,
  `status (draft/sent)`, `created_at`
- **suppression** — `tenant_id`, `email_hash`, `reason (opt_out/deleted)`,
  `created_at` — the do-not-contact + right-to-be-forgotten list. Stores a
  **hash of the email, not the email**, so it survives re-import and can
  silently skip people without retaining the PII of anyone who asked to be
  forgotten.

`contact.status` enum: `active` · `bought` (deal closed) · `cold`
(inactive) · `do_not_contact` (opted out) · *(deleted rows are removed;
their tombstone lives in `suppression`)*.

**Upsert on re-import:** key = email (or `crm_id` if present).
1. **Check `suppression` first** — any incoming row whose `email_hash` is
   suppressed is skipped entirely (never resurrected or re-pitched).
2. Update raw CRM fields; re-parse a profile only when notes changed.
3. **Never overwrite a field the agent edited by hand** (`edited_by_user`),
   and never silently flip a contact out of `do_not_contact`/`bought`/`cold`.
4. Show a diff before commit: "14 updated · 3 new · 2 changed notes ·
   1 skipped (unsubscribed) — re-parse the changed ones?"

---

## The three AI jobs

1. **Parse (on import)** — contact notes/fields → structured buyer_profile +
   confidence. Agent confirms on a review screen.
2. **Match (per listing)** — extract listing features; hard-filter on price
   overlap + min beds (cheap); AI-rank survivors with a 0–100 fit score and a
   one-line reason each.
3. **Draft (per selected buyer)** — personalized email in her voice, citing
   that buyer's reasons. Captured "voice sample" keeps it sounding like her.

---

## Gmail: drafts only

- Scope: `https://www.googleapis.com/auth/gmail.compose` — can create drafts,
  **cannot send**. The app writes to her Drafts; she reviews and sends.
- Google app kept in **Testing** publishing status with the two accounts as
  test users → no Google verification review needed.

---

## Contact lifecycle & suppression

A contact can be `active → bought` (deal closed), `active → cold`
(inactive), or `→ do_not_contact` (opted out), and can be **deleted on
request**. Only `active` contacts are eligible for matching/drafting.

**How a contact gets suppressed (do-not-contact):**
1. **Mom marks them** in the contact detail screen (always-available
   backstop).
2. **Unsubscribe link in emails** — every generated email includes a
   tokenized unsubscribe link (`/u/{unsubscribe_token}`). Clicking it adds an
   `email_hash` to `suppression` and flips the contact to `do_not_contact`,
   honored immediately. This is the one **public, unauthenticated** endpoint
   in the app (the link must work for the recipient) — it does nothing but
   suppress, and reveals no data.

**Delete on request (right to be forgotten):** hard-delete the contact +
profile + drafts, and write an `email_hash` tombstone to `suppression`
(`reason=deleted`). Re-import silently skips them; we retain no PII.

**Why suppression is hashed & separate:** re-importing a KW export that still
contains an opted-out or deleted person must **not** bring them back. The
import checks `suppression` before creating/updating any contact.

> Note: because these are 1:1 personal emails an agent sends from her own
> Gmail (not bulk marketing blasts), the strict marketing-email rules may not
> all apply — but building unsubscribe + suppression anyway keeps us clean and
> is required if we ever sell this as a marketing tool.

---

## Server hardening (holds clients' PII)

- Login gated to a **2-email allowlist**; nothing public.
- Least-privilege Gmail scope (compose/drafts only).
- Secrets server-side only; OAuth tokens + contact PII **encrypted at rest**.
- HTTPS only; secure HTTP-only session cookies; CSRF protection.
- No PII in logs; rate-limited endpoints; encrypted backups.
- Single-tenant; two roles (`admin`, `agent`).

---

## Hosting & database

Served on a **subdomain** of one of the owner's sites (e.g.
`matcher.<yourdomain>`).

**App hosting — default: Vercel.** Cleanest fit for Next.js: custom subdomain,
automatic HTTPS, server-side secrets, serverless API routes. Self-hosting on
the owner's own box (Docker + a reverse proxy for TLS) is a fine alternative
if the other sites already live there — the trade is running updates, certs,
and backups yourself. Decision can follow wherever "substrate"/the other sites
are hosted.

**Database — default: Neon (managed PostgreSQL).** Chosen for security +
operational simplicity:

- **Encryption at rest** and **TLS-only** connections (`sslmode=require`).
- **Automated, encrypted backups** + point-in-time restore.
- Not exposed publicly beyond the app: use private networking where the host
  supports it, otherwise an **IP allowlist** to the app's egress.
- A **least-privilege DB role** for the app (no superuser).
- Branching for safe schema testing without touching prod data.

Supabase (Postgres + Row-Level Security) is an equivalent-security
alternative; we run our own auth so we don't need its extras. If the app is
self-hosted, a **Dockerized Postgres on a private network** (never public,
owner-managed encrypted backups) is acceptable. App-level encryption for Gmail
tokens/PII sits on top of whichever DB is chosen.

---

## Data deletion policy

Two distinct events — **read-only/frozen is never a substitute for delete:**

1. **Deletion request** — a buyer asks to be forgotten, *or* a customer
   explicitly asks to erase their account → **immediate hard purge** of the
   PII. For contacts we keep only a hashed `suppression` tombstone so a
   re-import can't resurrect them; nothing recoverable remains. No grace,
   no read-only limbo.
2. **Subscription cancellation** (future/SaaS) — offer a **data export**, then
   a **frozen recovery window** (log in to export only, no other use) of
   *N* days, after which the data is **hard-deleted**. The window exists so a
   lapsed customer can retrieve their data — it is *not* how a deletion request
   is satisfied, and it is skipped entirely when erasure is requested.
   - Default window: **30 days**, then permanent delete. Adjustable.

---

## Phased build

| Phase | Delivers | Blocker |
|---|---|---|
| **0. Data** | Real (anonymizable) KW Command CSV export | **need from mom** |
| **1. Auth + import** | Google login (allowlist) · CSV upload · upsert w/ suppression check · contacts browser + detail/edit · lifecycle status | Phase 0 |
| **2. Parse** | AI parses notes → buyer profiles · review screen | Phase 1 |
| **3. Match** | Paste listing → ranked matches with reasons | Phase 2 |
| **4. Draft** | Select buyers → personal emails (w/ unsubscribe link) → Gmail Drafts | Google OAuth setup |
| **5. Lifecycle** | Do-not-contact · unsubscribe endpoint · delete-on-request · re-pitch memory | Phase 4 |
| **6. Polish** | Her voice · tags/filters · design pass | — |

---

## Future: selling it (parked, but architected for)

Not built now — recorded so today's decisions leave room for it:

- **Multi-tenant** — flip the 2-email allowlist to self-serve signup; the
  `tenant_id` columns are already in place.
- **Billing** — Stripe subscriptions, trial, tiers.
- **Legal** — Terms of Service, Privacy Policy, **Data Processing Agreement**
  (you'd be a data processor for customers' client PII).
- **Google OAuth verification + CASA** assessment for the restricted
  `gmail.compose` scope (~$500–$4k/yr) — or a copy/paste fallback to avoid it.
- **Anti-spam compliance** — build to strictest (CASL) when we go public.
- **Customer churn / data retention** — see the deletion policy below. On
  cancellation: export offered, a frozen recovery window, then **hard delete**.
  A frozen/read-only window is *not* a delete.

---

## Open items / needed from mom

1. **Sample KW Command CSV** (5–10 rows ok, names/emails can be scrubbed) —
   the real unblocker.
2. **Gmail address** that will send — to set up the Google OAuth app.
3. Confirm the two allowlisted Google accounts.
