import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { transcribeAudio } from './transcription.js';

const path = process.argv[2];
let file: Awaited<ReturnType<typeof open>> | undefined;
try {
  if (!path || process.argv.length !== 3)
    throw new Error('Usage: npm run audio:transcribe -- /absolute/path/to/audio.wav');
  if (process.env.TRANSCRIPTION_ENABLED !== 'true')
    throw new Error('Set TRANSCRIPTION_ENABLED=true to explicitly enable audio delivery to Groq.');
  file = await open(resolve(path), 'r');
  const info = await file.stat();
  if (!info.isFile() || info.size < 1 || info.size > 25 * 1024 * 1024)
    throw new Error('Choose a regular audio file no larger than 25 MiB.');
  const bytes = Buffer.alloc(info.size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) throw new Error('The audio file changed while reading.');
    offset += bytesRead;
  }
  const output = await transcribeAudio(bytes, AbortSignal.timeout(120000));
  const directory = resolve('.data/transcripts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const destination = resolve(directory, randomUUID() + '.json');
  await writeFile(destination, JSON.stringify(output, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Transcript saved to ' + destination);
} catch (error) {
  console.error(
    error instanceof Error && !('code' in error)
      ? error.message
      : 'Audio transcription failed. Check the audio file and Groq configuration.',
  );
  process.exitCode = 1;
} finally {
  await file?.close();
}
