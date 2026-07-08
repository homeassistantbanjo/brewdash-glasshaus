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

## Phase primitives (builder + presets share these)
Every program is an ordered list of phases. Each phase = one primitive + params +
an advance condition. Primitives:
- **hold** {tempF, until: time|attenuation|terminal|manual} — sit at a temp until a condition.
- **ramp** {stepF, everyHours, targetF} — step temp toward target by stepF each interval.
- **wait** {hours} — hold current temp for a duration (e.g. cleanup/D-rest window).
- **coldCrash** {targetF (~34-38), mode: gradual(stepF/everyHours) | asap} — drop to clarify.
Advance conditions available to any phase: `attenuation >= X%` (apparent), `terminal`
(gravity flat near expected FG for N h), `elapsed >= H hours`, `manual`.

### GATED phases (require explicit confirmation) — Jordan's rule
A phase can be marked `requiresConfirm: true`. When the program reaches it, it does
NOT auto-run — it PAUSES, sets program state to "awaiting confirm", and prompts
(phone notification + in-app button). Nothing happens to the setpoint until Jordan
taps confirm. **The COLD CRASH phase is always gated by default** — crashing is a
point-of-no-return (deciding the beer is done), so the program holds at the end of
cleanup/D-rest and waits for "Confirm crash" before dropping temp. (Jordan can also
decline / extend the hold, or crash early manually.) Confirmation is delivered by
writing to an `input_button`/`input_boolean` the tick automation checks, and/or a
notification action.

## Researched preset library (step-patterns, style-family not yeast-specific)
Numbers grounded in current practice (Brülosophy Lager Method; BYO; homebrew consensus) —
all params are DEFAULTS the builder can override per batch.

1. **Ale — standard free-rise + D-rest**
   - hold pitchTempF (≈2°F below target) until fermentation active
   - hold targetF (64–68°F) until **~75% progress to FG**
   - ramp free-rise +2°F/12h to targetF+3 (D-rest), hold until **terminal**
   - wait 48h (cleanup) → done (or → cold crash)
2. **Lager — Brülosophy fast/quick method** (your classic)
   - hold 50–55°F until **50% attenuation**
   - ramp +5°F/12h until 65–68°F (D-rest)
   - hold until **terminal** + clean (no diacetyl)
   - coldCrash gradual −5–8°F/12h to 32°F, wait 3–5 days
3. **Lager — modern "ale-temp" (Marshall/Brülosophy newer)** (YOUR method)
   - hold ~64°F until **50% attenuation**
   - ramp +3–5°F/6–12h until 68–69°F
   - hold 68–69°F until **terminal**
   - wait <cleanup hours> (D-rest) → coldCrash
4. **Kveik — warm & fast**
   - hold high (85–95°F) until **terminal** (kveik loves heat, no D-rest needed)
   - → cold crash optional
5. **Cold crash only** — coldCrash to 34–38°F (gradual or asap), set status → Cold Crashing.
6. **Custom** — user composes phases from the primitives above; save as a named preset.

### CONFIRMED default params (Jordan, 2026-07-08) — overridable per batch:
- **Ale:** pitch 64°F, hold 66°F, free-rise at 75% progress-to-FG, +2°F/12h → 69°F D-rest, terminal, 48h cleanup.
- **Lager (Brülosophy fast):** pitch/hold 52°F to 50% atten, +5°F/12h → 66°F, terminal.
- **Lager (modern ale-temp = Jordan's):** base **64°F** to 50% atten, ramp **+5°F/12h → 69°F**,
  hold terminal, **72h** cleanup, then cold crash.
- **Kveik:** hold 90°F to terminal.
- **COLD CRASH (all presets):** gradual **−6°F/12h**, target **34°F**.
- Attenuation trigger via `sensor.apparent_attenuation`; terminal via a "flat for N h at/below
  expected FG" check (stricter than the near-terminal alert).
- SAFETY: setpoint clamp is **PER-PROGRAM**, set as a TIGHT net just above each program's max
  target (not a loose global). Researched (2026-07-08): lager D-rest consensus tops at 65–68°F,
  72°F is too high — so **lager clamp = {32, 70}** (targets top at 69). ale `{32, 72}` (D-rest 69),
  kveik `{32, 98}` (holds 90; needs the high ceiling a global would cap), cold-crash-only
  `{32, 45}`, custom = user-set (hard ceiling 100°F). Max single ramp step ±5°F. Pause
  phase-advance on stale/lost gravity. Clamp enforced on EVERY write using that program's bounds.
  Sources: homebrewandbeer.com, BYO diacetyl-rest, Wyeast pro-lager.

## Build order (once approved)
1. HA: per-tank program helpers + a program-tick automation + the 3 named program definitions
   (setpoint math + phase transitions + safety clamps). 2. Test dry (short intervals) on Tank 1.
   3. App: program picker + phase/progress display + cancel. 4. Custom builder. 5. LLM narration.

See [[glasshaus-alerts-plan]] (setpoint control, status), [[glasshaus-llm-insights]] (narration tie-in).
