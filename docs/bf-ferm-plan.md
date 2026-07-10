# GlassHaus — Claude-Generated Fermentation Plans (from Brewfather + strain knowledge)

**Status:** DESIGN (not built). Review before implementing.

## The problem
Jordan wants Brewfather's fermentation schedule to *inform* GlassHaus, not dominate
it — use the recipe's intended temp-step *shape*, but advance between steps on
**real gravity/attenuation data**, not the calendar (a slow start shouldn't desync
the schedule). Crucially, the right advance threshold depends on **yeast strain and
style** — "50% attenuation" is too high for some, too low for others. Maintaining a
hand-curated database of hundreds of strains is untenable.

## The insight (Jordan's idea)
Don't maintain a strain database, and don't hardcode thresholds. **Two facts make
this solvable:**
1. **Brewfather already carries the strain's spec per batch** — verified on batch
   #141: `yeasts[0] = {name:"Safale American", productId:"US-05", type:"Ale",
   attenuation:81, minTemp:12°C, maxTemp:25°C, flocculation:"Medium"}`. Plus recipe
   style, OG, FG.
2. **Claude already knows brewing practice** (Brülosophy method, per-strain behavior)
   from training. We already run the analyzer container + Claude API.

So: at the moment a batch goes into a fermenter, **Claude generates a recommended
fermentation plan** from the strain + style + gravities. No database, covers any
strain, style-aware.

## Advance basis (decided)
Advance triggers = **% of the STRAIN'S OWN expected attenuation**, not an absolute
number. E.g. "free-rise when apparent attenuation reaches ~80% of this strain's
expected 81% (≈65% AA absolute)." Self-adjusts per strain — the core fix for
"50% is high sometimes, low others." The engine already computes apparent
attenuation; the plan just parameterizes the threshold relative to the yeast spec.

## Flow (decided: propose → FULL EDIT → run)
1. Batch assigned to fermenter (or a "Suggest Ferm Plan" button in ⚙ Manage / Brew Day).
2. Analyzer `POST /fermplan` with {yeast spec, style, og, fg, current temp}.
3. Claude returns a structured plan (schema below) with per-step *reasoning*.
4. **FIRST-CLASS PLAN EDITOR** (not just number-nudging) — Jordan can:
   - edit each step's **temperature**
   - edit each step's **advance threshold** (attenuation-of-expected %, or switch to
     'terminal' / manual-confirm)
   - **add / remove / reorder** steps (insert a 2nd D-rest, drop one, reorder)
   - toggle **requiresConfirm** gating on any step (also gate conditioning if wanted)
   Claude's reasoning per step stays visible as guidance while editing.
5. On accept → the (edited) plan is written to the program engine as a running program.
6. Engine drives setpoints exactly as presets do. **Cold-crash / packaging steps stay
   GATED** (requiresConfirm) — never auto-crash; Jordan taste-confirms first.
7. **Edits apply to THIS BATCH ONLY** — no saved-plan library to manage. Next batch,
   Claude proposes fresh (different beer/yeast anyway). Presets remain available; this
   is an additional source, "informative not dominant."

## The edited plan needs somewhere to live (per-batch, survives reboot)
A generated+edited plan is JSON, not a named preset — so it can't just be an
input_select value. Store it in a per-tank `input_text.tank_N_program_plan` (JSON
string) — HA restores input_text across reboot (matches the batch-persistence
pattern), and `resolveProgram` in the runner reads it when the program picker is set
to "Custom/Generated". Keeps the reboot-proof principle.

## Plan schema (Claude output → program engine)
Reuses the existing engine primitives (hold|ramp|wait|coldCrash) + advance conditions.
New advance type `attenuationOfExpected` (pct-of-strain-spec). Claude returns:
```
{
  "summary": "US-05 West Coast IPA — clean ale free-rise, gated crash after taste",
  "clamp": { "minF": 32, "maxF": 75 },
  "phases": [
    { "name":"pitch",   "kind":"hold", "tempF":64,
      "advance": { "type":"active" }, "why":"pitch cool, let it establish" },
    { "name":"primary", "kind":"hold", "tempF":66,
      "advance": { "type":"attenuationOfExpected", "pct":80 },
      "why":"hold mid-60s until ~80% of US-05's 81% expected attenuation" },
    { "name":"free-rise","kind":"ramp","stepF":2,"everyHours":12,"targetF":70,
      "advance": { "type":"terminal" }, "why":"free-rise to finish + clean up" },
    { "name":"condition","kind":"wait","hours":48,
      "why":"hold near FG; taste before crashing" },
    { "name":"crash",   "kind":"coldCrash","targetF":34,"stepF":6,"everyHours":12,
      "requiresConfirm": true, "why":"GATED — only after you taste & confirm ready" }
  ]
}
```

## What to build
1. **derived.mjs / statemachine.mjs:** add advance type `attenuationOfExpected`
   (needs the strain's expected attenuation passed through — from BF yeast spec).
2. **analyzer:** `POST /fermplan` — gathers the batch's yeast+style+gravities, calls
   Claude with a Brülosophy/industry-grounded system prompt, returns the plan schema
   (validated). Same data-literacy discipline as the insight prompt.
3. **runner/programs:** accept a "generated" program (stored as JSON in an input_text
   or the program-status entity) alongside the named presets; `resolveProgram` picks
   it up. Clamp still enforced every write; crash still gated.
4. **UI — the plan EDITOR** (a proper editor, the meatiest UI piece):
   - "Suggest Ferm Plan" button (Brew Day assign step + ⚙ Manage program picker)
   - renders each step as an editable row: temp field, kind, advance-trigger picker,
     requiresConfirm toggle, Claude's `why` shown as guidance
   - add-step / delete / drag-reorder controls
   - clamp shown + editable; live "this would run: hold 66°F → …" preview
   - Accept → serialize to JSON → write input_text.tank_N_program_plan + set the
     program picker to "Generated" → engine runs it.
5. **runner resolveProgram:** when program = "Generated", parse the plan JSON from
   input_text.tank_N_program_plan instead of the PRESETS map. Everything downstream
   (clamp, tick, gated crash, attenuationOfExpected advance) is identical.

## Guardrails (unchanged from presets)
- Per-plan setpoint clamp enforced on EVERY write (Claude proposes clamp from strain
  minTemp/maxTemp; lager still capped ≤70°F per Jordan).
- Cold-crash ALWAYS requiresConfirm (Jordan: never crash before conditioning done +
  tasted). Consider gating conditioning entry too (deferred question).
- Plan is a STARTING POINT — Jordan edits before it runs, can ignore for a preset.
- Rate/cost: one Claude call per plan-generation (on assign or button), not periodic.

See [[glasshaus-fermentation-programs]], [[glasshaus-brewfather-brewday]], [[glasshaus-llm-insights]].
