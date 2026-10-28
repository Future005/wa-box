// Evals for the writing helpers: placeholders and the date sense-check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../public/lib.js');
const R = require('../src/render.js');

// Fixed clock: Wed 28 Oct 2026, 12:00 IST
const NOW = L.istEpoch('2026-10-28', '12:00');
const at = (date, time) => L.istEpoch(date, time);
const sense = (text, date, time, repeat = []) => L.dateSense(text, at(date, time), repeat, NOW);

test('placeholders: browser and server fill them in identically', () => {
  const t = 'Hi {group} 👋 see you {day}, {date}. {Group}!';
  const when = at('2026-10-31', '10:00');
  const a = L.renderMessage(t, 'Weekend Cohort 3', when);
  const b = R.renderMessage(t, { groupName: 'Weekend Cohort 3', at: when });
  assert.equal(a, 'Hi Weekend Cohort 3 👋 see you Saturday, 31 Oct. Weekend Cohort 3!');
  assert.equal(a, b);
});

test('unknown placeholders are reported, known ones are not', () => {
  assert.deepEqual(L.unknownPlaceholders('Hi {name}, {group} {Name} {date}'), ['name']);
  assert.deepEqual(R.unknownPlaceholders('Hi {name}'), ['name']);
  assert.equal(L.hasPlaceholders('no braces'), false);
});

test('"today" + a weekday that is not the send day: warns and offers the right date', () => {
  // Sends Fri 30 Oct, text says "today" and "Saturday"
  const r = sense('Saturday class starts today at 11 AM', '2026-10-30', '09:00');
  assert.equal(r.length, 1);
  assert.match(r[0].text, /Says “today” and “Saturday”, but it sends on Friday/);
  assert.equal(r[0].fixDate, '2026-10-31');
});

test('"tomorrow" + weekday is consistent when sent the day before: no warning', () => {
  assert.deepEqual(sense('Reminder: Saturday class is tomorrow, 11 AM', '2026-10-30', '19:00'), []);
});

test('"tomorrow" + weekday mismatch: fix moves the send to the day before that weekday', () => {
  const r = sense('Sunday session tomorrow!', '2026-10-31', '18:00');   // Sat -> tomorrow is Sun: fine
  assert.deepEqual(r, []);
  const r2 = sense('Sunday session tomorrow!', '2026-10-30', '18:00');  // Fri -> tomorrow is Sat: wrong
  assert.equal(r2[0].fixDate, '2026-10-31');
});

test('"today" + a date that is not the send date', () => {
  const r = sense('Live today, 1st November', '2026-10-31', '09:00');
  assert.match(r[0].text, /Says “today” and “1 Nov”, but it sends Sat 31 Oct/);
  assert.equal(r[0].fixDate, '2026-11-01');
});

test('"today at 11 AM" but sent at 12:30: warns it is after that time', () => {
  const r = sense('Class today at 11 AM', '2026-10-31', '12:30');
  assert.match(r[0].text, /Says 11 AM today, but it sends at 12:30/);
});

test('a weekday that is the day before sending is flagged', () => {
  const r = sense("Here are Saturday's notes", '2026-11-01', '10:00');
  assert.match(r[0].text, /Mentions Saturday, the day before it sends \(Sunday\)/);
});

test('a date before the send date is flagged; dates after are fine', () => {
  assert.match(sense('Deadline Oct 30', '2026-10-31', '10:00')[0].text, /Mentions 30 Oct, which is before it sends/);
  assert.deepEqual(sense('Deadline Nov 5th', '2026-10-31', '10:00'), []);
});

test('weekly messages with a fixed day or date get a {day}/{date} suggestion', () => {
  const r = sense('Saturday class at 11 AM', '2026-10-31', '09:00', [6, 0]);
  assert.match(r[0].text, /repeats every week.*Use \{day\} or \{date\}/);
  assert.deepEqual(sense('{day} class at 11 AM', '2026-10-31', '09:00', [6, 0]), []);
});

test('plain messages with no dates produce no warnings', () => {
  assert.deepEqual(sense('New blog post: https://example.com/blog', '2026-10-31', '10:00'), []);
  assert.deepEqual(sense('Sunday-funday vibes 🎉', '2026-10-31', '10:00'), []); // "Sunday" is the day after: fine
});
