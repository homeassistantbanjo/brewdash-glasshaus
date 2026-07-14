# Keg Management — design

Status: **design approved, not yet built** (2026-07-14). The taplist board (Pi 5 kiosk)
is a downstream READ VIEW of this system; build kegs first.

## Goal
Track the keg fleet as first-class objects: identity, status, per-seal-type o-ring life,
cleaning, current beer — with a full activity **log**, driven by **QR-scan-to-log** from a
phone. Mirror a summary to HA for alerts + the future taplist.

## Architecture (decided)
GlassHaus is a client-only SPA (no backend), so kegs get a dedicated sidecar service —
same shape as the existing `analyzer/` and `brewfather/` services.

```
kegs/  (new sidecar, zero-dep Node, node:sqlite on /data — mirrors brewfather/db.mjs)
  ├─ db.mjs        SQLite store: kegs + keg_events (append-only log). /data/kegs.db, WAL.
  ├─ kegs.mjs      domain logic: status transitions, seal-age/clean-age computation,
  │                due-flags, QR payload. PURE + unit-tested (like derived.mjs).
  ├─ server.mjs    HTTP: keg pages + JSON API + HA mirror push. (pattern: analyzer/server.mjs)
  ├─ qr.mjs        QR SVG generation per keg id (tiny, dep-free numeric/byte QR).
  ├─ *.test.mjs
  ├─ Dockerfile    node:22-alpine, EXPOSE 8097, -v /data
  └─ package.json

GlassHaus SPA  ──reads/writes──▶  kegs service  ──mirrors──▶  HA sensor.keg_*  ──▶ alerts
   (Kegs tab on brew page)          (system of record)                         └▶ taplist board
QR sticker  ──scan──▶  /keg/:id  (served by kegs service; the keg's page + quick actions)
```

Deploy: nginx (the GlassHaus `deploy/` reverse proxy) routes `/kegs/*` → kegs:8097, same
as it proxies the other sidecars. Data on the array-backed `/data` volume (survives redeploys).

## Data model
```
kegs
  id            TEXT PK      -- permanent, e.g. "keg-001"; encoded in the QR. NEVER changes.
  label         TEXT         -- friendly, editable ("Keg 1", "Hazy dispensing keg")
  type          TEXT         -- corny-ball-lock | corny-pin-lock | sanke | ...
  size_l        REAL         -- 19 (5gal) etc. (volume TRACKING deferred, but size is identity)
  purchased_at  TEXT
  status        TEXT         -- dirty | clean | filled | tapped | empty | retired
  tap           INTEGER      -- which tap when status=tapped, else NULL
  -- current contents (NULL unless filled/tapped)
  beer_batch    TEXT         -- Brewfather batch name/no (matches tank batchAssign convention)
  beer_style    TEXT
  beer_abv      REAL
  filled_at     TEXT
  -- seals: per-type replace dates + lifespans (days). due = now - replaced >= life.
  lid_seal_at   TEXT   lid_seal_life   INTEGER DEFAULT 730   -- ~2yr
  post_seal_at  TEXT   post_seal_life  INTEGER DEFAULT 365
  dip_seal_at   TEXT   dip_seal_life   INTEGER DEFAULT 365
  -- cleaning: last clean + type; a clean "expires" (sitting clean keg needs re-sanitize)
  cleaned_at    TEXT   clean_type TEXT   clean_life INTEGER DEFAULT 30
  retired_at    TEXT   notes TEXT

keg_events  (append-only LOG — the backbone; age/cadence computed from here)
  id        INTEGER PK AUTOINCREMENT
  keg_id    TEXT  FK
  at        TEXT
  action    TEXT   -- cleaned | seal-replaced | filled | tapped | emptied | retired | note | created
  detail    TEXT   -- JSON: e.g. {sealType:"lid"} or {batch:"Hazy IPA #42", cleanType:"caustic"}
```
Seal age & clean age are DERIVED from the latest relevant event/date, not hand-maintained.

## Status transitions (enforced in kegs.mjs, logged to keg_events)
```
created → dirty
dirty ──clean──▶ clean ──fill──▶ filled ──tap──▶ tapped ──empty──▶ empty ──▶ dirty
any ──retire──▶ retired      (retired is terminal until un-retired)
```
Each transition appends an event. Refilling logs a new `filled` (with the new batch) so the
log tells the whole life story.

