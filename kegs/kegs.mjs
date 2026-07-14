// GlassHaus keg-management — PURE domain logic (no DB, no HTTP, no clock side-effects).
// Everything here is a pure function of its inputs so it's exhaustively unit-testable, in
// the same spirit as programs/derived.mjs. db.mjs and server.mjs call into this.
//
// Concepts:
//  - A keg is a permanent object with an id (in its QR sticker) that NEVER changes.
//  - Status lifecycle: dirty → clean → filled → tapped → empty → dirty; retire is terminal.
//  - Seal life + clean age are DERIVED (now − last relevant date) — never hand-maintained.

// ── status lifecycle ──────────────────────────────────────────────────────────
export const STATUSES = ['dirty', 'clean', 'filled', 'tapped', 'empty', 'retired'];

// allowed transitions. Kept deliberately permissive for the common real-world moves but
// strict enough to catch nonsense (e.g. tapping a dirty keg). `retire`/`unretire` and
// `note` are always allowed and handled outside this table.
const TRANSITIONS = {
  dirty:   ['clean'],
  clean:   ['filled', 'dirty'],          // dirty again = re-clean needed / got contaminated
  filled:  ['tapped', 'empty', 'dirty'], // can dump a filled keg back to dirty
  tapped:  ['empty', 'filled'],          // empty = kicked; filled = pulled off tap still full
  empty:   ['dirty', 'clean'],           // usually dirty; clean if rinsed immediately
  retired: [],                           // terminal (until explicit unretire)
};

/** Is a status change allowed? Returns {ok} or {ok:false, reason}. */
export function canTransition(from, to) {
  if (!STATUSES.includes(to)) return { ok: false, reason: `unknown status "${to}"` };
  if (from === to) return { ok: false, reason: `already ${to}` };
  if (to === 'retired') return { ok: true };                 // retire from anything
  if (from === 'retired') return { ok: false, reason: 'keg is retired — unretire first' };
  if (!(TRANSITIONS[from] || []).includes(to)) {
    return { ok: false, reason: `cannot go ${from} → ${to}` };
  }
  return { ok: true };
}

// the action a transition logs, and any status-specific field effects. Returns the
// keg patch to apply (server merges it) + the event to append. `at` is passed in (no
// internal clock) so it's testable and consistent with the event timestamp.
export function applyTransition(keg, to, { at, tap, beer, cleanType } = {}) {
  const chk = canTransition(keg.status, to);
  if (!chk.ok) throw new Error(chk.reason);
  const patch = { status: to };
  let action = to, detail = {};
  if (to === 'tapped') { patch.tap = tap ?? keg.tap ?? null; action = 'tapped'; detail = { tap: patch.tap }; }
  if (to === 'filled') {
    patch.tap = null; patch.filled_at = at;
    // Accept EITHER beer.name (manual fill from QR page / tablet) or beer.batch (kegging
    // handoff sources the Brewfather batch name into .batch). Only overwrite beer fields
    // when actually given a name — an empty {beer:{}} must NOT null out existing contents.
    if (beer) {
      const name = beer.batch ?? beer.name ?? null;
      if (name != null) patch.beer_batch = name;
      if (beer.style !== undefined) patch.beer_style = beer.style ?? null;
      if (beer.abv !== undefined) patch.beer_abv = beer.abv ?? null;
    }
    action = 'filled'; detail = { batch: patch.beer_batch ?? keg.beer_batch, style: patch.beer_style ?? keg.beer_style };
  }
  if (to === 'empty') { patch.tap = null; action = 'emptied'; }
  if (to === 'clean') {
    patch.cleaned_at = at; patch.clean_type = cleanType ?? keg.clean_type ?? 'rinse';
    // clearing contents happens on empty→clean or dirty→clean; a filled keg shouldn't clean
    action = 'cleaned'; detail = { cleanType: patch.clean_type };
  }
  if (to === 'dirty') { patch.beer_batch = null; patch.beer_style = null; patch.beer_abv = null; patch.filled_at = null; patch.tap = null; action = 'emptied-dirty'; }
  if (to === 'retired') { patch.retired_at = at; patch.tap = null; action = 'retired'; }
  return { patch, event: { action, at, detail } };
}

// ── seals ───────────────────────────────────────────────────────────────────
export const SEAL_TYPES = ['lid', 'post', 'dip'];
const SEAL_FIELD = { lid: ['lid_seal_at', 'lid_seal_life'], post: ['post_seal_at', 'post_seal_life'], dip: ['dip_seal_at', 'dip_seal_life'] };

