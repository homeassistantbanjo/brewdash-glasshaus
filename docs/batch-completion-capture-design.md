# Batch Completion Capture — temp history + Brewfather write-back

**Status:** DESIGN (not built). Review before implementing.

## Goal (Jordan)
When a batch concludes (enters Complete): (1) capture the ENTIRE fermentation temp
history so it's useful in GlassHaus AND informs future batch creation AND is mineable
later; (2) make sure Brewfather gets the values it's supposed to on completion.

## TESTED Brewfather API write limits (probed live 2026-07-11 — not assumed)
- **✅ WRITABLE (PATCH /batches/:id):** `status`, `measuredFg`/`measuredOg`/other
  measured gravities, pH, volumes. (BF computes ABV/attenuation from OG+FG itself.)
- **❌ SILENTLY IGNORED (returns HTTP 200 + body "Nothing to update", value does NOT
  persist):** `batchNotes`, `notes` (the notes array is a device/event log, not
  free-text), any notes/comment/custom text field.
- **Consequence:** there is NO API path to store a temp-history summary INSIDE
  Brewfather (not notes, not a custom field, not readings — readings are device-only).
  Do not try; it 200s into the void.

## CURRENT STATE (checked live) — the completion write-back is NOT wired
- **0 Completed batches** in Brewfather — nothing has ever been advanced to Complete
  via our path (the auto-flip only does Fermenting→Conditioning).
- Conditioning batches (#144, #137) have `measuredOg` set but **`measuredFg=undefined`**
  — final gravity is never written back, though the Tilt/GlassHaus knows it (~terminal).
So two writable fields ARE missing on completion. This is a real gap to fill.

## Design — split by what BF will accept

### A. Sync to Brewfather on completion (WRITABLE fields only)
On a batch entering Complete (or terminal-confirmed → ready to complete):
- PATCH `status` → `Completed`.
- PATCH `measuredFg` = the Tilt's confirmed terminal gravity (GlassHaus already
  computes this: derived `terminalConfirmed` + the stable gravity). BF derives
  ABV + attenuation from OG+FG automatically.
- Same one-shot-latch + Tier discipline as the Fermenting→Conditioning auto-flip
  (guard: only if BF status is currently Conditioning; latch so it fires once).
- Open Q: is Complete AUTO (on terminal + conditioning-days elapsed → readyToKeg)
  or MANUAL (a "Complete batch" button)? Leaning manual/confirmed — completion is a
  human decision (you actually kegged it), unlike the automatic Fermenting→Conditioning.

### B. Archive the full temp history in GlassHaus (BF can't hold it)
GlassHaus/HausWatch already HAS the full temp+gravity curve (Tilt + derived data).
On completion, archive a per-batch record:
```
batchArchive = {
  batchNo, name, yeast{name,productId}, style, og, fg, abv,
  fermentingStart, completedAt,
  curve: [{t, tempF, gravity}...],        // the full series
  summary: { pitchTempF, peakTempF, avgTempF, minTempF,
             daysPrimary, rampProfile: [...], daysToTerminal },
}
```
Stored where GlassHaus can serve it (brewfather container store, or a GlassHaus
data file). Keyed by batchNo + yeast + style.

### Why B matters (ties to yeast-profiles-design.md)
This IS the "outcomes are the teacher" data. When Jordan profiles a yeast, GlassHaus
shows *"here's how your last N Belle Saison batches actually behaved"* — real curves,
not memory → the over-fit protection made concrete. And at BF batch-CREATION time,
Jordan consults GlassHaus's per-yeast history (richer than a text blob would've been
in BF anyway). Mineable later for cross-batch patterns.

## Open questions
- Completion trigger: manual "Complete" button vs auto on readyToKeg? (lean manual.)
- Where GlassHaus stores the archive (container SQLite vs JSON files) + retention.
- measuredFg source: the confirmed terminal gravity — snapshot at completion.
- Does completing also free the tank (status → Dirty/empty) in GlassHaus? (probably.)
