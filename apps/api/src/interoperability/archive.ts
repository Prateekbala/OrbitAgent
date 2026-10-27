import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
export interface ArchiveEntry {
  name: string;
  size: number;
  body: AsyncIterable<Uint8Array> | Buffer;
}
export async function* tar(entries: AsyncIterable<ArchiveEntry>): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(entry.name) ||
      entry.name.includes('..') ||
      entry.name.startsWith('/') ||
      Buffer.byteLength(entry.name) > 255 ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > 0o77777777777
    )
      throw new Error('Invalid archive entry.');
    const header = Buffer.alloc(512);
    let name = entry.name,
      prefix = '';
    if (name.length > 100) {
      const split = name.lastIndexOf('/', 155);
      if (split < 1 || name.length - split - 1 > 100)
        throw new Error('Invalid archive path length.');
      prefix = name.slice(0, split);
      name = name.slice(split + 1);
    }
    header.write(name, 0, 100, 'ascii');
    header.write(prefix, 345, 155, 'ascii');
    const octal = (n: number, at: number, length: number) =>
      header.write(n.toString(8).padStart(length - 1, '0') + '\0', at, length, 'ascii');
    octal(0o600, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(entry.size, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((n, b) => n + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    yield header;
    let size = 0;
    if (Buffer.isBuffer(entry.body)) {
      size = entry.body.length;
      yield entry.body;
    } else
      for await (const bytes of entry.body) {
        size += bytes.length;
        if (size > entry.size) throw new Error('Archive content exceeded declared size.');
        yield Buffer.from(bytes);
      }
    if (size !== entry.size) throw new Error('Archive content length mismatch.');
    if (size % 512) yield Buffer.alloc(512 - (size % 512));
  }
  yield Buffer.alloc(1024);
}
export function textEntry(name: string, text: string): ArchiveEntry {
  const body = Buffer.from(text);
  return { name, size: body.length, body };
}
export function archiveStream(entries: AsyncIterable<ArchiveEntry>) {
  return Readable.from(tar(entries));
}
export async function* verifiedFile(
  body: AsyncIterable<Uint8Array>,
  sha256: string,
  check: () => Promise<void>,
) {
  const hash = createHash('sha256');
  for await (const chunk of body) {
    await check();
    hash.update(chunk);
    yield chunk;
  }
  if (hash.digest('hex') !== sha256) throw new Error('Export file checksum mismatch.');
}