/** Replace one seal type → patch + event. */
export function replaceSeal(keg, sealType, { at } = {}) {
  if (!SEAL_TYPES.includes(sealType)) throw new Error(`unknown seal type "${sealType}"`);
  const [atField] = SEAL_FIELD[sealType];
  return { patch: { [atField]: at }, event: { action: 'seal-replaced', at, detail: { sealType } } };
}

const DAY = 86_400_000;
const daysBetween = (fromIso, now) => (!fromIso ? null : Math.floor((now - Date.parse(fromIso)) / DAY));

/**
 * Compute derived health for a keg at time `now`: per-seal age + due flags, clean age +
 * expiry, and any warnings. Pure — used by both the UI and the HA-mirror/alerts.
 */
export function kegHealth(keg, now) {
  const seals = {};
  for (const t of SEAL_TYPES) {
    const [atField, lifeField] = SEAL_FIELD[t];
    const ageDays = daysBetween(keg[atField], now);
    const life = keg[lifeField] ?? null;
    seals[t] = {
      replacedAt: keg[atField] ?? null,
      ageDays,
      lifeDays: life,
      due: ageDays != null && life != null ? ageDays >= life : false,
      // "soon" = within 10% of life remaining (gentle heads-up before overdue)
      soon: ageDays != null && life != null ? (!(ageDays >= life) && ageDays >= life * 0.9) : false,
    };
  }
  const cleanAgeDays = daysBetween(keg.cleaned_at, now);
  const cleanLife = keg.clean_life ?? 30;
  // a clean only "expires" while the keg is sitting ready (clean/filled) — a tapped or
  // dirty keg's clean-age isn't actionable.
  const cleanExpired = ['clean', 'filled'].includes(keg.status)
    && cleanAgeDays != null && cleanAgeDays >= cleanLife;

  const warnings = [];
  for (const t of SEAL_TYPES) if (seals[t].due) warnings.push({ kind: 'seal-due', sealType: t, msg: `${t} o-ring overdue (${seals[t].ageDays}d / ${seals[t].lifeDays}d)` });
  if (cleanExpired) warnings.push({ kind: 'clean-expired', msg: `cleaned ${cleanAgeDays}d ago (>${cleanLife}d) — re-sanitize before use` });

  return {
    seals, cleanAgeDays, cleanExpired,
    anySealDue: SEAL_TYPES.some((t) => seals[t].due),
    warnings,
    // overall severity for the fleet list / HA mirror
    severity: warnings.some((w) => w.kind === 'seal-due') ? 'warning'
      : cleanExpired ? 'warning' : 'ok',
  };
}

// (kegUrl lives in qr.mjs — the QR sticker URL builder, colocated with QR rendering.)

