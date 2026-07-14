// GlassHaus keg store — the keg fleet registry + append-only activity log.
//
// SQLite via node:sqlite (built-in, Node 22+), same pattern as brewfather/db.mjs. File at
// /data/kegs.db (PERSISTENT host volume, survives redeploys). Two tables:
//   kegs        — one row per physical keg (identity + current state; see keg-management-design.md)
//   keg_events  — append-only log; every action (clean/seal-replace/fill/tap/…) is a row.
// Seal age & clean age are computed in kegs.mjs FROM these dates/events, never hand-set.
//
// Zero external deps. DB_PATH env overrides the file (tests use :memory:).

import { DatabaseSync } from 'node:sqlite';

let _db = null;
export function db() {
  if (_db) return _db;
  const DB_PATH = process.env.DB_PATH || '/data/kegs.db';
  _db = new DatabaseSync(DB_PATH);
  if (DB_PATH !== ':memory:') _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec('PRAGMA foreign_keys = ON;');
  initSchema(_db);
  return _db;
}

// test hook: drop the cached handle so a new DB_PATH takes effect.
export function _resetForTest() { if (_db) { try { _db.close(); } catch { /* */ } } _db = null; }

function initSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS kegs (
      id            TEXT PRIMARY KEY,          -- "keg-001"; in the QR, immutable
      label         TEXT NOT NULL,
      type          TEXT DEFAULT 'corny-ball-lock',
      size_l        REAL DEFAULT 19,
      purchased_at  TEXT,
      status        TEXT NOT NULL DEFAULT 'dirty',
      tap           INTEGER,
      beer_batch    TEXT, beer_style TEXT, beer_abv REAL, filled_at TEXT,
      beer_srm      REAL, beer_ibu REAL, beer_fg REAL, beer_og REAL,
      lid_seal_at   TEXT, lid_seal_life  INTEGER DEFAULT 730,
      post_seal_at  TEXT, post_seal_life INTEGER DEFAULT 365,
      dip_seal_at   TEXT, dip_seal_life  INTEGER DEFAULT 365,
      cleaned_at    TEXT, clean_type TEXT, clean_life INTEGER DEFAULT 30,
      retired_at    TEXT, notes TEXT,
      created_at    TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS keg_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      keg_id  TEXT NOT NULL REFERENCES kegs(id) ON DELETE CASCADE,
      at      TEXT NOT NULL,
      action  TEXT NOT NULL,
      detail  TEXT,                            -- JSON
      by      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_keg ON keg_events(keg_id, at DESC);
    CREATE TABLE IF NOT EXISTS tap_lines (
      tap         INTEGER PRIMARY KEY,         -- 1..8
      label       TEXT NOT NULL,
      cleaned_at  TEXT,
      clean_life  INTEGER DEFAULT 14,
      current_keg TEXT,
      notes       TEXT,
      updated_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS tap_events (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      tap    INTEGER NOT NULL REFERENCES tap_lines(tap) ON DELETE CASCADE,
      at     TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tapevents ON tap_events(tap, at DESC);
  `);
  // ── migrations: add columns to an ALREADY-EXISTING kegs table (CREATE IF NOT EXISTS
  // won't). Idempotent — only adds a column when it's missing. SQLite ADD COLUMN is safe
  // + cheap (no table rewrite). Grow this list as the schema evolves.
  const have = new Set(d.prepare(`PRAGMA table_info(kegs)`).all().map((c) => c.name));
  const addCols = [
    ['beer_srm', 'REAL'], ['beer_ibu', 'REAL'], ['beer_fg', 'REAL'], ['beer_og', 'REAL'],
  ];
  for (const [col, type] of addCols) {
    if (!have.has(col)) d.exec(`ALTER TABLE kegs ADD COLUMN ${col} ${type}`);
  }
}

// ── tap lines ──────────────────────────────────────────────────────────────
const TAP_COLS = ['label', 'cleaned_at', 'clean_life', 'current_keg', 'notes'];

export function listTaps() { return db().prepare('SELECT * FROM tap_lines ORDER BY tap').all(); }
export function getTap(tap) { return db().prepare('SELECT * FROM tap_lines WHERE tap = ?').get(tap) || null; }

/** Ensure taps 1..count exist (idempotent seed). */
export function ensureTaps(count, at) {
  const stmt = db().prepare('INSERT OR IGNORE INTO tap_lines (tap, label, clean_life, updated_at) VALUES (?,?,?,?)');
  for (let t = 1; t <= count; t++) stmt.run(t, `Tap ${t}`, 14, at);
}

export function patchTap(tap, patch, at) {
  const keys = Object.keys(patch).filter((k) => TAP_COLS.includes(k));
  if (keys.length === 0) return getTap(tap);
  const setSql = keys.map((k) => `${k} = @${k}`).join(', ');
  const params = { tap, updated_at: at };
  for (const k of keys) params[k] = patch[k];
  db().prepare(`UPDATE tap_lines SET ${setSql}, updated_at = @updated_at WHERE tap = @tap`).run(params);
  return getTap(tap);
}

export function addTapEvent(tap, { action, at, detail = {} }) {
  db().prepare('INSERT INTO tap_events (tap, at, action, detail) VALUES (?,?,?,?)')
    .run(tap, at, action, JSON.stringify(detail ?? {}));
}
export function tapEventsFor(tap, limit = 50) {
  return db().prepare('SELECT * FROM tap_events WHERE tap = ? ORDER BY at DESC, id DESC LIMIT ?')
    .all(tap, limit).map((e) => ({ ...e, detail: safeParse(e.detail) }));
}

// column list for kegs (kept in one place for insert/update)
const COLS = ['label', 'type', 'size_l', 'purchased_at', 'status', 'tap', 'beer_batch',
  'beer_style', 'beer_abv', 'beer_srm', 'beer_ibu', 'beer_fg', 'beer_og', 'filled_at',
  'lid_seal_at', 'lid_seal_life', 'post_seal_at',
  'post_seal_life', 'dip_seal_at', 'dip_seal_life', 'cleaned_at', 'clean_type', 'clean_life',
  'retired_at', 'notes'];

export function listKegs() {
  return db().prepare('SELECT * FROM kegs ORDER BY id').all();
}
export function getKeg(id) {
  return db().prepare('SELECT * FROM kegs WHERE id = ?').get(id) || null;
}
export function listIds() {
  return db().prepare('SELECT id FROM kegs').all().map((r) => r.id);
}

/** Create a keg. `id` + `at` (iso) required; other fields optional. Returns the row. */
export function createKeg({ id, label, at, ...rest }) {
  const now = at;
  db().prepare(`INSERT INTO kegs (id, label, status, created_at, updated_at,
    type, size_l, purchased_at, lid_seal_at, post_seal_at, dip_seal_at, cleaned_at, clean_type, notes)
    VALUES (@id,@label,@status,@created_at,@updated_at,@type,@size_l,@purchased_at,@lid_seal_at,@post_seal_at,@dip_seal_at,@cleaned_at,@clean_type,@notes)`)
    .run({
      id, label: label || id, status: rest.status || 'dirty', created_at: now, updated_at: now,
      type: rest.type ?? 'corny-ball-lock', size_l: rest.size_l ?? 19, purchased_at: rest.purchased_at ?? null,
      lid_seal_at: rest.lid_seal_at ?? null, post_seal_at: rest.post_seal_at ?? null, dip_seal_at: rest.dip_seal_at ?? null,
      cleaned_at: rest.cleaned_at ?? null, clean_type: rest.clean_type ?? null, notes: rest.notes ?? null,
    });
  addEvent(id, { action: 'created', at: now, detail: {} });
  return getKeg(id);
}

/** Merge a partial patch onto a keg + bump updated_at. Only known columns are written. */
export function patchKeg(id, patch, at) {
  const keys = Object.keys(patch).filter((k) => COLS.includes(k));
  if (keys.length === 0) { touch(id, at); return getKeg(id); }
  const setSql = keys.map((k) => `${k} = @${k}`).join(', ');
  const params = { id, updated_at: at };
  for (const k of keys) params[k] = patch[k];
  db().prepare(`UPDATE kegs SET ${setSql}, updated_at = @updated_at WHERE id = @id`).run(params);
  return getKeg(id);
}
function touch(id, at) { db().prepare('UPDATE kegs SET updated_at = ? WHERE id = ?').run(at, id); }

/** Append an event to the log. */
export function addEvent(kegId, { action, at, detail = {}, by = null }) {
  db().prepare('INSERT INTO keg_events (keg_id, at, action, detail, by) VALUES (?,?,?,?,?)')
    .run(kegId, at, action, JSON.stringify(detail ?? {}), by);
}

/** Recent events for a keg (newest first). */
export function kegEvents(kegId, limit = 50) {
  return db().prepare('SELECT * FROM keg_events WHERE keg_id = ? ORDER BY at DESC, id DESC LIMIT ?')
    .all(kegId, limit)
    .map((e) => ({ ...e, detail: safeParse(e.detail) }));
}
function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

export function deleteKeg(id) { db().prepare('DELETE FROM kegs WHERE id = ?').run(id); }
