function escape(value: string) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\r', '')
    .replaceAll('\n', '\\n')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}
function fold(line: string) {
  let result = '',
    part = '',
    length = 0;
  for (const c of line) {
    const bytes = Buffer.byteLength(c);
    if (length + bytes > 75) {
      result += part + '\r\n';
      part = ' ';
      length = 1;
    }
    part += c;
    length += bytes;
  }
  return result + part;
}
export function calendarIcs(workspace: string, tasks: Record<string, unknown>[]) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Orbit//Task Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Orbit assigned tasks',
  ];
  for (const task of tasks) {
    const date = String(task.due_date),
      next = new Date(date + 'T12:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    if (next.getUTCFullYear() > 9999) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${task.id}.${workspace}@orbit.local`,
      `SEQUENCE:${task.version}`,
      `DTSTAMP:${new Date(String(task.updated_at))
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '')}`,
      `DTSTART;VALUE=DATE:${date.replaceAll('-', '')}`,
      `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replaceAll('-', '')}`,
      `SUMMARY:${escape(String(task.title))}`,
      ...(['completed', 'cancelled'].includes(String(task.state))
        ? ['STATUS:CANCELLED']
        : ['STATUS:CONFIRMED']),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