// ── id generation ───────────────────────────────────────────────────────────
/** Next sequential id given existing ids, e.g. ["keg-001","keg-003"] → "keg-004". */
export function nextKegId(existingIds) {
  let max = 0;
  for (const id of existingIds || []) {
    const m = /^keg-(\d+)$/.exec(String(id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `keg-${String(max + 1).padStart(3, '0')}`;
}

// ── kegging handoff (tank → keg) ────────────────────────────────────────────
/**
 * Suggest how many kegs a batch fills, from its volume. batchGal = Brewfather batch size
 * in gallons; kegSizeL = target keg size (default 19L ≈ 5gal). This is a SUGGESTION the
 * user confirms — approximate is fine.
 *
 * Model = FLOOR (count only kegs a batch can actually FILL; a partial remainder is
 * leftover/bottled/dumped, not its own keg) with a tolerance band, because:
 *   • The Brewfather batch number is OVERBUILT — it accounts for trub loss, chiller/
 *     shrinkage loss, and deadspace, so LESS actually reaches the kegs than the figure says.
 *   • A keg is ~5gal but you rarely fill it to the brim.
 * Net effect: a batch nominally "just over N kegs" still yields N. Confirmed real cases:
 *   5gal→1, 7–8gal→1, 10gal→2, 13.5gal→2. TOL absorbs the overbuild so 10.0 (≈1.99 raw
 *   kegs) → 2, while 7.5 (≈1.49) → 1 and 13.5 (≈2.69) → 2.
 */
export function suggestKegCount(batchGal, kegSizeL = 19, { tolerance = 0.15 } = {}) {
  const kegGal = kegSizeL / 3.78541;                 // ≈ 5.019 gal for a 19L keg
  const n = Math.floor((Number(batchGal) || 0) / kegGal + tolerance);
  return Math.max(1, n);
}

/**
 * Fill ONE keg from a batch (the kegging handoff). `batch` = { name, style, abv } sourced
 * from the tank's Brewfather batch. Requires the keg to be clean (real workflow — you keg
 * into a cleaned keg). Returns the fill patch + event (event links the source batch for
 * traceability). Throws if the keg isn't fillable.
 */
export function kegBatch(keg, batch, { at, sourceTank = null } = {}) {
  // Kegging a FRESH batch requires a CLEAN keg. (applyTransition also permits tapped→filled
  // for the separate "pull a still-full keg off the tap" case, but you'd never keg a new
  // batch into a keg that's currently tapped/full — block that mistake here.)
  if (keg.status !== 'clean') throw new Error(`can't keg into ${keg.id}: keg is ${keg.status}, must be clean first`);
  const { patch, event } = applyTransition(keg, 'filled', {
    at, beer: { batch: batch?.name ?? null, style: batch?.style ?? null, abv: batch?.abv ?? null },
  });
  event.detail = { ...event.detail, sourceTank, batch: batch?.name ?? null };
  return { patch, event };
}

// ── tap lines ─────────────────────────────────────────────────────────────────
// The 8 faucets are FIXED plumbing needing periodic line cleaning (~every 2 weeks).
// Distinct from kegs. Auto-linked: tapping a keg onto a tap records the keg↔tap link.
export const TAP_COUNT = 8;

/** Line-clean health for a tap at `now`: age + due flag. */
export function tapHealth(tapLine, now) {
  const ageDays = tapLine?.cleaned_at ? Math.floor((now - Date.parse(tapLine.cleaned_at)) / DAY) : null;
  const life = tapLine?.clean_life ?? 14;
  return {
    cleanAgeDays: ageDays,
    lifeDays: life,
    due: ageDays != null && ageDays >= life,
    soon: ageDays != null && !(ageDays >= life) && ageDays >= life * 0.85,
  };
}

/**
 * Decide the effect of tapping `keg` onto tap `tapNo`, given that tap's current line record.
 * Returns { warn } if the line is overdue (caller surfaces it but still allows the tap —
 * a warning, not a block), plus the tap patch/event to record the keg↔tap link.
 */
export function tapOnto(keg, tapNo, tapLine, { at } = {}) {
  const h = tapHealth(tapLine, at ? Date.parse(at) : Date.now());
  const warn = h.due ? `Tap ${tapNo} line cleaned ${h.cleanAgeDays}d ago (>${h.lifeDays}d) — clean the line first` : null;
  return {
    warn,
    tapPatch: { current_keg: keg.id },
    tapEvent: { action: 'keg-connected', at, detail: { keg: keg.id, beer: keg.beer_batch || null } },
  };
}

/** Mark a tap line cleaned → patch + event. */
export function cleanTapLine(tapLine, { at } = {}) {
  return { patch: { cleaned_at: at }, event: { action: 'line-cleaned', at, detail: {} } };
}

/** HA mirror payload for one tap line. */
export function tapMirror(tapLine, now) {
  const h = tapHealth(tapLine, now);
  const base = `sensor.tap_${tapLine.tap}`;
  return [
    { entityId: `${base}_line_clean_age_days`, state: h.cleanAgeDays ?? 'unknown', attrs: {
      friendly_name: `Tap ${tapLine.tap} line clean age`, unit_of_measurement: 'd',
      due: h.due, current_keg: tapLine.current_keg || null } },
    { entityId: `${base}_line_due`, state: h.due ? 'on' : 'off', attrs: {
      friendly_name: `Tap ${tapLine.tap} line cleaning due`, device_class: 'problem' } },
  ];
}

// ── HA mirror ─────────────────────────────────────────────────────────────────
/** Build the HA sensor payloads to mirror one keg's summary. Returns [{entityId,state,attrs}]. */
export function haMirror(keg, now) {
  const h = kegHealth(keg, now);
  const base = `sensor.keg_${keg.id.replace(/-/g, '_')}`;
  return [
    { entityId: `${base}_status`, state: keg.status, attrs: {
      friendly_name: `${keg.label} status`, beer: keg.beer_batch || null, tap: keg.tap ?? null,
      severity: h.severity } },
    { entityId: `${base}_seal_due`, state: h.anySealDue ? 'on' : 'off', attrs: {
      friendly_name: `${keg.label} seal due`, device_class: 'problem',
      lid_days: h.seals.lid.ageDays, post_days: h.seals.post.ageDays, dip_days: h.seals.dip.ageDays } },
    { entityId: `${base}_clean_age_days`, state: h.cleanAgeDays ?? 'unknown', attrs: {
      friendly_name: `${keg.label} clean age`, unit_of_measurement: 'd', expired: h.cleanExpired } },
  ];
}
