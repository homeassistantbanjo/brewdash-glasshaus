# GlassHaus LLM Insights — design spec (DRAFT for review)

Adds an LLM (Claude) layer that turns GlassHaus's raw fermentation data into
plain-language, actionable insights, surfaced to BOTH the phone and an in-app
popup. It augments — never replaces — the deterministic threshold alerts.

## Goals (agreed)
1. **Interpret + advise on alerts** — when a real condition fires (stall,
   excursion, near-terminal, signal-lost, suspect), explain what it likely means
   and what to do, in plain language.
2. **Periodic status digest** — scheduled summary (every 6–12h): where the batch
   is, on-pace or not, what's next (e.g. "cold crash in ~2 days").
3. **Anomaly spotting beyond thresholds** — trends the fixed thresholds miss
   (e.g. attenuation slope flattening early → may finish high).

## Architecture: one brain, two mouths
```
  HA alert fires ─┐                       ┌─→ HA automation → notify.mobile_app_jordans_phone (PHONE)
                  ├─→ ANALYZER (Claude) ──→ sensor.glasshaus_insight ─┤
  cron 6–12h ─────┘   (server-side)         (state+attrs in HA)       └─→ GlassHaus app reads it → in-app popup
```
- **Single analyzer** runs server-side (holds the Claude key — NEVER in the browser).
- Writes ONE HA entity `sensor.glasshaus_insight` (per-tank later: `_tank_N`).
- Both surfaces read that entity → LLM runs once, phone + app stay in sync.
- App change is small: reuse the existing `derivedEntities()` + alert-reading
  pattern to display the insight as a dismissible popup (severity-colored).

## Analyzer service
- **Host:** small container on Unraid (same model as GlassHaus). Env: `ANTHROPIC_API_KEY`,
  `HA_URL`, `HA_TOKEN` (a dedicated scoped HA token). Not in git.
- **Triggers:**
  - *On-alert:* HA automation POSTs a webhook to the analyzer when any
    `binary_sensor.tank_N_*` alert (stalled/temp_excursion/approaching_terminal/
    signal_lost/assignment_suspect) turns on → immediate interpretation.
  - *Digest/anomaly:* internal cron every 6–12h → full-picture summary + trend scan.
- **Gathers from HA:** per active-brew tank — gravity + curve (Brewfather
  `readings[]`, ~100 pts), beer/probe temp + setpoint, OG/expected-FG, pace,
  attenuation, days fermenting, phase, controller/glycol state, which alerts active.
- **Model:** Claude Haiku (cheap; the data is small & structured). Escalate to
  Sonnet only if quality needs it.
- **Output (structured):** `{ severity: info|watch|problem, headline, detail, action, tank }`.
  Written to `sensor.glasshaus_insight` (state=headline; attrs=detail/action/severity/ts).

## Prompt shape
System: "You are an expert brewer analyzing live fermentation telemetry. Be
concise, specific, and actionable. Flag only what matters; say 'nominal' when
fine. Never invent data." User: a compact JSON of the gathered data + the trigger
(alert name or 'digest'). Ask for the structured output above.

## Cost estimate
Haiku, ~few-KB input + short output. On-alert (rare) + digest 2–4×/day ≈ a handful
of calls/day/tank → cents/month at 1 tank, still cheap at 3–5. Guard with a
minimum-interval so alert storms don't spam calls.

## Security
- Claude key + HA token live ONLY in the analyzer container env (Unraid), never
  in git or the browser. Use a DEDICATED, scoped HA long-lived token for the
  analyzer (separate from the dashboard's).
- Insight entity is just text in HA → fine to surface in the app (no key exposure).

## Open questions for review
- Per-tank insight entities from the start, or one global then split? (recommend
  per-tank via the derivedEntities Tank-1-fallback pattern.)
- Digest cadence: 6h vs 12h vs "only when something changed since last digest"
  (change-gated is cheaper + less noisy — recommend).
- In-app popup: DECIDED → **auto-show for `problem` severity; bell/badge (tap to
  open) for `info`/`watch`.** Calm on a wall display, urgent stuff still surfaces.
- Should Jordan be able to ASK (on-demand) later? (out of scope v1; easy to add —
  a notification action / app button that triggers the analyzer.)

## Build order (once approved)
1. Analyzer container (gather → Claude → write insight entity) + prompt, test against
   live data. 2. HA automations (webhook on alerts; notify on insight). 3. App popup
   reading the insight entity. 4. Per-tank split.
