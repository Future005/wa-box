// The state machines (public/machines.js) must stay complete, match the code, match the engine, and
// match the generated doc. These tests are cheap and catch drift the moment it happens.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wabox-machines-'));
const M = require('../public/machines');

test('every machine is complete: transitions and groups only use defined states; every state has words for people', () => {
  for (const [name, def] of Object.entries(M.machines)) {
    const states = Object.keys(def.states);
    for (const [f, e, t] of def.transitions) {
      assert.ok(f === M.NEW || states.includes(f), `${name}: unknown from-state "${f}"`);
      assert.ok(states.includes(t), `${name}: unknown to-state "${t}"`);
      assert.match(e, /^[a-z_]+$/, `${name}: event names are snake_case`);
    }
    for (const [g, ss] of Object.entries(def.groups || {})) for (const s of ss) assert.ok(states.includes(s), `${name}.${g}: unknown state "${s}"`);
    for (const [s, st] of Object.entries(def.states)) {
      assert.ok(st.label && st.help, `${name}.${s} needs a label and a help line (shown in the app)`);
      assert.ok(['neutral', 'active', 'good', 'warn', 'bad'].includes(st.tone), `${name}.${s}: unknown tone`);
    }
    // "final" = nothing more happens by itself; only a person's action can move it on.
    for (const [s, st] of Object.entries(def.states)) {
      if (!st.final) continue;
      for (const [f, e] of def.transitions) if (f === s) assert.ok(M.PERSON_EVENTS.includes(e), `${name}.${s} is final but "${e}" moves it on by itself`);
    }
  }
});

test('one event never leads to two different places from the same state', () => {
  for (const [name, def] of Object.entries(M.machines)) {
    const seen = new Map();
    for (const [f, e, t] of def.transitions) {
      if (name === 'mode' && f === 'paused' && e === 'resume') continue;   // resume returns to live or practice, by setting
      const k = `${f}|${e}`;
      assert.ok(!seen.has(k) || seen.get(k) === t, `${name}: "${e}" from "${f || '(new)'}" goes to both ${seen.get(k)} and ${t}`);
      seen.set(k, t);
    }
  }
});

test('every status the server writes is a defined state', () => {
  const src = ['scheduler.js', 'server.js', 'api_v1.js', 'hooks.js', 'jobs.js', 'groups.js']
    .map(f => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')).join('\n');
  const known = new Set(['job', 'send', 'delivery', 'connection'].flatMap(m => Object.keys(M.machines[m].states)));
  const written = new Set([...src.matchAll(/status\s*[:=]\s*'([a-z_]+)'/g)].map(m => m[1]));
  // 'running'/'stalled' in /health/monitor describe the scheduler loop, not a stored status.
  for (const s of written) if (!['stalled'].includes(s)) assert.ok(known.has(s), `"${s}" is written as a status but isn't in public/machines.js`);
});

test('the database records a change the machines do not allow, without blocking it', () => {
  const { db } = require('../src/db');
  const SM = require('../src/machines');
  db.exec('DELETE FROM state_violations');
  const id = db.prepare(`INSERT INTO jobs(title,message,groups_json,time_ist,run_at,start_at,gap_min,gap_max,repeat_days,status,created_by,updated_by,created_at,updated_at)
    VALUES('','x','[]','10:00',0,0,40,120,'[]','scheduled','t','t',0,0)`).run().lastInsertRowid;
  db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);          // allowed
  db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(id);        // allowed
  db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);          // not allowed: aborted is final
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status, 'running', 'never blocked');
  const v = SM.violations();
  assert.deepEqual(v.map(x => [x.machine, x.from_state, x.to_state]), [['job', 'cancelled', 'running']]);
  assert.equal(SM.report(), 1, 'reported once');
  assert.equal(SM.report(), 0);
  assert.match(db.prepare("SELECT message FROM events WHERE kind='state' ORDER BY id DESC").get().message, /Unexpected Message change "cancelled" → "running"/);
  db.prepare("INSERT INTO sends(job_id,occurrence,group_id,group_name,status) VALUES(?,0,'g','G','sent')").run(id);   // a send can't start as sent
  assert.deepEqual(SM.violations({ unreportedOnly: true }).map(x => [x.machine, x.from_state, x.to_state]), [['send', '', 'sent']]);
  db.exec('DELETE FROM state_violations');
});

test('user actions are guarded by the machines', () => {
  assert.ok(M.can('send', 'unconfirmed', 'mark_sent'));
  assert.ok(!M.can('send', 'sent', 'mark_sent'));
  assert.ok(M.can('send', 'missed', 'send_again'));
  assert.ok(!M.can('send', 'cancelled', 'send_again'));
  assert.equal(M.next('job', 'done_with_errors', 'send_again'), 'running');
  assert.equal(M.next('job', 'cancelled', 'send_again'), null);
});

test('the engine and the app agree on the WhatsApp connection machine', () => {
  const engineStates = path.join(__dirname, '../../engine/src/states.js');
  if (!fs.existsSync(engineStates)) return;   // inside the app's Docker build the engine isn't present
  const E = require(engineStates);
  const app = M.machines.connection;
  assert.deepEqual(E.STATES.slice().sort(), Object.keys(app.states).filter(s => !app.states[s].app).sort());
  const key = t => t.join('|');
  assert.deepEqual(E.TRANSITIONS.map(key).sort(), app.transitions.map(key).sort());
});

test('docs/STATE-MACHINES.md is generated from the current definitions (run npm run states:doc)', () => {
  const gen = path.join(__dirname, '../scripts/states-doc.js');
  if (!fs.existsSync(gen)) return;   // not part of the Docker build
  const { render, DOC } = require(gen);
  assert.equal(fs.readFileSync(DOC, 'utf8'), render());
});
