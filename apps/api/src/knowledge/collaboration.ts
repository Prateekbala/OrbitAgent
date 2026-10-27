import * as Y from 'yjs';
import type { Sql } from '@ao/database';
import type { KnowledgeRow } from './access.js';
import { AppError } from '../lib/errors.js';
export function decodeDocument(state: string) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Buffer.from(state, 'base64'));
    return doc;
  } catch {
    doc.destroy();
    throw new AppError(400, 'INVALID_DOCUMENT', 'The collaborative document update is invalid.');
  }
}
export function documentContent(doc: Y.Doc) {
  if ([...doc.share.keys()].some((k) => !['title', 'body'].includes(k)))
    throw new AppError(400, 'INVALID_DOCUMENT', 'Only page title and content may be synchronized.');
  const title = doc.getText('title').toString(),
    body = doc.getText('body').toString();
  if (
    title.trim().length < 2 ||
    title.length > 200 ||
    !body.trim() ||
    body.length > 50000 ||
    Y.encodeStateAsUpdate(doc).byteLength > 250000
  )
    throw new AppError(
      400,
      'DOCUMENT_LIMIT',
      'Use a title of 2–200 characters and content of 1–50,000 characters. Large editing histories must be compacted by publishing a reviewed page version.',
    );
  return { title, body };
}
export async function loadDocument(tx: Sql, page: KnowledgeRow) {
  let [row] = await tx.query<{ generation: string; state: string } & Record<string, unknown>>(
    'SELECT generation,state FROM knowledge_documents WHERE workspace_id=$1 AND page_id=$2',
    [page.workspace_id, page.id],
  );
  if (!row) {
    const doc = new Y.Doc();
    try {
      doc.getText('title').insert(0, page.title);
      doc.getText('body').insert(0, page.body);
      const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
      [row] = await tx.query<{ generation: string; state: string } & Record<string, unknown>>(
        'INSERT INTO knowledge_documents(workspace_id,page_id,state) VALUES($1,$2,$3) ON CONFLICT(workspace_id,page_id) DO UPDATE SET state=knowledge_documents.state RETURNING generation,state',
        [page.workspace_id, page.id, state],
      );
    } finally {
      doc.destroy();
    }
  }
  return row!;
}
