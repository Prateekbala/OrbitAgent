export interface BusinessDays {
  weekdays: number[];
  holidays: string[];
}
const day = 86400000;
function iso(date: Date) {
  return date.toISOString().slice(0, 10);
}
function weekday(date: Date) {
  return date.getUTCDay() || 7;
}
export function businessCount(from: string, through: string, calendar: BusinessDays) {
  if (through < from) return 0;
  const start = new Date(from + 'T12:00:00Z'),
    end = new Date(through + 'T12:00:00Z'),
    days = Math.floor((end.getTime() - start.getTime()) / day) + 1;
  let count = Math.floor(days / 7) * calendar.weekdays.length;
  for (let i = 0; i < days % 7; i++) {
    const d = new Date(start.getTime() + i * day);
    if (calendar.weekdays.includes(weekday(d))) count++;
  }
  for (const holiday of new Set(calendar.holidays))
    if (
      holiday >= from &&
      holiday <= through &&
      calendar.weekdays.includes(weekday(new Date(holiday + 'T12:00:00Z')))
    )
      count--;
  return count;
}
export function businessOffset(
  from: string,
  offset: number,
  calendar: BusinessDays,
): string | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || !calendar.weekdays.length) return null;
  let start = new Date(from + 'T12:00:00Z');
  const holidays = new Set(calendar.holidays);
  for (let i = 0; !calendar.weekdays.includes(weekday(start)) || holidays.has(iso(start)); i++) {
    if (i > calendar.holidays.length + 7) return null;
    start = new Date(start.getTime() + day);
    if (start.getUTCFullYear() > 9999) return null;
  }
  if (offset === 0) return iso(start);
  const first = new Date(start.getTime() + day),
    firstIso = iso(first),
    max = Math.floor((new Date('9999-12-31T12:00:00Z').getTime() - start.getTime()) / day);
  let low = 1,
    high = Math.min(max, (offset + calendar.holidays.length + 7) * 7);
  if (
    high < 1 ||
    businessCount(firstIso, iso(new Date(start.getTime() + high * day)), calendar) < offset
  )
    return null;
  while (low < high) {
    const middle = Math.floor((low + high) / 2),
      through = iso(new Date(start.getTime() + middle * day));
    if (businessCount(firstIso, through, calendar) >= offset) high = middle;
    else low = middle + 1;
  }
  return iso(new Date(start.getTime() + low * day));
}
