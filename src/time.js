// Time-zone helpers built on Intl, so posting slots follow the user's local
// wall-clock time (including daylight-saving changes) without extra libraries.

const fmtCache = new Map();

function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      })
    );
  }
  return fmtCache.get(tz);
}

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function isValidTimezone(tz) {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

// Wall-clock parts of an instant in a time zone. weekday: 1 = Monday ... 7 = Sunday.
export function zonedParts(date, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(date)) {
    if (p.type === 'weekday') out.weekday = WEEKDAYS[p.value];
    else if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

function offsetMs(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// The UTC instant for a wall-clock time in a zone. Times that don't exist
// (skipped by a DST jump) resolve to the moment just after the jump.
export function zonedToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMs(new Date(guess), tz);
  const t1 = guess - first;
  const second = offsetMs(new Date(t1), tz);
  if (second === first) return new Date(t1);
  const t2 = guess - second;
  if (offsetMs(new Date(t2), tz) === second) return new Date(t2);
  // The wall time falls in a DST gap: use the later instant (just after the jump).
  return new Date(Math.max(t1, t2));
}

// Next free queue slot for a channel.
// schedule: { days: [1..7], times: ["HH:MM"] }; taken: Set of ISO strings already used.
export function nextSlot(schedule, tz, taken, now = new Date(), horizonDays = 120) {
  const days = new Set(schedule?.days?.length ? schedule.days : [1, 2, 3, 4, 5, 6, 7]);
  const times = [...(schedule?.times || [])]
    .filter((t) => /^\d{2}:\d{2}$/.test(t))
    .sort();
  if (!times.length) return null;
  const earliest = now.getTime() + 60_000; // never schedule less than a minute out
  const start = zonedParts(now, tz);
  for (let i = 0; i <= horizonDays; i++) {
    // Walk calendar days in the target zone; Date.UTC normalises month rollover.
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const weekday = ((d.getUTCDay() + 6) % 7) + 1;
    if (!days.has(weekday)) continue;
    for (const t of times) {
      const [hh, mm] = t.split(':').map(Number);
      const slot = zonedToUtc(y, m, day, hh, mm, tz);
      if (slot.getTime() < earliest) continue;
      const iso = slot.toISOString();
      if (!taken.has(iso)) return iso;
    }
  }
  return null;
}
