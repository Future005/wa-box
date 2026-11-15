// Keeps the stored state machines honest. The definitions live in public/machines.js (shared with the
// browser); here we teach SQLite to check every status change against them.
//
// For each machine with `enforced: 'database'`, a trigger compares OLD.status -> NEW.status (and the
// status of a new row) with the allowed transitions. Anything else is written to `state_violations`.
// We record instead of refusing on purpose: a mistake in a definition must never stop a message from
// being sent or recorded. The test suite fails on any violation; in production the scheduler logs
// each one once (System → Events), so a gap shows up without hurting anyone.
const M = require('../public/machines');
const { db, logEvent } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS state_transitions (
  machine TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL,
  PRIMARY KEY (machine, from_state, to_state)
);
CREATE TABLE IF NOT EXISTS state_violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, machine TEXT NOT NULL, row_id INTEGER, from_state TEXT, to_state TEXT,
  reported INTEGER NOT NULL DEFAULT 0
);
`);

const tableExists = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

/** (Re)load the allowed transitions and (re)create the checks for every table that exists. Idempotent. */
function install() {
  const put = db.prepare('INSERT OR IGNORE INTO state_transitions(machine, from_state, to_state) VALUES(?,?,?)');
  db.transaction(() => {
    for (const [name, def] of Object.entries(M.machines)) {
      if (def.enforced !== 'database') continue;
      db.prepare('DELETE FROM state_transitions WHERE machine=?').run(name);
      for (const [f, t] of M.pairs(name)) put.run(name, f, t);
      if (!tableExists(def.table)) continue;
      const allowed = (from, to) => `EXISTS (SELECT 1 FROM state_transitions WHERE machine='${name}' AND from_state=${from} AND to_state=${to})`;
      const log = (from, to) => `INSERT INTO state_violations(at, machine, row_id, from_state, to_state)
        VALUES (CAST(unixepoch('subsec') * 1000 AS INTEGER), '${name}', NEW.id, ${from}, ${to});`;
      db.exec(`
        DROP TRIGGER IF EXISTS sm_${name}_insert;
        CREATE TRIGGER sm_${name}_insert AFTER INSERT ON ${def.table}
          WHEN NOT ${allowed("''", 'NEW.status')}
          BEGIN ${log("''", 'NEW.status')} END;
        DROP TRIGGER IF EXISTS sm_${name}_update;
        CREATE TRIGGER sm_${name}_update AFTER UPDATE OF status ON ${def.table}
          WHEN OLD.status IS NOT NEW.status AND NOT ${allowed('OLD.status', 'NEW.status')}
          BEGIN ${log('OLD.status', 'NEW.status')} END;
      `);
    }
  })();
}

function violations({ unreportedOnly = false } = {}) {
  return db.prepare(`SELECT * FROM state_violations ${unreportedOnly ? 'WHERE reported = 0' : ''} ORDER BY id`).all();
}

/** Log each new violation once as a warning event. Cheap; called from the scheduler tick. */
function report() {
  const rows = violations({ unreportedOnly: true });
  for (const v of rows) {
    logEvent('warn', 'state', `Unexpected ${M.machines[v.machine]?.title || v.machine} change "${v.from_state || '(new)'}" → "${v.to_state}" (row ${v.row_id}). Nothing was blocked; please report it so the state definitions can be fixed.`);
    db.prepare('UPDATE state_violations SET reported = 1 WHERE id = ?').run(v.id);
  }
  return rows.length;
}

/** SQL list for a named group, e.g. inList('send', 'didNotGet') → "('failed','missed',…)". Built from constants only. */
function inList(machine, group) {
  return `(${M.group(machine, group).map(s => `'${s.replace(/'/g, "''")}'`).join(',')})`;
}

install();

module.exports = { ...M, install, violations, report, inList };
