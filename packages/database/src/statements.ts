export function statements(sql: string): string[] {
  const result: string[] = [];
  let start = 0,
    quote = '',
    dollar = '',
    block = 0,
    line = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i],
      next = sql[i + 1];
    if (line) {
      if (char === '\n') line = false;
      continue;
    }
    if (block) {
      if (char === '/' && next === '*') {
        block++;
        i++;
      } else if (char === '*' && next === '/') {
        block--;
        i++;
      }
      continue;
    }
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        i += dollar.length - 1;
        dollar = '';
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) i++;
        else quote = '';
      }
      continue;
    }
    if (char === '-' && next === '-') {
      line = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      block = 1;
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '$') {
      const match = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/);
      if (match) {
        dollar = match[0];
        i += dollar.length - 1;
        continue;
      }
    }
    if (char === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement) result.push(statement);
      start = i + 1;
    }
  }
  if (quote || dollar || block) throw new Error('Unterminated SQL migration literal or comment.');
  const tail = sql.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}