## QR system (how "scan → the specific keg" works)
- Each keg's QR encodes a URL with ITS id: `https://<glasshaus>/kegs/keg-001`.
- Scanning keg-007's physical sticker opens `.../kegs/keg-007` — the id is IN the code, so
  it's unambiguous: the sticker IS the identity. No pick-from-list step.
- `qr.mjs` renders the QR SVG per id; each keg page has a "Print label" action.
- The `/kegs/:id` page shows full state + quick-action buttons (Mark cleaned, Replace seal
  [lid/post/dip], Tap → tap#, Set beer, Mark empty, Retire). Each button POSTs an event.
- Plain URL → works with any phone camera, no app, guest-friendly.

## HA mirror + alerts (decided: yes)
Push per-keg summary to HA sensors on every change:
  sensor.keg_001_status, sensor.keg_001_beer, sensor.keg_001_seal_due (lid/post/dip),
  sensor.keg_001_clean_age_days, sensor.keg_001_tap
Alerts ride the notify path already built (edge-triggered):
  - any seal overdue → warning
  - a keg empty-and-dirty > N days → "clean it" nudge
  - clean expired on a filled keg → warning
(These are computed in kegs.mjs and surfaced; the HA automation/notify wiring reuses the
existing lifecycle so it doesn't spam.)

## Tap lines (added 2026-07-14)
Beer lines are FIXED plumbing (Tap 1–8), distinct from kegs, that need periodic cleaning
(~every 2 weeks / between kegs — biofilm/bacteria). Second small registry in the service:
```
tap_lines
  tap          INTEGER PK        -- 1..8
  label        TEXT
  cleaned_at   TEXT              -- last LINE clean
  clean_life   INTEGER DEFAULT 14
  current_keg  TEXT              -- keg-id currently on this tap (convenience mirror)
  notes        TEXT
tap_events (append-only, like keg_events): line-cleaned | keg-connected | keg-disconnected
```
Synergy: tapping a keg onto Tap N checks that tap's line-clean age → warns "line cleaned
18d ago, clean it first?" HA mirror: sensor.tap_N_line_clean_age_days + a due flag.

## QR — corrected approach (2026-07-14)
A hand-rolled QR encoder produced structurally-valid-but-UNSCANNABLE output (verified by
decoding with jsQR — it failed). Since stickers are printed permanently, correctness is
non-negotiable. Decision: generate QR SVGs at BUILD/SEED time with the mature `qrcode` lib
(verified to decode correctly), bake the static SVGs into the image. Runtime stays zero-dep
(serves pre-generated files); QR content is permanent per keg so runtime generation was never
needed. gen-qr.mjs (build tool, not shipped) generates + verifies each SVG.

## v1 scope (this build)
IN: registry CRUD, status lifecycle, per-seal-type tracking, cleaning (+type/expiry),
current-beer, append-only log, QR pages + print, HA mirror + alerts, a "Kegs" section on
the brew page listing the fleet with due-flags.
OUT (deferred): volume / how-full (lands with the taplist + flow meters), the bar-top board.

## Kegging handoff — TANK → KEG (added 2026-07-14)
Kegging is the moment a beer leaves the tank world and enters the keg world — the natural
place to assign the beer to keg(s). "Keg this batch" action (on the tank/brew page):
1. Source the beer from the TANK's assigned Brewfather batch (name/style/ABV/**volume**).
   Beer identity flows from the tank; never re-typed. Batch volume → SUGGEST keg count
   (e.g. 10gal → ~2×19L kegs); user picks 1–N clean kegs (decided: usually 1–2).
2. Each chosen keg: clean → filled, stamped with that beer + fill date + a `filled` event
   whose detail links the source batch (traceability: which tank/batch this keg holds).
3. Tank: PROMPT to free it (→ dirty/empty, clear batchAssign) — the beer's gone. Skippable.
4. Fill NOW, tap LATER (decided): kegging sets `filled`; tapping onto a faucet is a separate
   action when ready to serve (beer usually conditions/carbonates first).
Domain: kegBatch() in kegs.mjs composes the per-keg fill patch+event from a batch summary.

## Taplist hand-off (future)
The taplist reads tapped kegs (status=tapped) from this service (or the mirrored HA sensors)
→ "On Tap: Tap 2 = Hazy IPA (keg-001)". Kegs is the taplist's data source.
