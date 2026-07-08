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

function required(k) {
  const v = process.env[k];
  if (!v) { console.error(`[analyzer] missing required env ${k}`); process.exit(1); }
  return v;
}

const haGet = (p) =>
  fetch(`${HA_URL}${p}`, { headers: { Authorization: `Bearer ${HA_TOKEN}` } }).then((r) => r.json());
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

// ---- gather the fermentation picture (Tank 1 today; per-tank later) -----------
async function gather(trigger) {
  const states = await haGet('/api/states');
  const by = Object.fromEntries(states.map((e) => [e.entity_id, e]));
  const s = (id) => by[id]?.state;
  const bf = by['sensor.brewfather_all_batches_data']?.attributes?.data?.[0] || {};
  const readings = (bf.readings || []).map((r) => ({ t: r.time, sg: r.sg, temp: r.temp })).slice(-40);
  const alertsActive = Object.keys(by).filter((id) =>
    /^binary_sensor\.tank_1_(fermentation_stalled|temp_excursion|approaching_terminal|assignment_suspect)$/.test(id)
    && by[id].state === 'on');
  return {
    trigger,
    batch: { name: bf.name, status: bf.status, og: bf.measuredOg,
             fermentingStart: bf.fermentingStart, targetTempC: bf.target_temperature },
    live: {
      gravity: num(s('sensor.tilt_black_gravity')),
      expectedFg: num(s('input_number.tank_1_expected_fg')),
      beerTempF: num(s('sensor.tilt_black_temperature')),
      probeTempF: num(s('sensor.tank_1_probe_temp')),
      setpointF: num(s('sensor.tank_1_setpoint')),
      gravity24hDelta_pts: num(s('sensor.gravity_24h_delta')),
      // TWO distinct metrics — do NOT conflate:
      //  apparentAttenuationPct = real brewing attenuation (OG-SG)/(OG-1), the % of
      //    sugar fermented. This is what a brewer means by "attenuation".
      //  progressToFgPct = how close to the TARGET FG (OG-SG)/(OG-FG). A "finish line" %.
      apparentAttenuationPct: num(s('sensor.apparent_attenuation')),
      progressToFgPct: num(s('sensor.attenuation_progress')),
      pace_days: num(s('sensor.fermentation_pace_vs_schedule')),
      projectedFg: s('sensor.projected_fg_reach'),
      controllerState: s('sensor.tank_1_controller_state'),
    },
    alertsActive,
    tiltSignalLost: by['binary_sensor.tilt_black_signal_lost']?.state === 'on',
    gravityCurveTail: readings,
    tankStatus: s('input_select.tank_1_status'),
  };
}

const SYSTEM = `You are an expert brewer analyzing live fermentation telemetry from a homebrewery.
Be concise, specific, and ACTIONABLE. Flag only what genuinely matters; if all is well, say so plainly.

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
        `Trigger: ${data.trigger}\nFermentation data (JSON):\n${JSON.stringify(data, null, 1)}` }],
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${j.error.type}: ${j.error.message}`);
  const text = stripFences(j.content?.[0]?.text ?? '');
  try { return JSON.parse(text); }
  catch { return { severity: 'info', headline: 'Insight (unparsed)', detail: text.slice(0, 300), action: '' }; }
}

async function writeInsight(insight) {
  const body = {
    state: insight.headline?.slice(0, 255) || 'nominal',
    attributes: {
      friendly_name: 'GlassHaus Insight',
      severity: insight.severity || 'info',
      detail: insight.detail || '',
      action: insight.action || '',
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
  // skip LLM call entirely if there's no active brew (nothing to analyze)
  if (!data.batch?.name || data.tankStatus === 'Ready' || data.tankStatus === 'Dirty') {
    console.log(`[analyzer] no active brew — skipping (${trigger})`);
    return null;
  }
  const insight = await callClaude(data);
  await writeInsight(insight);
  console.log(`[analyzer] ${trigger} → ${insight.severity}: ${insight.headline}`);
  return insight;
}
