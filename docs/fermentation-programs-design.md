# GlassHaus Fermentation Programs — design spec (DRAFT for review)

One-tap fermentation **programs** that drive a tank's setpoint over hours/days on a
schedule that advances by BOTH time and live fermentation conditions (attenuation,
terminal gravity). This is *control*, distinct from the insights feature (*analysis*).

## Where control runs (agreed)
**Home Assistant scripts/automations**, server-side. The GlassHaus app only
TRIGGERS a program and SHOWS its progress. Ramps must keep executing with the
dashboard closed / tablet asleep — so the time-and-condition logic lives in HA
(a program state machine), never in the browser.

## The programs (agreed)
1. **Cold crash** — ramp setpoint down to a target (~34–38°F) to clarify; also set
   tank status → Cold Crashing. (Time-to-target or ASAP.)
2. **Ale profile ramp** — free-rise a few °F over the back third of fermentation.
3. **Modern lager (Brülosophy / Marshall Schott method)** — the rich one:
   - Ferment at ~64°F (ale-ish).
   - **When apparent attenuation ≥ 50%** → ramp **+3–5°F every 6–12h** until **68–69°F**.
   - **Hold 68–69°F until terminal gravity** (gravity flat at/near expected FG).
   - **Hold for a set cleanup period** (diacetyl rest, e.g. 48–72h).
   - **Cold crash.**
4. **Custom ramp builder** — general "ramp from X→Y at +N°F every M h", per batch.

## Key realization: programs are PHASE STATE MACHINES
The lager program isn't a timer — it advances on CONDITIONS we already compute:
- phase transitions gated on `apparent_attenuation` (≥50%), terminal gravity
  (gravity flat near expected FG — reuse the stall/near-terminal logic), and elapsed time.
- So a program = ordered phases, each with: a setpoint target (or ramp rule) + an
  advance condition (time elapsed OR attenuation ≥ X OR gravity terminal OR hold-N-hours).

## Data model (proposed)
Per tank, HA helpers hold the running program state:
- `input_select.tank_N_program` — which program (None / Cold Crash / Ale Ramp / Modern Lager / Custom)
- `input_text` or attributes — current phase, phase-started-at, next-action-at, target setpoint
- Program DEFINITIONS (phases + params) live in an HA script/package (or the app sends them).
An HA automation ticks (e.g. every 15–30 min): reads program state + live gravity/atten,
decides if the current phase's advance condition is met, and if so writes the new
`number.tank_N_setpoint_raw` and advances the phase. Writes are the SAME setpoint entity
the manual control uses.

## App surface
- On a fermenting/crashing tank card: a "Program" control — pick a program, see current
  phase + next step ("Ramp: 66°F → 69°F, +3°F in 4h" / "Holding 68°F until terminal").
- Starting a program is a deliberate action (confirm), like the setpoint SET button.
- Shows progress; a STOP/CANCEL returns to manual setpoint.

## SAFETY (this writes real setpoints over days — be careful)
- Hard min/max setpoint clamp (reuse SetpointControl's 32–80°F guardrails) on EVERY write.
- Max ramp rate cap; never jump more than the configured step.
- A program must be explicitly started + confirmed; easy one-tap CANCEL → manual.
- If gravity data goes stale/signal-lost, PAUSE condition-gated transitions (don't advance
  phases on bad data) — surface as an alert/insight.
- Log every setpoint change the program makes (visible + notifiable).
- Consider: the LLM insights feature can NARRATE program actions ("Lager ramp step 2/4:
  raised to 67°F, holding for attenuation") — nice tie-in, not required for v1.

## Open questions for review
- Program definitions: hardcoded named programs in HA, or app-configurable (custom builder
  needs UI + storage)? Recommend: ship the 3 named programs first, custom builder later.
- Lager ramp params: expose ramp °F/step, interval h, attenuation trigger %, hold temp,
  cleanup hours as per-batch inputs (input_number helpers) with Marshall-method defaults.
- Cold crash: ramp gradually or drop ASAP? (glycol can crash fast; gradual is gentler.)
- Does terminal-gravity detection reuse the existing near-terminal binary_sensor, or need
  a stricter "flat for N hours at/below FG" check for program advancement?

## Build order (once approved)
1. HA: per-tank program helpers + a program-tick automation + the 3 named program definitions
   (setpoint math + phase transitions + safety clamps). 2. Test dry (short intervals) on Tank 1.
   3. App: program picker + phase/progress display + cancel. 4. Custom builder. 5. LLM narration.

See [[glasshaus-alerts-plan]] (setpoint control, status), [[glasshaus-llm-insights]] (narration tie-in).
