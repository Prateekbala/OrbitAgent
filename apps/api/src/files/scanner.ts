import { connect } from 'node:net';
import { createReadStream, type ReadStream } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
export interface FileScanner {
  scan(path: string, signal: AbortSignal): Promise<'clean' | 'development_only'>;
}
export class DevelopmentScanner implements FileScanner {
  async scan(_path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    return 'development_only' as const;
  }
}
export class ClamAvScanner implements FileScanner {
  constructor(
    private readonly host: string,
    private readonly port = 3310,
  ) {}
  async scan(path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const socket = connect({ host: this.host, port: this.port, signal });
    socket.setTimeout(30000, () => socket.destroy(new Error('Scanner timed out.')));
    let stream: ReadStream | undefined;
    let response = '';
    const completion = finished(socket, { cleanup: true });
    void completion.catch(() => {});
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
      if (response.length > 4096) socket.destroy(new Error('Invalid scanner response.'));
      if (response.includes('\0')) socket.end();
    });
    try {
      await once(socket, 'connect', { signal });
      stream = createReadStream(path, { highWaterMark: 64 * 1024, signal });
      socket.write('zINSTREAM\0');
      for await (const chunk of stream) {
        const bytes = chunk as Buffer;
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        if (!socket.write(Buffer.concat([length, bytes]))) await once(socket, 'drain', { signal });
      }
      socket.write(Buffer.alloc(4));
      await completion;
      if (!response.includes('\0') || response.replace(/\0.*$/s, '').trim() !== 'stream: OK')
        throw new Error(response.includes(' FOUND') ? 'FILE_INFECTED' : 'File scanning failed.');
      return 'clean' as const;
    } finally {
      stream?.destroy();
      socket.destroy();
    }
  }
}
