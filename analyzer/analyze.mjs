// GlassHaus insight analyzer — core logic.
// Gathers fermentation data from HA → calls Claude → writes sensor.glasshaus_insight.
// Validated against live data in scripts/insight-prototype.mjs. Config via env
// (set in the Unraid container, NEVER in git): HA_URL, HA_TOKEN, ANTHROPIC_API_KEY,
// optional ANTHROPIC_MODEL, INSIGHT_ENTITY.
const HA_URL = required('HA_URL');
const HA_TOKEN = required('HA_TOKEN');
const ANTHROPIC_KEY = required('ANTHROPIC_API_KEY');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const INSIGHT_ENTITY = process.env.INSIGHT_ENTITY || 'sensor.glasshaus_insight';
// GENERIC per-tank: mirror the programs runner's tank list (env-overridable).
const TANKS = (process.env.TANKS || 'tank_1,tank_2,tank_3').split(',').map((t) => t.trim());

function required(k) {
  const v = process.env[k];
  if (!v) { console.error(`[analyzer] missing required env ${k}`); process.exit(1); }
  return v;
}

const haGet = (p) =>
  fetch(`${HA_URL}${p}`, { headers: { Authorization: `Bearer ${HA_TOKEN}` } }).then((r) => r.json());
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const usable = (v) => v != null && v !== 'unknown' && v !== 'unavailable' && v !== '';

// Alert severity rank for "which tank matters most" selection.
const SEV_RANK = { problem: 0, warning: 1, milestone: 2 };

// ---- gather ONE tank's picture -----------------------------------------------
// GENERIC + per-tank. All the brewing math (attenuation/progress/pace/alerts) is
// ALREADY computed by the programs container into sensor.<tank>_derived — we read
// THAT, we do NOT recompute or read the deleted per-sensor entities. OG is resolved
// from the tank's ASSIGNED batch (input_select.<tank>_batch → all_batches_data),
// mirroring programs/runner.mjs deriveTank() exactly.
function gatherTank(by, tankId) {
  const s = (id) => by[id]?.state;
  const derived = by[`sensor.${tankId}_derived`];
  const attrs = derived?.attributes || {};

  const tankStatus = s(`input_select.${tankId}_status`);
  const batchSel = s(`input_select.${tankId}_batch`);
  const tiltSel = s(`input_select.${tankId}_tilt`);
  const active = usable(batchSel) && batchSel !== 'None' &&
    tankStatus !== 'Ready' && tankStatus !== 'Dirty' && tankStatus !== 'Out of service';

  // resolve OG etc. from the assigned batch (name OR batchNo match)
  const bfData = by['sensor.brewfather_all_batches_data']?.attributes?.data || [];
  const batch = bfData.find((b) => b.name === batchSel || String(b.batchNo) === batchSel) || null;

  // 24h gravity slope: per-color Tilt stat (SG→pts) preferred, else legacy Black pts
  const c = usable(tiltSel) ? tiltSel.toLowerCase() : null;
  const stat = c ? num(s(`sensor.tilt_${c}_gravity_24h_stat`)) : null;
  const gravity24hDelta_pts = stat != null ? stat * 1000 : num(s('sensor.gravity_24h_delta'));

  // recent curve tail from the assigned batch's Brewfather readings
  const readings = (batch?.readings || []).map((r) => ({ t: r.time, sg: r.sg, temp: r.temp })).slice(-40);

  const alerts = Array.isArray(attrs.alerts) ? attrs.alerts : [];
  const topSev = alerts.reduce((m, a) => Math.min(m, SEV_RANK[a.severity] ?? 9), 9);

  return {
    tank: tankId,
    active,
    tankStatus,
    batch: batch
      ? { name: batch.name, batchNo: batch.batchNo, style: batch.recipe?.style?.name || batch.style,
          og: batch.measuredOg ?? null, fermentingStart: batch.fermentingStart,
          targetTempC: batch.target_temperature }
      : { name: batchSel || null, og: null },
    tilt: tiltSel || 'None',
    live: {
      // TWO distinct metrics — do NOT conflate. apparentAttenuationPct = TRUE
      // attenuation (% sugar fermented). progressToFgPct = % of the way to target FG.
      apparentAttenuationPct: attrs.attenuationPct ?? null,
      progressToFgPct: attrs.progressToFgPct ?? null,
      pace_days: attrs.paceVsSchedule ?? null,
      projectedFg: attrs.projectedFgReach ?? null,
      dropFromPeak_pts: attrs.dropFromPeakPts ?? null,
      daysToTerminal: attrs.daysToTerminal ?? null,
      tiltProbeDeltaF: attrs.tiltProbeDeltaF ?? null,
      gravityAgeMin: attrs.gravityAgeMin ?? null,
      fermentationStarted: attrs.fermentationStarted ?? null,
      gravity24hDelta_pts,
      expectedFg: num(s(`input_number.${tankId}_expected_fg`)),
      setpointF: num(s(`sensor.${tankId}_setpoint`)),
      probeTempF: num(s(`sensor.${tankId}_probe_temp`)),
      programStatus: s(`sensor.${tankId}_program_status`),
    },
    alerts,
    _topSev: topSev,
    gravityCurveTail: readings,
  };
}

// ---- gather the whole plant, pick the tank worth talking about ---------------
async function gather(trigger) {
  const states = await haGet('/api/states');
  const by = Object.fromEntries(states.map((e) => [e.entity_id, e]));
  const all = TANKS.map((t) => gatherTank(by, t));
  const activeTanks = all.filter((t) => t.active);
  // subject = the active tank with the most severe alert; tie → first. Others are
  // still passed as context so the model sees the whole plant.
  const subject = activeTanks.slice().sort((a, b) => a._topSev - b._topSev)[0] || null;
  return { trigger, subject, activeTanks, tankCount: all.length };
}

