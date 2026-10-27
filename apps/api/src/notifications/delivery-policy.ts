import type { DeliveryPreferences } from '@ao/contracts/delivery';
const formatters = new Map<string, Intl.DateTimeFormat>();
function localMinute(date: Date, timezone: string) {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size >= 256) formatters.clear();
    formatters.set(timezone, f);
  }
  const parts = f.formatToParts(date);
  return (
    Number(parts.find((p) => p.type === 'hour')!.value) * 60 +
    Number(parts.find((p) => p.type === 'minute')!.value)
  );
}
export function inQuietHours(date: Date, p: DeliveryPreferences) {
  if (p.quietStart === null || p.quietEnd === null) return false;
  const minute = localMinute(date, p.timezone);
  return p.quietStart < p.quietEnd
    ? minute >= p.quietStart && minute < p.quietEnd
    : minute >= p.quietStart || minute < p.quietEnd;
}
export function nextDeliveryAt(date: Date, p: DeliveryPreferences, channel: 'push' | 'email') {
  let at = new Date(date.getTime() + p.batchMinutes * 60000);
  if (channel === 'email' && p.email === 'hourly')
    at = new Date(Math.ceil(at.getTime() / 3600000) * 3600000);
  if (channel === 'email' && p.email === 'daily') {
    at = new Date(Math.ceil(at.getTime() / 60000) * 60000);
    for (let minute = 0; minute < 60 * 49; minute++, at = new Date(at.getTime() + 60000))
      if (localMinute(at, p.timezone) === 540) break;
  }
  for (let minute = 0; minute < 60 * 49; minute++) {
    if (!inQuietHours(at, p)) return at;
    at = new Date(Math.ceil((at.getTime() + 1) / 60000) * 60000);
  }
  throw new Error('No notification delivery window.');
}
