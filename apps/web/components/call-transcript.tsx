'use client';
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { CallSnapshot, CallSegment } from '@ao/contracts/calls';
import { api } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
export function CallTranscript({ call, me }: { call: CallSnapshot; me: string }) {
  const [segments, setSegments] = useState<CallSegment[]>([]),
    [error, setError] = useState(''),
    [editing, setEditing] = useState<CallSegment | null>(null),
    [text, setText] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        setSegments(
          await api<CallSegment[]>(`/calls/${call.id}/transcript`, { signal: controller.signal }),
        );
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load transcript.');
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [call.id]);
  return (
    <section className="call-transcript">
      <h3>
        Transcript <span className="muted">Participant captions</span>
      </h3>
      {segments.length === 0 && <p className="muted">No captions have been retained.</p>}
      {segments.map((segment) => (
        <article key={segment.id}>
          <strong>{segment.speaker_name}</strong>
          <span className="muted">
            {' '}
            · {Math.floor(segment.start_ms / 60000)}:
            {String(Math.floor(segment.start_ms / 1000) % 60).padStart(2, '0')} · v{segment.version}
          </span>
          {editing?.id === segment.id ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void api(`/calls/${call.id}/transcript/${segment.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ version: segment.version, text }),
                })
                  .then(() => {
                    setSegments((rows) =>
                      rows.map((row) =>
                        row.id === segment.id ? { ...row, text, version: row.version + 1 } : row,
                      ),
                    );
                    setEditing(null);
                  })
                  .catch((e) => setError(e instanceof Error ? e.message : 'Correction failed.'));
              }}
            >
              <Input
                aria-label="Correct transcript"
                value={text}
                onChange={(event) => setText(event.target.value)}
                maxLength={4000}
              />
              <Button size="sm">Save correction</Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </form>
          ) : (
            <>
              <p>{segment.text}</p>
              {(me === segment.speaker_id || me === call.owner_id) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(segment);
                    setText(segment.text);
                  }}
                >
                  Correct
                </Button>
              )}
            </>
          )}
        </article>
      ))}
      {call.state === 'ended' && (
        <a href={`/api/v1/calls/${call.id}/recording`} className="call-download">
          <Download size={16} />
          Download recording
        </a>
      )}
      <a href={`/api/v1/calls/${call.id}/export`}>Export call notes and transcript</a>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
