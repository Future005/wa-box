// India Standard Time helpers. IST is a fixed UTC+05:30 with no DST,
// so a constant offset is exact.
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "2026-10-31", "09:30" (IST) -> epoch ms */
function istToEpoch(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  const t = /^(\d{2}):(\d{2})$/.exec(time || '');
  if (!m || !t) throw new Error('Invalid date or time');
  const [, y, mo, d] = m.map(Number);
  const [, h, mi] = t.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) throw new Error('Invalid date or time');
  return Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS;
}

/** epoch ms -> { date: 'YYYY-MM-DD', time: 'HH:MM', dow: 0-6 } in IST */
function epochToIst(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  const pad = n => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    dow: d.getUTCDay(),
  };
}

/** IST calendar day key for daily caps */
function istDayKey(ms = Date.now()) {
  return epochToIst(ms).date;
}

/** epoch ms of the next IST midnight after ms */
function nextIstMidnight(ms = Date.now()) {
  const { date } = epochToIst(ms);
  return istToEpoch(date, '00:00') + 24 * 3600 * 1000;
}

/**
 * Next occurrence strictly after `afterMs` at the same IST clock time,
 * on one of the given weekdays (0=Sun..6=Sat).
 */
function nextWeeklyOccurrence(afterMs, time, days) {
  if (!days || !days.length) return null;
  const start = epochToIst(afterMs).date;
  let base = istToEpoch(start, time);
  for (let i = 0; i <= 8; i++) {
    const candidate = base + i * 24 * 3600 * 1000;
    if (candidate > afterMs && days.includes(epochToIst(candidate).dow)) return candidate;
  }
  return null;
}

const DOW3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Wed 28 Oct, 18:51" (IST) for people-facing text */
function prettyIst(ms) {
  if (!ms) return '';
  const d = new Date(ms + IST_OFFSET_MS);
  return `${DOW3[d.getUTCDay()]} ${d.getUTCDate()} ${MON3[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function formatIst(ms) {
  if (!ms) return '';
  const { date, time } = epochToIst(ms);
  return `${date} ${time}`;
}

module.exports = { IST_OFFSET_MS, DAYS, istToEpoch, epochToIst, istDayKey, nextIstMidnight, nextWeeklyOccurrence, formatIst, prettyIst };
