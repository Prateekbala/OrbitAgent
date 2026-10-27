export function terms(value: string) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('und');
  return [
    ...new Set(
      [...new Intl.Segmenter('und', { granularity: 'word' }).segment(normalized)]
        .filter((v) => v.isWordLike)
        .map((v) => v.segment),
    ),
  ].slice(0, 20000);
}
export function chunks(value: string, size = 1600, overlap = 160) {
  if (size < 1 || overlap < 0 || overlap >= size) throw new Error('Invalid chunk bounds.');
  const points = Array.from(value),
    result: string[] = [];
  for (let start = 0; start < points.length; start += size - overlap) {
    result.push(points.slice(start, start + size).join(''));
    if (start + size >= points.length) break;
  }
  return result;
}
export function cosine(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length || [...a, ...b].some((v) => !Number.isFinite(v))) return 0;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! ** 2;
    bb += b[i]! ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export function assertVectors(vectors: number[][], count: number) {
  if (
    vectors.length !== count ||
    !vectors[0]?.length ||
    vectors[0].length > 4096 ||
    vectors.some(
      (v) =>
        v.length !== vectors[0]!.length ||
        v.every((n) => n === 0) ||
        v.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e6),
    )
  )
    throw new Error('Invalid embedding response.');
}

export function plainText(data: Buffer, contentType: string): string | null {
  if (
    !contentType.startsWith('text/') &&
    !['application/octet-stream', 'application/json', 'application/xml'].includes(contentType)
  )
    return null;
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ? null : value;
  } catch {
    return null;
  }
}
