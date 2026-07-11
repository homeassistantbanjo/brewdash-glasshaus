# Yeast Temp Profiles — tying Jordan's OWN experience into ferm-plan generation

**Status:** DESIGN (not built). Review before implementing.

## The problem
The ferm-plan generator (brewfather container → Claude) produces temp-step plans
from GENERIC expertise (Brülosophy, yeast-lab guidance, strain spec) advancing on
real attenuation. Good, but it doesn't know Jordan's OWN, dialed-in, strain+style-
specific process — which for strains he's mastered beats the textbook default.

Motivating example (Jordan's words):
> "Belle Saison: pitch at 68, let it sit 12–24h, then free-rise up to 80–83 …
>  and finishing out generally allow up to 86–88."

That's not a rigid profile and not something Claude reliably invents — it's an
empirical STRATEGY expressed as **temp ranges + phase shape + conditional advances**:
cool pitch → hold-until-it-starts → aggressive free-rise → hot finish to dry out.

## Philosophy: experience is the SEED, outcomes are the TEACHER (don't front-load)
Jordan's question: "should I build all my temp profiles from experience?" Answer:
**No — build profiles only where experience genuinely earns it; let the generator
cover the long tail; and let profiles ACCUMULATE from real batch outcomes over time.**

Three knowledge sources, each with a job:
- **Jordan's experience** — authoritative ONLY for strains brewed repeatedly + dialed
  in (Belle Saison: "generally up to 86–88" = a repeated pattern, trustworthy).
  DANGEROUS for one-off recollections — a single memorable batch might be luck / a
  different OG / cooler ambient. Encoding a one-off as gospel bakes in a mistake.
- **Generator (Claude)** — a solid, safe DEFAULT for un-mastered/new strains. Never
  optimal, but always available. Covers the long tail so Jordan doesn't hand-author
  30 profiles from memory.
- **Lab/manufacturer spec** — GUARDRAILS (min/max temp, expected attenuation), not a
  plan. (Note: a Jordan profile is allowed to EXCEED the stated max — see open Qs.)

Practical stance, and it shapes the BUILD (emphasis shift: "accumulate" not "author"):
- Profile only the 2–3 strains Jordan is confident on NOW (Belle Saison first).
- Everything else: run the generator; do NOT pre-build.
- **Refine per-batch** ("finish ran hot, cap at 86 next time") so a profile CONVERGES
  toward the best process across batches instead of being a one-shot guess.
- **Promote great generated plans → profiles** (the save-as-profile loop): even
  un-mastered strains accrue dialed-in profiles built from OUTCOMES, not memory.
- Therefore the versioning / refine / save-as-profile loop is CORE, not a nice-to-
  have — it's what keeps the library honest and growing from results.
- Over-fit caution (enforce in UI): if a strain has few recorded batches, nudge
  toward the generator + "brew a couple more before profiling," not an instant profile.

## The key insight
**Jordan's knowledge = the SHAPE and the GUARDRAILS. The engine's job = the TIMING.**
He knows the phase shape and temp ranges; he does NOT want to hand-specify "advance
at hour 19" (that depends on how the batch actually ferments). So "hold 12–24h"
really means "hold until fermentation starts" — which maps onto the EXISTING
attenuation-advance engine (advance types: attenuation / attenuationOfExpected /
progressToFg / terminal / active / elapsed). Capture intent + ranges; let the engine
run the clock.

## Decisions (locked with Jordan)
1. **Model = profile-overrides-generator, with fallback + always-editable.**
   Resolution when a batch is assigned:
   `(yeast, style-category) profile` → `(yeast, default) profile` → Claude generates.
   Whatever resolves lands in the EXISTING FermPlanEditor for per-batch tweaks.
2. **Keying = TWO levels: yeast → style-category.** Same strain behaves differently
   by style (Belle Saison in a light table saison vs. dark/strong saison vs.
   farmhouse). A flat per-yeast profile is too coarse.
3. **Style matching = FUZZY / category.** Profile carries a loose category
   ("Saison", "Farmhouse", "Hazy IPA"); a batch's specific BJCP style fuzzy-matches
   to the nearest category (keyword/family map). Keeps profile count low.
4. **Authoring = describe → Claude structures → approve.** Jordan types the strategy
   in plain language; Claude converts to temp-steps + attenuation-advance triggers
   ONCE; he reviews/edits in the editor; saves under (yeast, category). After that,
   assigning that yeast+style uses HIS profile verbatim — no Claude call, no drift.
5. **Storage = brewfather container**, keyed by yeast identity (name + productId) →
   category. (Confirmed keying; storage substrate to finalize at build — SQLite or
   a JSON file in the container, mirroring how the generator already reads yeast.)

## Worked example — Belle Saison, fully specified (Jordan's exact mechanics)
> "Once ferm starts, hold for X time AND gravity; free-rise to 80–83 until 75%
>  attenuation; then ramp to 86–88 increasing 1°F every 4 hours."

Decomposed against the ENGINE primitives:
| Step | Jordan's spec | Engine mapping | Status |
|---|---|---|---|
| 1 pitch/hold | hold @ 68 until ferm starts, ≥X hrs AND gravity moved | `hold`, advance = **compound** (elapsed≥X AND atten≥N) | ⚠ NEW: compound |
| 2 free-rise | rise to 80–83, hold until 75% atten | `ramp`/`hold` tempF 80-83, advance `attenuationOfExpected pct:75` | ✅ exists |
| 3 finish | ramp to 86–88, **+1°F every 4h** | `ramp` `{targetF:87, stepF:1, everyHours:4}`, advance `terminal` | ✅ EXISTS |

**Key correction:** the gradual timed ramp ("+1°F / 4h") is ALREADY supported —
`statemachine.mjs` `case 'ramp'` steps the setpoint by `stepF` every `everyHours`
based on phase elapsed, capped at `targetF`. NOT a gap. Only step 1's compound
advance is new.

## THE one required engine extension: COMPOUND advance conditions
Today a phase has ONE `advance` condition. Jordan needs `elapsed ≥ X hours AND
attenuation ≥ N%` (a "time floor + gravity is the real trigger" — and it VARIES by
strain, so it must be expressible, not hardcoded). Extend the advance schema:
```
advance: { all: [ {type:'elapsed', hours:18}, {type:'attenuationOfExpected', pct:20} ] }
advance: { any: [ {type:'elapsed', hours:36}, {type:'attenuationOfExpected', pct:75} ] } // OR/timeout
advance: { type:'attenuationOfExpected', pct:75 }   // single still works (back-comp)
```
Small change in `statemachine.mjs` `phaseComplete`: if `advance.all`/`advance.any`,
evaluate each sub-condition and combine. All existing single-condition advances keep
working unchanged. This is the FOUNDATION that makes strain-specific hold logic
possible — build it FIRST, then profiles use it.

## Data model (draft)
```
profile = {
  yeast:   { name: "Belle Saison", productId: "LalBrew Belle Saison" },  // match key
  category: "Saison",              // fuzzy style category this profile applies to
  isDefault: false,                // true = the (yeast, *) fallback
  source: "jordan",                // vs "claude" — provenance
  createdFrom: "freeform: pitch 68, hold 12-24h, free-rise 80-83, finish 86-88",
  steps: [                          // SAME shape the runner/editor already consume
    { name: "Pitch/hold",  tempF: 68,    advance: { type: "active", ... } },   // hold until it STARTS
    { name: "Free rise",   tempF: [80,83], advance: { type: "attenuationOfExpected", pct: 60 } },
    { name: "Finish",      tempF: [86,88], advance: { type: "terminal" } },     // hot dry-out
    // (cold crash appended/gated by the engine as today)
  ],
}
```
Note tempF supports a RANGE `[lo,hi]` (Jordan thinks in ranges: 80–83, 86–88). The
runner sets setpoint to the range's target (lo to start a step, allowed drift to hi);
exact setpoint semantics TBD — could target lo and let it free-rise toward hi.

## Resolver (the match + fallback)
```
on assign(batch):
  y = recipe.yeasts[0]  (name+productId)
  s = recipe.style.name
  cat = fuzzyCategory(s)                       // 'Belgian Saison' → 'Saison'
  profile = find(yeast==y, category==cat)       // exact yeast + fuzzy category
         || find(yeast==y, isDefault)           // yeast default
         || null
  plan = profile ? profile.steps : claudeGenerate(y, s, og, fg)
  → load plan into FermPlanEditor (editable) → Accept → runner runs it
```
fuzzyCategory: keyword/family map — Saison/Farmhouse/Brett → "Saison-family";
NEIPA/Hazy/Juicy → "Hazy IPA"; Pils/Helles/Lager → "Lager"; etc. Start small, grow.

## Authoring flow (describe → structure → approve → save)
1. Jordan opens "New profile" for a yeast, picks/enters a style category, types his
   strategy freeform.
2. brewfather container → Claude: "convert this strategy into temp-steps with
   attenuation-advance triggers, honoring the ranges/ceilings; respect strain min/max
   temp; add gated cold crash." Claude returns the structured steps.
3. Steps load into the FermPlanEditor — Jordan tweaks temps/thresholds/order.
4. Save → stored as (yeast, category) profile, source:"jordan".
5. LOOP-CLOSE: from any batch's editor, "Save these steps as the (yeast, category)
   profile" — so per-batch edits he likes become next time's default (captures
   experience as he brews).

