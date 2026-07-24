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

## Who it's for

- **Agent (mom)** — uploads CRM exports, browses contacts, matches listings,
  generates and reviews email drafts.
- **Admin (Jordan)** — everything the agent can do, plus manages the login
  allowlist and app config.

Exactly **two Google accounts** may sign in (hard allowlist). Everyone else
is rejected.

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

- **contact** — `id`, `crm_id?`, `name`, `email`, `phone`, `raw_fields (jsonb)`,
  `source_notes (text)`, `created_at`, `updated_at`, `hand_edited (bool)`
- **buyer_profile** — `contact_id`, `price_min`, `price_max`, `beds_min`,
  `baths_min`, `location[]`, `must_haves[]`, `nice_to_haves[]`,
  `lifestyle_tags[]`, `dealbreakers[]`, `confidence`, `edited_by_user (bool)`
- **listing** — `id`, `raw_text`, `address`, `price`, `beds`, `baths`,
  `features[]`, `created_at`
- **match** — `listing_id`, `contact_id`, `score`, `reasons[]`, `status`
- **email_draft** — `match_id`, `subject`, `body`, `gmail_draft_id`,
  `status (draft/sent)`, `created_at`

**Upsert on re-import:** key = email (or `crm_id` if present). Update raw CRM
fields; re-parse a profile only when notes changed; **never overwrite a field
the agent edited by hand** (`edited_by_user`). Show a diff before commit:
"14 updated · 3 new · 2 changed notes — re-parse those?"

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

## Server hardening (holds clients' PII)

- Login gated to a **2-email allowlist**; nothing public.
- Least-privilege Gmail scope (compose/drafts only).
- Secrets server-side only; OAuth tokens + contact PII **encrypted at rest**.
- HTTPS only; secure HTTP-only session cookies; CSRF protection.
- No PII in logs; rate-limited endpoints; encrypted backups.
- Single-tenant; two roles (`admin`, `agent`).

---

## Phased build

| Phase | Delivers | Blocker |
|---|---|---|
| **0. Data** | Real (anonymizable) KW Command CSV export | **need from mom** |
| **1. Auth + import** | Google login (allowlist) · CSV upload · upsert · contacts browser + detail/edit | Phase 0 |
| **2. Parse** | AI parses notes → buyer profiles · review screen | Phase 1 |
| **3. Match** | Paste listing → ranked matches with reasons | Phase 2 |
| **4. Draft** | Select buyers → personal emails → Gmail Drafts | Google OAuth setup |
| **5. Polish** | Her voice · re-pitch memory · tags/filters | — |

---

## Open items / needed from mom

1. **Sample KW Command CSV** (5–10 rows ok, names/emails can be scrubbed) —
   the real unblocker.
2. **Gmail address** that will send — to set up the Google OAuth app.
3. Confirm the two allowlisted Google accounts.
