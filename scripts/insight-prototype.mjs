// Insight prompt PROTOTYPE — validates the LLM-insights idea against live data
// before building the full analyzer. Gathers fermentation data from HA, calls
// Claude, prints the structured insight. Reads secrets from files (never args):
//   .env.local      → VITE_HA_URL, VITE_HA_TOKEN
//   .anthropic-key  → the Anthropic API key (one line)
// Run: node scripts/insight-prototype.mjs [digest|<alert-name>]
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const trigger = process.argv[2] || 'digest';

function readEnvLocal() {
  const txt = readFileSync(`${ROOT}/.env.local`, 'utf8');
  const get = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] || '').trim();
  return { url: get('VITE_HA_URL'), token: get('VITE_HA_TOKEN') };
}
const { url: HA_URL, token: HA_TOKEN } = readEnvLocal();
const ANTHROPIC_KEY = readFileSync(`${ROOT}/.anthropic-key`, 'utf8').trim();

const ha = (path) =>
  fetch(`${HA_URL}${path}`, { headers: { Authorization: `Bearer ${HA_TOKEN}` } }).then((r) => r.json());

// ---- gather the fermentation picture (Tank 1 today) ----------------------------
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

async function gather() {
  const states = await ha('/api/states');
  const by = Object.fromEntries(states.map((e) => [e.entity_id, e]));
  const s = (id) => by[id]?.state;
  const bf = by['sensor.brewfather_all_batches_data']?.attributes?.data?.[0] || {};
  const readings = (bf.readings || []).map((r) => ({ t: r.time, sg: r.sg, temp: r.temp })).slice(-40);
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
      apparentAttenuationPct: num(s('sensor.apparent_attenuation')),
      progressToFgPct: num(s('sensor.attenuation_progress')),
      pace_days: num(s('sensor.fermentation_pace_vs_schedule')),
      projectedFg: s('sensor.projected_fg_reach'),
      controllerState: s('sensor.tank_1_controller_state'),
    },
    alertsActive: Object.keys(by).filter((id) =>
      /^binary_sensor\.tank_1_(fermentation_stalled|temp_excursion|approaching_terminal|assignment_suspect)$/.test(id)
      && by[id].state === 'on'),
    tiltSignalLost: by['binary_sensor.tilt_black_signal_lost']?.state === 'on',
    gravityCurveTail: readings,     // last ~40 points for trend/anomaly reasoning
  };
}

const SYSTEM = `You are an expert brewer analyzing live fermentation telemetry from a homebrewery.
Be concise, specific, and ACTIONABLE. Flag only what genuinely matters; if all is well, say so plainly.

DATA LITERACY — critical, do not get these wrong:
- The gravity source is a Tilt hydrometer: precision ~±0.001-0.002 SG and NOISY. Treat any
  gravity movement smaller than ~0.002 SG as MEASUREMENT NOISE, not a trend. Do NOT call
  something a "stall"/"plateau" from wobble between two nearby points (e.g. 1.0116 vs 1.0121).
  A real stall = gravity genuinely flat (24h delta ~0) while still WELL ABOVE expected FG.
- "apparentAttenuationPct" = TRUE attenuation (% sugars fermented) — what "attenuation" means
  to a brewer. "progressToFgPct" = how close to target FG (finish-line %). NEVER report
  progressToFgPct as "attenuation". Near the end they diverge (e.g. 74% atten but 95% to FG).
- gravity24hDelta_pts is POINTS/day (×1000 SG). Near terminal a small/~0 delta is EXPECTED.

FOCUS: attenuation on pace vs schedule? gravity slope flattening EARLY (before ~70% apparent
attenuation)? temperature holding setpoint? equipment concern? else say nominal. Only raise
severity above "info" for something a brewer would actually act on. Output ONLY valid JSON:
{"severity":"info|watch|problem","headline":"<=70 chars","detail":"1-3 sentences","action":"concrete next step or empty"}.`;

async function callClaude(data) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: 'user', content:
        `Trigger: ${data.trigger}\nFermentation data (JSON):\n${JSON.stringify(data, null, 1)}` }],
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${j.error.type}: ${j.error.message}`);
  return j.content?.[0]?.text ?? JSON.stringify(j);
}

const data = await gather();
console.log('=== GATHERED DATA ===');
console.log(JSON.stringify({ ...data, gravityCurveTail: `[${data.gravityCurveTail.length} pts]` }, null, 1));
console.log('\n=== CLAUDE INSIGHT ===');
console.log(await callClaude(data));
