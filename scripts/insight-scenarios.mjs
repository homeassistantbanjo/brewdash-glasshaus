// Prompt validation against SYNTHETIC problem scenarios — confirms the insight
// prompt raises the right severity + good advice for cases that matter (not just
// the calm near-terminal case). No live HA needed. Reads .anthropic-key.
import { readFileSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const KEY = readFileSync(`${ROOT}/.anthropic-key`, 'utf8').trim();

// same SYSTEM prompt as analyzer/analyze.mjs (keep in sync)
const SYSTEM = `You are an expert brewer analyzing live fermentation telemetry from a homebrewery.
Be concise, specific, and ACTIONABLE. Flag only what genuinely matters; if all is well, say so plainly.

DATA LITERACY — critical, do not get these wrong:
- The gravity source is a Tilt hydrometer: precision ~±0.001-0.002 SG and NOISY. Treat any
  gravity movement smaller than ~0.002 SG as MEASUREMENT NOISE, not a trend. Do NOT call
  something a "stall"/"plateau" from wobble between two nearby points. A real stall = gravity
  genuinely flat (24h delta ~0) while still WELL ABOVE expected FG.
- "apparentAttenuationPct" = TRUE attenuation (% sugars fermented). "progressToFgPct" = how
  close to target FG. NEVER report progressToFgPct as "attenuation". Near the end they diverge.
- gravity24hDelta_pts is POINTS/day (×1000 SG). Near terminal a small/~0 delta is EXPECTED.

PACKAGING READINESS (do NOT get wrong): terminal gravity ≠ ready to package. "Terminal" needs
gravity STABLE ~3 consecutive days (dry-hopped/NEIPA 5-7 days, hop creep). After terminal the
beer still needs D-REST (2-3 days near FG, elevated), THEN cold crash, THEN conditioning. When
gravity is flat at FG, advise "verify stable / hold for D-rest cleanup" — NEVER "proceed to
package" (default to caution).

FOCUS: attenuation on pace vs schedule? gravity slope flattening EARLY? temperature holding
setpoint? equipment concern? where in the ferment→D-rest→crash→condition→package arc + NEXT step?
else say nominal. Only raise severity above "info" for something a brewer would act on. Output
ONLY valid JSON: {"severity":"info|watch|problem","headline":"<=70 chars","detail":"1-3 sentences","action":"concrete next step or empty"}.`;

const SCENARIOS = {
  'early-stall': {
    note: 'Day 4, gravity flat 2 days at 1.030, well above FG 1.010, only ~48% attenuated → REAL stall',
    trigger: 'binary_sensor.tank_1_fermentation_stalled',
    batch: { name: 'Test IPA', status: 'Fermenting', og: 1.058, fermentingStart: '2026-07-04T00:00:00', targetTempC: 19 },
    live: { gravity: 1.030, expectedFg: 1.010, beerTempF: 66, probeTempF: 66, setpointF: 66,
      gravity24hDelta_pts: -0.5, apparentAttenuationPct: 48.3, progressToFgPct: 58.3,
      pace_days: -2.5, projectedFg: 'stalled', controllerState: 'idle' },
    alertsActive: ['binary_sensor.tank_1_fermentation_stalled'], tiltSignalLost: false, tankStatus: 'Fermenting',
  },
  'temp-excursion': {
    note: 'Active ferment but beer temp 78°F vs 66°F setpoint = +12°F excursion (fusel risk)',
    trigger: 'binary_sensor.tank_1_temp_excursion',
    batch: { name: 'Hazy DIPA', status: 'Fermenting', og: 1.070, fermentingStart: '2026-07-06T00:00:00', targetTempC: 19 },
    live: { gravity: 1.040, expectedFg: 1.014, beerTempF: 78, probeTempF: 77, setpointF: 66,
      gravity24hDelta_pts: -18, apparentAttenuationPct: 42.9, progressToFgPct: 53.6,
      pace_days: 1.0, projectedFg: 'Jul 11', controllerState: 'idle' },
    alertsActive: ['binary_sensor.tank_1_temp_excursion'], tiltSignalLost: false, tankStatus: 'Fermenting',
  },
  'sluggish-start': {
    note: 'Day 2, only dropped 3 pts from OG, slow lag — possible weak pitch/underpitch',
    trigger: 'digest',
    batch: { name: 'Saison', status: 'Fermenting', og: 1.052, fermentingStart: '2026-07-06T00:00:00', targetTempC: 24 },
    live: { gravity: 1.049, expectedFg: 1.004, beerTempF: 74, probeTempF: 74, setpointF: 75,
      gravity24hDelta_pts: -2, apparentAttenuationPct: 5.8, progressToFgPct: 6.3,
      pace_days: -1.5, projectedFg: 'Jul 20', controllerState: 'idle' },
    alertsActive: [], tiltSignalLost: false, tankStatus: 'Fermenting',
  },
  'signal-lost': {
    note: 'Tilt hasn\'t reported in a while — data may be stale',
    trigger: 'binary_sensor.tilt_black_signal_lost',
    batch: { name: 'Stout', status: 'Fermenting', og: 1.062, fermentingStart: '2026-07-05T00:00:00', targetTempC: 20 },
    live: { gravity: 1.028, expectedFg: 1.016, beerTempF: 68, probeTempF: 68, setpointF: 68,
      gravity24hDelta_pts: 0, apparentAttenuationPct: 54.8, progressToFgPct: 73.9,
      pace_days: 0, projectedFg: 'unknown', controllerState: 'cooling' },
    alertsActive: [], tiltSignalLost: true, tankStatus: 'Fermenting',
  },
  'healthy-active': {
    note: 'Day 3, vigorous, on pace, temp on point — should be INFO/nominal',
    trigger: 'digest',
    batch: { name: 'Pale Ale', status: 'Fermenting', og: 1.050, fermentingStart: '2026-07-05T00:00:00', targetTempC: 19 },
    live: { gravity: 1.024, expectedFg: 1.010, beerTempF: 66, probeTempF: 66, setpointF: 66,
      gravity24hDelta_pts: -12, apparentAttenuationPct: 52.0, progressToFgPct: 65.0,
      pace_days: 0.3, projectedFg: 'Jul 12', controllerState: 'cooling' },
    alertsActive: [], tiltSignalLost: false, tankStatus: 'Fermenting',
  },
};

async function callClaude(data) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, system: SYSTEM,
      messages: [{ role: 'user', content: `Trigger: ${data.trigger}\nFermentation data (JSON):\n${JSON.stringify(data, null, 1)}` }] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${j.error.type}: ${j.error.message}`);
  return (j.content?.[0]?.text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

const only = process.argv[2];
for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (only && only !== name) continue;
  const { note, ...data } = sc;
  console.log(`\n━━━ ${name} ━━━\n  expect: ${note}`);
  try { console.log('  ' + (await callClaude(data)).replace(/\n/g, '\n  ')); }
  catch (e) { console.log('  ERROR:', e.message); }
}
