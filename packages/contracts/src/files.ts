import { z } from 'zod';
export const maxFileBytes = 25 * 1024 * 1024;
export const maxAttachments = 10;
export const fileInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(
        (v) => !/[\x00-\x1f\x7f/\\]/.test(v),
        'Choose a filename without paths or control characters.',
      ),
    size: z.number().int().positive().max(maxFileBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    clientId: z.uuid(),
  })
  .strict();
export interface FileAttachment {
  id: string;
  name: string;
  size: number;
  content_type: string;
  has_preview: boolean;
}
export interface FileUpload extends FileAttachment {
  status: 'pending' | 'uploading' | 'ready' | 'attached' | 'rejected' | 'deleting' | 'deleted';
  scan_status: 'pending' | 'clean' | 'development_only' | 'infected';
}
