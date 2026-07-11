// GlassHaus batch database — the complete brewing history of record.
//
// SQLite via node:sqlite (built-in, Node 22+). File lives at /data/batches.db, a
// PERSISTENT host volume (survives container redeploys — verified). Schema per
// docs/batch-database-schema.md: batches + readings (temp/gravity curve) +
// tastings (longitudinal outcome) + scores + events. Purpose: correlate
// process → outcome → score to refine yeast/style profiles.
//
// Zero external deps. `DB_PATH` env overrides the file (tests use :memory:).

import { DatabaseSync } from 'node:sqlite';

// read at OPEN time, not import time — ES imports hoist above a test's env-set, so
// a module-top const would capture the default before the test could override it.
let _db = null;
export function db() {
  if (_db) return _db;
  const DB_PATH = process.env.DB_PATH || '/data/batches.db';
  _db = new DatabaseSync(DB_PATH);
  // WAL is only valid for a file-backed DB (needs a real -wal sidecar file); it's
  // invalid for :memory: and errors. Enable it only for the real file.
  if (DB_PATH !== ':memory:') _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec('PRAGMA foreign_keys = ON;');
  initSchema(_db);
  return _db;
}

// idempotent — safe to call every open. CREATE IF NOT EXISTS only.
function initSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_no INTEGER UNIQUE,          -- Brewfather batchNo (natural key)
      bf_id TEXT,
      name TEXT, style TEXT, style_category TEXT,
      yeast_name TEXT, yeast_product_id TEXT, yeast_type TEXT,
      og REAL, fg REAL, abv REAL, attenuation REAL,
      mash_ph REAL, boil_gravity REAL,
      batch_size_gal REAL, bottling_size_gal REAL,
      profile_id INTEGER, plan_json TEXT,
      pitch_temp_f REAL, peak_temp_f REAL, avg_temp_f REAL, min_temp_f REAL,
      days_primary REAL, days_to_terminal REAL, days_conditioned REAL,
      brew_date INTEGER, ferment_start INTEGER, terminal_confirmed_at INTEGER,
      completed_at INTEGER, kegged_at INTEGER,
      best_rating REAL, best_at_age_days INTEGER,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      t INTEGER NOT NULL, temp_f REAL, gravity REAL, source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_readings_batch_t ON readings(batch_id, t);
    -- one reading per (batch, timestamp, source) — dedupes re-ingested points
    CREATE UNIQUE INDEX IF NOT EXISTS uq_readings ON readings(batch_id, t, source);
    CREATE TABLE IF NOT EXISTS tastings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      tasted_at INTEGER, age_days INTEGER, conditioning_days INTEGER,
      rating REAL, peaked INTEGER DEFAULT 0, descriptor TEXT, context TEXT
    );
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      competition TEXT, score REAL, place TEXT, judged_at INTEGER, feedback TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      t INTEGER, kind TEXT, detail TEXT
    );
  `);
}

const now = () => Date.now();

/** upsert a batch by batch_no; merges provided fields, leaves others intact.
 *  Returns the batch row id. `fields` uses the column names above. */
export function upsertBatch(fields) {
  const d = db();
  if (fields.batch_no == null) throw new Error('upsertBatch requires batch_no');
  const existing = d.prepare('SELECT id FROM batches WHERE batch_no = ?').get(fields.batch_no);
  const cols = Object.keys(fields).filter((k) => k !== 'id');
  if (existing) {
    if (cols.length) {
      const set = cols.map((c) => `${c} = ?`).join(', ');
      d.prepare(`UPDATE batches SET ${set}, updated_at = ? WHERE id = ?`)
        .run(...cols.map((c) => fields[c]), now(), existing.id);
    }
    return existing.id;
  }
  const allCols = [...cols, 'created_at', 'updated_at'];
  const placeholders = allCols.map(() => '?').join(', ');
  const info = d.prepare(`INSERT INTO batches (${allCols.join(', ')}) VALUES (${placeholders})`)
    .run(...cols.map((c) => fields[c]), now(), now());
  return Number(info.lastInsertRowid);
}

export function getBatch(batchNo) {
  return db().prepare('SELECT * FROM batches WHERE batch_no = ?').get(batchNo) || null;
}
export function listBatches(limit = 100) {
  return db().prepare('SELECT * FROM batches ORDER BY COALESCE(ferment_start, brew_date, created_at) DESC LIMIT ?').all(limit);
}

/** bulk-insert readings for a batch; ignores dupes (unique index). points: [{t,temp_f,gravity,source}] */
export function insertReadings(batchId, points) {
  const d = db();
  const stmt = d.prepare('INSERT OR IGNORE INTO readings (batch_id,t,temp_f,gravity,source) VALUES (?,?,?,?,?)');
  const tx = d.prepare('BEGIN'); const commit = d.prepare('COMMIT');
  tx.run();
  let n = 0;
  for (const p of points) { const r = stmt.run(batchId, p.t, p.temp_f ?? null, p.gravity ?? null, p.source ?? null); n += Number(r.changes); }
  commit.run();
  return n;   // number actually inserted (excludes ignored dupes)
}
export function getReadings(batchId) {
  return db().prepare('SELECT t,temp_f,gravity,source FROM readings WHERE batch_id=? ORDER BY t').all(batchId);
}

export function addTasting(batchId, t) {
  const d = db();
  d.prepare(`INSERT INTO tastings (batch_id,tasted_at,age_days,conditioning_days,rating,peaked,descriptor,context)
             VALUES (?,?,?,?,?,?,?,?)`)
    .run(batchId, t.tasted_at ?? now(), t.age_days ?? null, t.conditioning_days ?? null,
         t.rating ?? null, t.peaked ? 1 : 0, t.descriptor ?? null, t.context ?? 'home');
  // maintain the denormalized best-of on the batch for quick queries
  refreshBestRating(batchId);
}
export function getTastings(batchId) {
  return db().prepare('SELECT * FROM tastings WHERE batch_id=? ORDER BY tasted_at').all(batchId);
}
function refreshBestRating(batchId) {
  const d = db();
  const best = d.prepare('SELECT MAX(rating) AS r FROM tastings WHERE batch_id=?').get(batchId);
  const peak = d.prepare('SELECT MIN(age_days) AS a FROM tastings WHERE batch_id=? AND peaked=1').get(batchId);
  d.prepare('UPDATE batches SET best_rating=?, best_at_age_days=?, updated_at=? WHERE id=?')
    .run(best?.r ?? null, peak?.a ?? null, now(), batchId);
}

export function addEvent(batchId, kind, detail = null, t = now()) {
  db().prepare('INSERT INTO events (batch_id,t,kind,detail) VALUES (?,?,?,?)').run(batchId, t, kind, detail);
}
