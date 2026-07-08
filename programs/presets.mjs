// Fermentation program PRESETS — step-patterns (style-family, not yeast-specific).
// Numbers are Jordan's CONFIRMED defaults (2026-07-08), overridable per batch.
// Each program = ordered phases. Each phase: a primitive + params + an advance
// condition. Primitives: hold | ramp | wait | coldCrash. The COLD CRASH phase is
// always `requiresConfirm` (gated — never auto-fires). Per-program clamp {minF,maxF}
// is enforced on EVERY setpoint write (kveik needs a high ceiling; ale/lager stay low).
//
// Advance conditions (object per phase):
//   { type: 'attenuation', pct }      → apparent attenuation >= pct
//   { type: 'terminal' }              → gravity flat near expected FG (see terminal check)
//   { type: 'progressToFg', pct }     → progress toward FG >= pct
//   { type: 'elapsed', hours }        → this phase has run >= hours
//   { type: 'active' }                → fermentation has started (gravity moving down)
//   { type: 'confirm' }               → waits for the crash-confirm button (gated)

export const PRESETS = {
  ale: {
    label: 'Ale — free-rise + D-rest',
    clamp: { minF: 32, maxF: 75 },
    phases: [
      { name: 'pitch',   kind: 'hold', tempF: 64, advance: { type: 'active' } },
      { name: 'primary', kind: 'hold', tempF: 66, advance: { type: 'progressToFg', pct: 75 } },
      { name: 'drest',   kind: 'ramp', stepF: 2, everyHours: 12, targetF: 69, advance: { type: 'terminal' } },
      { name: 'cleanup', kind: 'wait', hours: 48 },
      { name: 'crash',   kind: 'coldCrash', targetF: 34, stepF: 6, everyHours: 12, requiresConfirm: true },
    ],
  },
  lager_fast: {
    label: 'Lager — Brülosophy fast',
    clamp: { minF: 32, maxF: 75 },
    phases: [
      { name: 'primary', kind: 'hold', tempF: 52, advance: { type: 'attenuation', pct: 50 } },
      { name: 'drest',   kind: 'ramp', stepF: 5, everyHours: 12, targetF: 66, advance: { type: 'terminal' } },
      { name: 'crash',   kind: 'coldCrash', targetF: 34, stepF: 6, everyHours: 12, requiresConfirm: true },
    ],
  },
  lager_modern: {
    label: 'Lager — modern (ale-temp)',   // JORDAN'S method
    clamp: { minF: 32, maxF: 75 },
    phases: [
      { name: 'primary', kind: 'hold', tempF: 64, advance: { type: 'attenuation', pct: 50 } },
      { name: 'ramp',    kind: 'ramp', stepF: 5, everyHours: 12, targetF: 69, advance: { type: 'terminal' } },
      { name: 'cleanup', kind: 'wait', hours: 72 },
      { name: 'crash',   kind: 'coldCrash', targetF: 34, stepF: 6, everyHours: 12, requiresConfirm: true },
    ],
  },
  kveik: {
    label: 'Kveik — warm & fast',
    clamp: { minF: 32, maxF: 98 },        // kveik needs the high ceiling
    phases: [
      { name: 'primary', kind: 'hold', tempF: 90, advance: { type: 'terminal' } },
      { name: 'crash',   kind: 'coldCrash', targetF: 34, stepF: 6, everyHours: 12, requiresConfirm: true },
    ],
  },
  coldcrash: {
    label: 'Cold crash only',
    clamp: { minF: 32, maxF: 45 },
    phases: [
      { name: 'crash', kind: 'coldCrash', targetF: 34, stepF: 6, everyHours: 12, requiresConfirm: true },
    ],
  },
};

// Custom programs come from HA (a JSON blob in an input_text/attribute) and are
// validated against the same phase shape; hard ceiling 100F for custom clamps.
export const CUSTOM_MAX_CEILING_F = 100;