const SYSTEM = `You are an expert brewer analyzing live fermentation telemetry from a homebrewery.
Be concise, specific, and ACTIONABLE. Flag only what genuinely matters; if all is well, say so plainly.

You are given ONE subject tank to analyze plus the other active tanks as context.
ALWAYS name the SUBJECT tank and its batch in the headline/detail (e.g. "Tank 1 (West Coast
IPA): ..."). The reader has multiple tanks — an unlabeled insight is useless.

OG / MISSING DATA:
- The batch's OG comes from Brewfather (batch.og). If batch.og is null it means no measured OG
  is logged in Brewfather for the ASSIGNED batch — attenuation & pace genuinely can't be
  computed. Say so and tell them to log measured OG in Brewfather (NOT "on next observation").
- If subject.batch.name is null, no batch is assigned to the tank — say "assign a batch in
  Manage" rather than analyzing empty telemetry.
- apparentAttenuationPct / progressToFgPct / pace_days are precomputed and may be null when OG
  or FG is missing; a null there is a data gap, not a stall.

DATA LITERACY — critical, do not get these wrong:
- The gravity source is a Tilt hydrometer: precision is ~±0.001-0.002 SG and it is NOISY.
  Treat any gravity movement smaller than ~0.002 SG as MEASUREMENT NOISE, not a real trend.
  Do NOT call something a "stall" or "plateau" based on wobble between two nearby points
  (e.g. 1.0116 vs 1.0121) — that is noise, not meaningful. A real stall = gravity genuinely
  flat (24h delta near 0) while still WELL ABOVE the expected FG.
- "apparentAttenuationPct" = TRUE attenuation (% of sugars fermented) — this is what
  "attenuation" means to a brewer. "progressToFgPct" = how close to the target FG (a finish-
  line %). NEVER report progressToFgPct as "attenuation". Near the end these diverge (e.g.
  74% attenuation but 95% of the way to target FG).
- gravity24hDelta_pts is in POINTS/day (×1000 SG); e.g. -10 = -0.010 SG/day. Near terminal a
  small negative or ~0 delta is EXPECTED and fine, not a problem.

PACKAGING READINESS — do NOT get this wrong (common bad advice):
- Reaching terminal gravity does NOT mean "ready to package." Terminal is just the FIRST step.
- "Terminal" itself requires the gravity be STABLE for ~3 CONSECUTIVE DAYS (dry-hopped/NEIPA:
  5-7 days after dry-hopping, due to HOP CREEP re-fermenting late sugars). One flat reading is
  not terminal.
- After confirmed-terminal, the beer still needs: a completed DIACETYL REST (hold near FG at
  elevated temp ~2-3 days so yeast clean up diacetyl/acetaldehyde), THEN cold crash, THEN
  conditioning/lagering. Packaging is the END of that chain.
- So when gravity is flat at FG, the right advice is "verify stable N days / hold for D-rest
  cleanup," NEVER "proceed to package." Only suggest packaging if D-rest + crash + conditioning
  are clearly done (which this telemetry usually can't confirm — so default to caution).

ANALYSIS FOCUS: is attenuation on pace vs schedule? Is the gravity SLOPE meaningfully
flattening EARLY (before ~70% apparent attenuation = possible high finish / real stall)?
Is temperature holding the setpoint? Any equipment concern? Where in the ferment→D-rest→crash
→condition→package arc is it, and what's the NEXT step (not skipping ahead to packaging)?
Otherwise say it's nominal.

Only raise severity above "info" for something a brewer would actually act on. Output ONLY
valid JSON (no markdown, no code fences):
{"severity":"info|watch|problem","headline":"<=70 chars","detail":"1-3 sentences","action":"concrete next step or empty"}`;

function stripFences(t) {
  return t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

async function callClaude(data) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 400, system: SYSTEM,
      messages: [{ role: 'user', content:
        `Trigger: ${data.trigger}\n` +
        `SUBJECT TANK to analyze (name it in your output):\n${JSON.stringify(data.subject, null, 1)}\n\n` +
        `Other active tanks (context only):\n${JSON.stringify(
          data.activeTanks.filter((t) => t.tank !== data.subject?.tank), null, 1)}` }],
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${j.error.type}: ${j.error.message}`);
  const text = stripFences(j.content?.[0]?.text ?? '');
  try { return JSON.parse(text); }
  catch { return { severity: 'info', headline: 'Insight (unparsed)', detail: text.slice(0, 300), action: '' }; }
}

async function writeInsight(insight, subject) {
  const body = {
    state: insight.headline?.slice(0, 255) || 'nominal',
    attributes: {
      friendly_name: 'GlassHaus Insight',
      severity: insight.severity || 'info',
      detail: insight.detail || '',
      action: insight.action || '',
      // subject identity so the app/notification can show WHICH tank/batch it's about
      tank: subject?.tank || null,
      batch: subject?.batch?.name || null,
      icon: insight.severity === 'problem' ? 'mdi:alert' : insight.severity === 'watch' ? 'mdi:eye' : 'mdi:information',
    },
  };
  const r = await fetch(`${HA_URL}/api/states/${INSIGHT_ENTITY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HA write failed: HTTP ${r.status}`);
}

export async function runOnce(trigger = 'digest') {
  const data = await gather(trigger);
  // skip LLM call entirely if no tank has an active brew (nothing to analyze)
  if (!data.subject) {
    console.log(`[analyzer] no active brew on any of ${data.tankCount} tanks — skipping (${trigger})`);
    return null;
  }
  const insight = await callClaude(data);
  await writeInsight(insight, data.subject);
  console.log(`[analyzer] ${trigger} → ${data.subject.tank}: ${insight.severity}: ${insight.headline}`);
  return insight;
}
