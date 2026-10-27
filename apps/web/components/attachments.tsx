import { FileDetails } from './file-details';
import type { FileAttachment } from '@ao/contracts';
import { Download, FileText } from 'lucide-react';
export function Attachments({ files }: { files: FileAttachment[] }) {
  if (!files.length) return null;
  return (
    <ul className="message-files" aria-label="Attached files">
      {files.map((file) => (
        <li key={file.id}>
          {file.has_preview && (
            <a href={`/api/v1/files/${file.id}/content`}>
              <img
                loading="lazy"
                src={`/api/v1/files/${file.id}/preview`}
                alt={`Preview of ${file.name}`}
                width={320}
                height={240}
              />
            </a>
          )}
          <a href={`/api/v1/files/${file.id}/content`}>
            <FileText size={18} />
            <span>
              <strong>{file.name}</strong>
              <small>
                {file.size < 1024 * 1024
                  ? `${Math.ceil(file.size / 1024)} KB`
                  : `${(file.size / 1024 / 1024).toFixed(1)} MB`}
              </small>
            </span>
            <Download size={16} />
          </a>
          <FileDetails id={file.id} />
        </li>
      ))}
    </ul>
  );
}
