// Shared by the browser (window.WABoxLib) and the test suite (require).
// Placeholders and the date sense-check. India time (IST, UTC+05:30) throughout.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WABoxLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const IST = 330 * 60000, DAY = 86400000;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = n => String(n).padStart(2, '0');
  const ist = ms => { const d = new Date(ms + IST); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(),
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` }; };
  const istEpoch = (date, time) => { const [y, m, d] = date.split('-').map(Number); const [h, mi] = time.split(':').map(Number); return Date.UTC(y, m - 1, d, h, mi) - IST; };
  const shortDate = ms => { const x = ist(ms); return `${DOW[x.dow]} ${x.d} ${MON[x.m]}`; };

  // Placeholders (same rules as the server's src/render.js)
  const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function renderMessage(text, groupName, at) {
    const x = ist(at || Date.now());
    const v = { group: groupName || 'Your group', day: DAYS_FULL[x.dow], date: `${x.d} ${MON[x.m]}` };
    return String(text).replace(/\{(group|day|date)\}/gi, (_, k) => v[k.toLowerCase()]);
  }
  const hasPlaceholders = t => /\{(group|day|date)\}/i.test(t);
  const unknownPlaceholders = t => [...new Set((String(t).match(/\{[a-z_]{2,20}\}/gi) || []).map(x => x.slice(1, -1).toLowerCase()))].filter(k => !['group', 'day', 'date'].includes(k));

  // Date sense-check: does what the text says match when it's sent?
  const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const monthIdx = m => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m.slice(0, 3).toLowerCase());
  function nextDateWithDow(dow, fromMs = Date.now()) { for (let i = 0; i < 8; i++) { const x = ist(fromMs + i * DAY); if (x.dow === dow) return x.date; } return null; }
  function dateSense(text, runAt, repeatDays, now = Date.now()) {
    const out = [];
    if (!text || !runAt) return out;
    const t = text.toLowerCase();
    const relM = t.match(/\b(today|tonight|this (?:morning|afternoon|evening)|tomorrow|tmrw)\b/);
    const rel = relM ? (/tomorrow|tmrw/.test(relM[1]) ? 1 : 0) : null;
    const relWord = relM ? relM[1] : '';
    const autoDay = /\{(day|date)\}/i.test(text);
    const days = new Set([...t.matchAll(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/g)].map(m => DAYS_FULL.map(d => d.toLowerCase()).indexOf(m[1])));
    const send = ist(runAt);
    const sendMin = Number(send.time.slice(0, 2)) * 60 + Number(send.time.slice(3));
    const dates = [];
    for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\b|\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g'))) {
      const d = Number(m[1] || m[4]); const mo = monthIdx(m[2] || m[3]);
      if (d >= 1 && d <= 31 && mo >= 0) {
        let y = send.y; if (mo < send.m - 6) y++;
        dates.push({ key: `${y}-${pad(mo + 1)}-${pad(d)}`, label: `${d} ${MON[mo]}` });
      }
    }
    const times = [...t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/g)].map(m => { let h = Number(m[1]) % 12; if (m[3] === 'pm') h += 12; return { min: h * 60 + Number(m[2] || 0), label: m[0].toUpperCase().replace(/\s+/, ' ') }; });
    const sendDayName = DAYS_FULL[send.dow];
    const addDays = (dateKey, n) => ist(istEpoch(dateKey, '12:00') + n * DAY).date;
    if (repeatDays.length) {
      if (!autoDay && (days.size || dates.length)) out.push({ text: `This repeats every week, but the text names a fixed ${dates.length ? 'date' : 'day'}. Use {day} or {date} so each week says the right one.` });
      return out;
    }
    if (rel !== null && !autoDay) {
      for (const w of days) {
        if ((send.dow + rel) % 7 !== w) {
          const fix = nextDateWithDow((w - rel + 7) % 7, now);
          out.push({ text: `Says “${relWord}” and “${DAYS_FULL[w]}”, but it sends on ${sendDayName}.`, fixDate: fix });
        }
      }
      for (const d of dates) {
        if (addDays(send.date, rel) !== d.key) {
          const fix = addDays(d.key, -rel);
          out.push({ text: `Says “${relWord}” and “${d.label}”, but it sends ${shortDate(runAt)}.`, fixDate: istEpoch(fix, send.time) > now ? fix : null });
        }
      }
      if (rel === 0 && times.length && times.some(x => x.min < sendMin)) {
        const early = times.find(x => x.min < sendMin);
        out.push({ text: `Says ${early.label} ${relWord}, but it sends at ${send.time}, after that time.` });
      }
    } else if (!autoDay) {
      for (const w of days) if ((w - send.dow + 7) % 7 === 6) out.push({ text: `Mentions ${DAYS_FULL[w]}, the day before it sends (${sendDayName}).` });
      for (const d of dates) if (d.key < send.date) out.push({ text: `Mentions ${d.label}, which is before it sends (${shortDate(runAt)}).` });
      const sameDay = days.has(send.dow) || dates.some(d => d.key === send.date);
      if (sameDay && times.some(x => x.min < sendMin)) out.push({ text: `Mentions ${times.find(x => x.min < sendMin).label} on the day it sends, but it goes out at ${send.time}.` });
    }
    return out.slice(0, 2);
  }


  return { renderMessage, hasPlaceholders, unknownPlaceholders, dateSense, nextDateWithDow, DAYS_FULL, ist, istEpoch, shortDate };
});
