export function messageDay(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function messageDayLabel(value: string, now = new Date()) {
  if (messageDay(value) === messageDay(now.toISOString())) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (messageDay(value) === messageDay(yesterday.toISOString())) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(new Date(value).getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
  }).format(new Date(value));
}