## Integration points (reuse, don't duplicate)
- Generator (brewfather/server.mjs `generatePlan`): add a resolver step BEFORE calling
  Claude — if a profile matches, return it instead of generating.
- FermPlanEditor.tsx: already the accept/edit surface — add "Save as profile" + a
  profile picker/manager.
- Runner (programs/runner.mjs): consumes `sensor.tank_N_program_plan` steps as today —
  NO change needed if profile steps use the same step schema (they do). tempF ranges
  are the one addition to teach the runner.
- Advance engine (statemachine.mjs): already supports the needed advance types.

## Open questions for build
- tempF RANGE semantics in the runner: target lo and allow free-rise to hi? or step
  the setpoint lo→hi over the phase? (Belle Saison "free-rise to 80–83" implies:
  set a ceiling, let exotherm carry it up.)
- fuzzyCategory map: seed list + how Jordan extends it.
- profile versioning: keep history when he re-saves? (probably keep last-N for undo.)
- multi-yeast recipes: which yeast keys the profile (today: first/most-attenuative).
- does a profile PIN temps (ignore strain min/max) or still clamp? Jordan's 86–88 on
  Belle Saison EXCEEDS many "recommended maxes" intentionally — profiles must be
  allowed to override the strain's stated max (that's the whole point of his
  experience). So: profile temps WIN over strain spec.
```
```
