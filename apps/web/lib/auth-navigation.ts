export function entryPath(path: '/app' | '/sign-in' | '/sign-up', search = '') {
  const source = new URLSearchParams(search);
  const context = new URLSearchParams();
  for (const key of ['workspace', 'message']) {
    const value = source.get(key);
    if (value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
      context.set(key, value);
  }
  return path + (context.size ? `?${context}` : '');
}
