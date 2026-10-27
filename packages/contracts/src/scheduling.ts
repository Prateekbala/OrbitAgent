import { z } from 'zod';
const date = z.iso.date().refine((value) => value >= '0001-01-01' && value <= '9999-12-31');
const version = z.number().int().min(0).max(2147483646);
export const scheduleTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const scheduleZone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Choose an IANA time zone.');
export const recurrenceInput = z
  .object({
    version,
    businessCalendarId: z.uuid().optional(),
    frequency: z.enum(['daily', 'weekly', 'monthly', 'business_daily']),
    interval: z.number().int().min(1).max(365),
    startDate: date,
    endDate: date.nullable(),
    timeZone: scheduleZone,
    localTime: scheduleTime,
    leadDays: z.number().int().min(0).max(365).default(0),
    paused: z.boolean(),
  })
  .strict()
  .refine((v) => !v.endDate || v.endDate >= v.startDate, 'End date must follow the first date.');
export const reminderInput = z
  .object({
    version,
    enabled: z.boolean(),
    daysBefore: z.number().int().min(0).max(365),
    localTime: scheduleTime,
    timeZone: scheduleZone,
  })
  .strict();
export interface TaskRecurrence {
  id: string;
  task_id: string;
  frequency: 'daily' | 'weekly' | 'monthly' | 'business_daily';
  business_calendar?: {
    weekdays: number[];
    holidays: string[];
    name: string;
    version: number;
    id: string;
  } | null;
  interval: number;
  start_date: string;
  end_date: string | null;
  time_zone: string;
  local_time: string;
  lead_days: number;
  next_date: string | null;
  next_run_at: string | null;
  paused: boolean;
  paused_reason: string | null;
  version: number;
  occurrence_count: number;
}
export interface TaskReminder {
  enabled: boolean;
  days_before: number;
  local_time: string;
  time_zone: string;
  version: number;
}
export interface TaskScheduling {
  recurrence: TaskRecurrence | null;
  reminder: TaskReminder | null;
  origin: { source_task_id: string; occurrence_date: string } | null;
}
export interface RecurringTaskPage {
  items: (TaskRecurrence & { title: string; preview_dates: string[] })[];
  next_after: string | null;
}
