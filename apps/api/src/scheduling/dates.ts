import { businessOffset, businessCount, type BusinessDays } from './business.js';
export function occurrenceDate(
  start: string,
  frequency: 'daily' | 'weekly' | 'monthly' | 'business_daily',
  interval: number,
  index: number,
  calendar?: BusinessDays | null,
): string | null {
  if (frequency === 'business_daily')
    return businessOffset(
      start,
      interval * index,
      calendar ?? { weekdays: [1, 2, 3, 4, 5], holidays: [] },
    );
  const date = new Date(`${start}T12:00:00Z`);
  if (frequency === 'monthly') {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + interval * index);
    const last = new Date(date.getTime());
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    date.setUTCDate(Math.min(day, last.getUTCDate()));
  } else date.setUTCDate(date.getUTCDate() + interval * index * (frequency === 'weekly' ? 7 : 1));
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) return null;
  return date.toISOString().slice(0, 10);
}

export function previewDates(
  rule: {
    start: string;
    frequency: 'daily' | 'weekly' | 'monthly' | 'business_daily';
    interval: number;
    index: number;
    end: string | null;
    paused: boolean;
    calendar?: BusinessDays | null;
  },
  from: string,
  through: string,
) {
  if (rule.paused) return [];
  const start = new Date(`${rule.start}T12:00:00Z`),
    first = new Date(`${from}T12:00:00Z`);
  const distance =
    rule.frequency === 'business_daily'
      ? Math.max(
          0,
          businessCount(
            rule.start,
            from,
            rule.calendar ?? { weekdays: [1, 2, 3, 4, 5], holidays: [] },
          ) - 1,
        )
      : rule.frequency === 'monthly'
        ? (first.getUTCFullYear() - start.getUTCFullYear()) * 12 +
          first.getUTCMonth() -
          start.getUTCMonth()
        : Math.floor((first.getTime() - start.getTime()) / 86400000) /
          (rule.frequency === 'weekly' ? 7 : 1);
  let index = Math.max(rule.index, Math.floor(distance / rule.interval), 0);
  const dates: string[] = [];
  for (let n = 0; n < 64; n++, index++) {
    const date = occurrenceDate(rule.start, rule.frequency, rule.interval, index, rule.calendar);
    if (!date || date > through || (rule.end && date > rule.end)) break;
    if (date >= from) dates.push(date);
  }
  return dates;
}
