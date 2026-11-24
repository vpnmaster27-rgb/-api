export const TASK_TIME_ZONE = 'Asia/Taipei';

function dateKeyFromParts(parts) {
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function taipeiDateKey(value = Date.now()) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (match) return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return dateKeyFromParts(new Intl.DateTimeFormat('en-CA', {
    timeZone: TASK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date));
}

export function taskStartDateKey(task) {
  return taipeiDateKey(task.startAt ?? task.createdAt ?? task.dueAt ?? task.startDate);
}

export function nextDailyDispatchAt(now = Date.now()) {
  const current = new Date(now);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TASK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(current).map(({ type, value }) => [type, value]));
  // Asia/Taipei is UTC+08:00 and has no daylight saving transition.
  let target = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 1, 2);
  if (target <= now) target += 24 * 60 * 60 * 1000;
  return target;
}

export function taipeiTimeIsPastDispatch(now = Date.now()) {
  const current = new Date(now);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TASK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(current).map(({ type, value }) => [type, value]));
  const target = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 1, 2);
  return now >= target;
}
