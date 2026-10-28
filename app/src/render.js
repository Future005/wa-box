// Placeholders filled in per group at send time:
//   {group}  the group's name           "Weekend Cohort 3"
//   {day}    weekday of the send (IST)  "Saturday"
//   {date}   date of the send (IST)     "31 Oct"
// The same function runs in the browser preview (public/app.js keeps an identical copy),
// and the filled-in text is what the duplicate guard and the send check compare.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST = 330 * 60000;
const KNOWN = ['group', 'day', 'date'];

function renderMessage(text, { groupName = '', at = Date.now() } = {}) {
  const d = new Date(at + IST);
  const values = { group: groupName, day: DAYS[d.getUTCDay()], date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` };
  return String(text).replace(/\{(group|day|date)\}/gi, (_, k) => values[k.toLowerCase()]);
}

/** Placeholders like {name} that we don't know; they'd be sent as typed. */
function unknownPlaceholders(text) {
  return [...new Set((String(text).match(/\{[a-z_]{2,20}\}/gi) || []).map(s => s.slice(1, -1).toLowerCase()))].filter(k => !KNOWN.includes(k));
}

const hasPlaceholders = text => /\{(group|day|date)\}/i.test(String(text));

module.exports = { renderMessage, unknownPlaceholders, hasPlaceholders, KNOWN };
