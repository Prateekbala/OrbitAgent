import { transcriptionModel } from '@ao/models';
import { transcribe } from 'ai';
import { fileTypeFromBuffer } from 'file-type';
import { AppError } from '../lib/errors.js';

export async function transcribeAudio(data: Uint8Array, signal: AbortSignal) {
  if (process.env.TRANSCRIPTION_ENABLED !== 'true')
    throw new AppError(
      503,
      'TRANSCRIPTION_DISABLED',
      'Enable transcription before sending audio to Groq.',
    );
  if (!data.length || data.length > 25 * 1024 * 1024)
    throw new AppError(413, 'AUDIO_SIZE', 'Choose an audio file between 1 byte and 25 MiB.');
  const detected = await fileTypeFromBuffer(data);
  if (
    !detected ||
    ![
      'audio/mpeg',
      'audio/wav',
      'audio/x-wav',
      'audio/flac',
      'audio/ogg',
      'audio/opus',
      'audio/mp4',
      'audio/x-m4a',
      'audio/webm',
      'video/webm',
      'video/mp4',
    ].includes(detected.mime)
  )
    throw new AppError(
      415,
      'AUDIO_FORMAT',
      'Choose a supported MP3, WAV, FLAC, Ogg, M4A, MP4 or WebM file.',
    );
  const model = process.env.TRANSCRIPTION_MODEL || 'groq/whisper-large-v3-turbo';
  const provider = transcriptionModel(model);
  try {
    const result = await transcribe({
      model: provider,
      audio: data,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      maxRetries: 0,
      providerOptions: {
        groq: { responseFormat: 'verbose_json', timestampGranularities: ['segment'] },
      },
      telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
    });
    if (!result.text.trim() || result.text.length > 200000 || result.segments.length > 2000)
      throw new Error('Invalid transcript.');
    return {
      model,
      text: result.text,
      segments: result.segments,
      language: result.language ?? null,
      durationInSeconds: result.durationInSeconds ?? null,
    };
  } catch {
    throw new AppError(
      503,
      'TRANSCRIPTION_PROVIDER_FAILED',
      'Groq could not complete transcription. No automatic retry was made.',
    );
  }
}
