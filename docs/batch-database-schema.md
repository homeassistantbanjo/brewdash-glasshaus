# Batch Database — schema (the complete brewing history of record)

**Status:** DESIGN (schema for review). Storage foundation is BUILT (see below).

## Purpose
A queryable database of EVERY batch's complete measured profile + process + OUTCOME,
so Jordan can correlate process → result → feedback and refine yeast/style profiles.
The "outcomes are the teacher" data made concrete + measurable. Feeds
yeast-profiles-design.md and batch-completion-capture-design.md.

## Storage (BUILT 2026-07-11)
- **`node:sqlite`** (built-in, Node 22.23 in the brewfather container — no dependency).
- DB file at **`/data/batches.db`** — `/data` is a **persistent host volume**
  (`/mnt/user/appdata/glasshaus-brewfather → /data`, mounted + in the dockerman
  template so it survives redeploys). Verified writable. THIS was a prerequisite —
  the container had no persistence, so a DB inside it would've been wiped on redeploy.

## The correlation goal (Jordan's driver — shapes the schema)
Not "a note field." A LONGITUDINAL record: tasting observations over TIME (age +
conditioning days at each), competition scores, feedback — linked to the process
that produced them (the profile/plan run, the actual temp curve). So we can compute:
*"Belle Saison batches finished at 87°F that peaked ~6 weeks scored higher than ones
finished at 84."* That requires time-series tastings + a link to the profile.

## Schema (SQLite tables)

### `batches` — one row per batch (the core record)
```
id                INTEGER PK
batch_no          INTEGER   -- Brewfather batchNo (natural key, unique)
bf_id             TEXT      -- Brewfather _id
name              TEXT      -- recipe/beer name ("Echoes of the Void")
style             TEXT      -- BJCP style name
style_category    TEXT      -- fuzzy category (Saison, Lager...) for profile keying
yeast_name        TEXT      -- "Belle Saison"
yeast_product_id  TEXT      -- "LalBrew Belle Saison"
yeast_type        TEXT      -- Ale / Lager
-- measured values (the "everything measured")
og REAL, fg REAL, abv REAL, attenuation REAL,
mash_ph REAL, boil_gravity REAL,
batch_size_gal REAL, bottling_size_gal REAL,
-- process
profile_id        INTEGER   -- FK → yeast_profiles (which profile/plan produced it), nullable
plan_json         TEXT      -- the actual ferm plan run (steps+advances), snapshot
pitch_temp_f      REAL,
peak_temp_f REAL, avg_temp_f REAL, min_temp_f REAL,
days_primary REAL, days_to_terminal REAL, days_conditioned REAL,
-- lifecycle timestamps (epoch ms)
brew_date INTEGER, ferment_start INTEGER, terminal_confirmed_at INTEGER,
completed_at INTEGER, kegged_at INTEGER,
-- outcome roll-up (denormalized best-of for quick queries; detail in tastings)
best_rating REAL, best_at_age_days INTEGER,
created_at INTEGER, updated_at INTEGER
```

### `readings` — the full temp+gravity time-series (per batch)
```
id INTEGER PK, batch_id INTEGER FK,
t INTEGER,          -- epoch ms
temp_f REAL, gravity REAL,
source TEXT         -- 'tilt_black' etc.
-- index (batch_id, t). This is the raw CURVE for mining/plotting.
```

### `tastings` — LONGITUDINAL tasting/outcome events (the correlation engine)
```
id INTEGER PK, batch_id INTEGER FK,
tasted_at INTEGER,          -- epoch ms of the tasting
age_days INTEGER,           -- age since packaged/kegged at tasting time
conditioning_days INTEGER,  -- days conditioned/aged at tasting
rating REAL,                -- your 1-10 / whatever scale
peaked BOOLEAN,             -- "this is the best it's been" flag
descriptor TEXT,            -- free text: "hot/green", "peaked, malt forward", "fading"
context TEXT                -- 'home' | 'competition' | 'feedback'
-- multiple rows per batch over time → answers "when did it taste best"
```

### `scores` — competition/formal scores (optional, structured)
```
id INTEGER PK, batch_id INTEGER FK,
competition TEXT, score REAL, place TEXT, judged_at INTEGER, feedback TEXT
```

### `events` — key lifecycle events (audit/timeline)
```
id INTEGER PK, batch_id INTEGER FK,
t INTEGER, kind TEXT,   -- 'pitch','crash','status_change','complete','profile_applied'
detail TEXT
```

## What writes when
- **During ferment:** the programs runner already has temp+gravity every tick →
  stream/batch into `readings` (or snapshot the curve at completion — TBD, see Qs).
- **On completion:** populate the `batches` measured/process/summary fields; write
  the writable subset (status→Completed, measuredFg) BACK to Brewfather (the gap we
  found: BF currently has NO completed batches + FG undefined).
- **Anytime after:** Jordan adds `tastings` rows (a "log tasting" UI) + `scores`.

## The payoff query (why the schema is shaped this way)
```
-- how did finish temp correlate with peak rating, for Belle Saison?
SELECT b.batch_no, b.peak_temp_f, b.days_conditioned,
       MAX(t.rating) AS best, MIN(CASE WHEN t.peaked THEN t.age_days END) AS peak_age
FROM batches b JOIN tastings t ON t.batch_id=b.id
WHERE b.yeast_name='Belle Saison'
GROUP BY b.id ORDER BY best DESC;
```
→ surfaces which process produced the best outcomes → refine the profile.

## Open questions
- readings: stream live during ferment, or snapshot the whole curve once at
  completion? (Live = richer + survives if a batch never "completes" cleanly;
  snapshot = simpler. Lean live-stream, downsampled.)
- Backfill: import the ~existing batches (144, 137, past medal winners) so mining has
  history from day 1?
- tasting UI: where — a GlassHaus "log tasting" panel per batch.
- profile_id link: needs yeast-profiles built first to be meaningful (nullable now).
