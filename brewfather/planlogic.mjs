// Pure helpers for ferm-plan generation — extracted from server.mjs so they can be
// unit-tested without importing server.mjs (which binds the HTTP port on import).

// Known diastatic (STA1+) / super-attenuating strains — they express glucoamylase
// and keep drying the beer for weeks, so gravity flattening is NOT true terminal and
// a dry-hop can restart fermentation. Brewfather exposes no diastatic flag, so match
// on strain name + common product IDs. Best-effort; the plan prompt handles the rest.
export const DIASTATIC_RE =
  /\b(saison|farmhouse|belle\s*saison|brett|brettanomyces|diastaticus|3711|3726|3724|565|566|590|3068|saison\s*blend)\b/i;

export function isDiastaticYeast(y) {
  const hay = `${y?.name || ''} ${y?.productId || ''}`.toLowerCase();
  // WLP590/565/566 (French/Belgian saison), Wyeast 3711/3724/3726, Belle Saison,
  // any Brett, anything literally "diastaticus". Trappist/abbey ale strains are NOT
  // flagged (they're not STA1+), so we don't over-match plain "belgian".
  return DIASTATIC_RE.test(hay);
}

// Robustly pull a JSON object out of an LLM response that may have ```json fences,
// leading prose, or a trailing note. Try the whole string first (fast path), then
// fall back to the first balanced {...} block. Returns the parsed object or null.
export function parsePlanJson(raw) {
  const stripped = String(raw || '')
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  const s = stripped;
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    } }
  }
  return null;
}
