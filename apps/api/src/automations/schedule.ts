import { CronExpressionParser } from 'cron-parser';
import type { AutomationDefinition } from '@ao/contracts/automations';
import { AppError } from '../lib/errors.js';
type Schedule = Extract<AutomationDefinition['trigger'], { kind: 'schedule' }>;
function scheduleParser(schedule: Schedule, after: Date) {
  if (schedule.cron.split(/\s+/).length !== 5 || /(?:\bH\b|[?@])/i.test(schedule.cron))
    throw new AppError(400, 'INVALID_SCHEDULE', 'Use a deterministic five-field cron expression.');
  try {
    return CronExpressionParser.parse(schedule.cron, { tz: schedule.timezone, currentDate: after });
  } catch {
    throw new AppError(400, 'INVALID_SCHEDULE', 'The cron expression is invalid.');
  }
}
export function nextOccurrence(schedule: Schedule, after: Date): Date {
  const parser = scheduleParser(schedule, after);
  for (let i = 0; i < 370; i++) {
    const next = parser.next().toDate();
    if (schedule.dst === 'shift_gap') return next;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: schedule.timezone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(next);
    const hour = Number(parts.find((p) => p.type === 'hour')!.value),
      minute = Number(parts.find((p) => p.type === 'minute')!.value);
    if (
      parser.fields.hour.values.includes(hour as never) &&
      parser.fields.minute.values.includes(minute as never)
    )
      return next;
  }
  throw new AppError(400, 'INVALID_SCHEDULE', 'The schedule has no supported upcoming occurrence.');
}
export function upcoming(schedule: Schedule, after: Date, limit = 10) {
  const dates: string[] = [];
  for (let i = 0; i < limit; i++) {
    after = nextOccurrence(schedule, after);
    dates.push(after.toISOString());
  }
  return dates;
}
export function inQuietHours(d: AutomationDefinition, now: Date) {
  const q = d.participation.quietHours;
  if (!q || q.startHour === q.endHour) return false;
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: q.timezone,
      hourCycle: 'h23',
      hour: '2-digit',
    }).format(now),
  );
  return q.startHour < q.endHour
    ? hour >= q.startHour && hour < q.endHour
    : hour >= q.startHour || hour < q.endHour;
}
