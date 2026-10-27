'use client';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import * as Y from 'yjs';
import { useEffect, useRef, useState } from 'react';
import type { KnowledgeSyncState } from '@ao/contracts/knowledge';
import { api, HttpError } from '../lib/api';
import { RichMessage } from './rich-message';

function replaceText(text: Y.Text, value: string) {
  const current = text.toString();
  let start = 0,
    end = 0;
  while (start < current.length && start < value.length && current[start] === value[start]) start++;
  while (
    end < current.length - start &&
    end < value.length - start &&
    current[current.length - 1 - end] === value[value.length - 1 - end]
  )
    end++;
  text.doc!.transact(() => {
    text.delete(start, current.length - start - end);
    text.insert(start, value.slice(start, value.length - end));
  }, 'local');
}
const encode = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (v) => String.fromCharCode(v)).join(''));
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export function KnowledgeCollaboration({
  pageId,
  onClose,
}: {
  pageId: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [status, setStatus] = useState('Connecting…'),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false),
    [synced, setSynced] = useState(false);
  const document = useRef<Y.Doc | null>(null),
    area = useRef<HTMLTextAreaElement>(null),
    dirty = useRef(false);
  useEffect(() => {
    const controller = new AbortController(),
      doc = new Y.Doc();
    document.current = doc;
    let live = true,
      busy = false,
      generation = '';
    const changed = () => {
      if (live) {
        setTitle(doc.getText('title').toString());
        setBody(doc.getText('body').toString());
      }
    };
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      changed();
      if (origin === 'local') {
        dirty.current = true;
        setSynced(false);
        setStatus('Saving shared changes…');
      }
    });
    function merge(state: KnowledgeSyncState) {
      const text = doc.getText('body'),
        input = area.current;
      const start =
        input && documentContainsFocus(input)
          ? Y.createRelativePositionFromTypeIndex(text, input.selectionStart)
          : null;
      const end =
        input && start ? Y.createRelativePositionFromTypeIndex(text, input.selectionEnd) : null;
      Y.applyUpdate(doc, decode(state.update), 'remote');
      if (input && start && end) {
        const from = Y.createAbsolutePositionFromRelativePosition(start, doc),
          to = Y.createAbsolutePositionFromRelativePosition(end, doc);
        if (from && to)
          requestAnimationFrame(() => {
            if (live) input.setSelectionRange(from.index, to.index);
          });
      }
    }
    async function synchronize() {
      if (!live || busy || !generation) return;
      busy = true;
      try {
        const wasDirty = dirty.current;
        dirty.current = false;
        const response = wasDirty
          ? await api<KnowledgeSyncState>(`/knowledge/${pageId}/document`, {
              method: 'POST',
              body: JSON.stringify({ generation, update: encode(Y.encodeStateAsUpdate(doc)) }),
              signal: controller.signal,
            })
          : await api<KnowledgeSyncState>(`/knowledge/${pageId}/document`, {
              signal: controller.signal,
            });
        if (!live) return;
        if (response.generation !== generation)
          throw new HttpError(
            409,
            'This page was replaced. Close and review its current version.',
            'DOCUMENT_RESET',
          );
        merge(response);
        setError('');
        setSynced(!dirty.current);
        setStatus(
          dirty.current
            ? 'Saving shared changes…'
            : `Shared version ${response.version} · synchronized`,
        );
      } catch (e) {
        if (!live) return;
        dirty.current = true;
        setSynced(false);
        setError(e instanceof Error ? e.message : 'Unable to synchronize.');
        if (e instanceof HttpError && [401, 403, 404].includes(e.status)) {
          doc.destroy();
          document.current = null;
          setReady(false);
          setTitle('');
          setBody('');
          setStatus('Access unavailable');
        }
        if (e instanceof HttpError && e.status === 409) {
          generation = '';
          setReady(false);
          setStatus('Review the current page before editing again.');
        }
      } finally {
        busy = false;
      }
    }
    void api<KnowledgeSyncState>(`/knowledge/${pageId}/document`, { signal: controller.signal })
      .then((state) => {
        if (!live) return;
        generation = state.generation;
        merge(state);
        dirty.current = false;
        setReady(true);
        setSynced(true);
        setStatus(`Shared version ${state.version} · synchronized`);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    const timer = setInterval(() => void synchronize(), 1200);
    return () => {
      live = false;
      clearInterval(timer);
      controller.abort();
      document.current = null;
      doc.destroy();
      dirty.current = false;
    };
  }, [pageId]);
  function format(before: string, after = before) {
    const input = area.current,
      doc = document.current;
    if (!input || !doc) return;
    const start = input.selectionStart,
      end = input.selectionEnd,
      value = doc.getText('body').toString();
    replaceText(
      doc.getText('body'),
      value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end),
    );
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + before.length, end + before.length);
    });
  }
  return (
    <section className="knowledge-editor" aria-label="Shared page editor">
      <p role="status">{status}</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <label>
        Shared page title
        <Input
          aria-label="Shared page title"
          value={title}
          maxLength={200}
          disabled={!ready}
          onChange={(e) => {
            const doc = document.current;
            if (doc) replaceText(doc.getText('title'), e.target.value);
          }}
        />
      </label>
      <div className="document-actions" aria-label="Formatting">
        <Button variant="outline" type="button" disabled={!ready} onClick={() => format('**')}>
          Bold
        </Button>
        <Button variant="outline" type="button" disabled={!ready} onClick={() => format('_')}>
          Italic
        </Button>
        <Button variant="outline" type="button" disabled={!ready} onClick={() => format('## ', '')}>
          Heading
        </Button>
        <Button variant="outline" type="button" disabled={!ready} onClick={() => format('- ', '')}>
          List
        </Button>
        <Button variant="outline" type="button" disabled={!ready} onClick={() => format('`')}>
          Code
        </Button>
        <Button
          variant="outline"
          type="button"
          disabled={!ready}
          onClick={() => format('[', '](https://example.com)')}
        >
          Link
        </Button>
      </div>
      <label>
        Shared page content
        <Textarea
          ref={area}
          aria-label="Shared page content"
          value={body}
          maxLength={50000}
          rows={16}
          disabled={!ready}
          onChange={(e) => {
            const doc = document.current;
            if (doc) replaceText(doc.getText('body'), e.target.value);
          }}
        />
      </label>
      <details>
        <summary>Rich text preview</summary>
        <RichMessage body={body} format="markdown" />
      </details>
      <p className="muted">
        Edits merge with other participants. Every synchronized change creates an attributed page
        version.
      </p>
      <Button variant="outline" type="button" onClick={onClose} disabled={ready && !synced}>
        Close shared editor
      </Button>
    </section>
  );
}
function documentContainsFocus(element: HTMLElement) {
  return element.ownerDocument.activeElement === element;
}
