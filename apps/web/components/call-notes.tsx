'use client';
import { useEffect, useState } from 'react';
import type { CallNotes, CallSegment } from '@ao/contracts/calls';
import { api } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { NativeSelect } from './ui/native-select';
const empty: CallNotes = { version: 0, summary: '', chapters: [], proposedActions: [] };
export function CallNotesEditor({ callId, canEdit }: { callId: string; canEdit: boolean }) {
  const [notes, setNotes] = useState<CallNotes>(empty),
    [segments, setSegments] = useState<CallSegment[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<{ version: number; notes: CallNotes | null }>(`/calls/${callId}/notes`, {
        signal: controller.signal,
      }),
      api<CallSegment[]>(`/calls/${callId}/transcript`, { signal: controller.signal }),
    ])
      .then(([result, captions]) => {
        setNotes({ ...(result.notes ?? empty), version: result.version });
        setSegments(captions.slice(0, 200));
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load call notes.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [callId]);
  return (
    <section className="call-notes">
      <h3>Meeting notes</h3>
      <p className="muted">
        Review summaries and proposed actions before sharing. Each proposed action cites a retained
        transcript segment.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          setSaved(false);
          void api<{ version: number }>(`/calls/${callId}/notes`, {
            method: 'PUT',
            body: JSON.stringify(notes),
          })
            .then((result) => {
              setNotes((value) => ({ ...value, version: result.version }));
              setSaved(true);
            })
            .catch((e) => setError(e instanceof Error ? e.message : 'Unable to save notes.'))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Summary
          <Textarea
            value={notes.summary}
            disabled={loading || busy || !canEdit}
            maxLength={20000}
            rows={4}
            onChange={(event) => setNotes({ ...notes, summary: event.target.value })}
          />
        </label>
        <h4>Chapters</h4>
        {notes.chapters.map((chapter, index) => (
          <div className="call-note-row" key={index}>
            <label>
              Start (minutes)
              <Input
                type="number"
                min={0}
                max={240}
                step={0.1}
                disabled={!canEdit || busy}
                value={chapter.startMs / 60000}
                onChange={(event) =>
                  setNotes({
                    ...notes,
                    chapters: notes.chapters.map((row, i) =>
                      i === index
                        ? { ...row, startMs: Math.round(Number(event.target.value) * 60000) }
                        : row,
                    ),
                  })
                }
              />
            </label>
            <label>
              Chapter title
              <Input
                maxLength={160}
                value={chapter.title}
                disabled={!canEdit || busy}
                onChange={(event) =>
                  setNotes({
                    ...notes,
                    chapters: notes.chapters.map((row, i) =>
                      i === index ? { ...row, title: event.target.value } : row,
                    ),
                  })
                }
              />
            </label>
            {canEdit && (
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove chapter ${index + 1}`}
                onClick={() =>
                  setNotes({ ...notes, chapters: notes.chapters.filter((_, i) => i !== index) })
                }
              >
                Remove
              </Button>
            )}
          </div>
        ))}
        {canEdit && (
          <Button
            type="button"
            variant="outline"
            disabled={busy || notes.chapters.length >= 100}
            onClick={() =>
              setNotes({ ...notes, chapters: [...notes.chapters, { startMs: 0, title: '' }] })
            }
          >
            Add chapter
          </Button>
        )}
        <h4>Proposed actions</h4>
        {notes.proposedActions.map((action, index) => (
          <div className="call-note-action" key={index}>
            <label>
              Action
              <Input
                value={action.title}
                maxLength={500}
                disabled={!canEdit || busy}
                onChange={(event) =>
                  setNotes({
                    ...notes,
                    proposedActions: notes.proposedActions.map((row, i) =>
                      i === index ? { ...row, title: event.target.value } : row,
                    ),
                  })
                }
              />
            </label>
            <label>
              Source
              <NativeSelect
                value={action.sourceSegmentIds[0] ?? ''}
                disabled={!canEdit || busy}
                onChange={(event) =>
                  setNotes({
                    ...notes,
                    proposedActions: notes.proposedActions.map((row, i) =>
                      i === index ? { ...row, sourceSegmentIds: [event.target.value] } : row,
                    ),
                  })
                }
              >
                <option value="" disabled>
                  Choose a transcript segment
                </option>
                {segments.map((segment) => (
                  <option key={segment.id} value={segment.id}>
                    {segment.speaker_name}: {segment.text.slice(0, 90)}
                  </option>
                ))}
              </NativeSelect>
            </label>
            {canEdit && (
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove action ${index + 1}`}
                onClick={() =>
                  setNotes({
                    ...notes,
                    proposedActions: notes.proposedActions.filter((_, i) => i !== index),
                  })
                }
              >
                Remove
              </Button>
            )}
          </div>
        ))}
        {canEdit && (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !segments.length || notes.proposedActions.length >= 100}
              onClick={() =>
                setNotes({
                  ...notes,
                  proposedActions: [
                    ...notes.proposedActions,
                    { title: '', assigneeId: null, sourceSegmentIds: [] },
                  ],
                })
              }
            >
              Propose action
            </Button>
            <Button disabled={loading || busy}>{busy ? 'Saving…' : 'Publish meeting notes'}</Button>
          </>
        )}
        {saved && <p role="status">Meeting notes published.</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
