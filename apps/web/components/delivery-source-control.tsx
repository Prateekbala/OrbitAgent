'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { NativeSelect } from './ui/native-select';
export function DeliverySourceControl({
  scope,
  resourceId,
}: {
  scope: 'conversation' | 'thread' | 'agent';
  resourceId: string;
}) {
  const [mode, setMode] = useState('default'),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<{ scope: string; resource_id: string; mode: string }[]>(
      `/notification-delivery/scopes?scope=${scope}&resourceId=${resourceId}`,
      { signal: controller.signal },
    )
      .then((rows) =>
        setMode(
          rows.find((row) => row.scope === scope && row.resource_id === resourceId)?.mode ??
            'default',
        ),
      )
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load delivery preference.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [scope, resourceId]);
  return (
    <div className="delivery-source-control">
      <label>
        {scope === 'thread'
          ? 'Thread delivery'
          : scope === 'agent'
            ? 'Agent notifications'
            : 'External notification delivery'}
        <NativeSelect
          value={mode}
          disabled={loading || busy}
          onChange={(event) => {
            const next = event.target.value;
            setBusy(true);
            setError('');
            void api('/notification-delivery/scopes', {
              method: 'PUT',
              body: JSON.stringify({ scope, resourceId, mode: next }),
            })
              .then(() => setMode(next))
              .catch((e) =>
                setError(e instanceof Error ? e.message : 'Unable to save delivery preference.'),
              )
              .finally(() => setBusy(false));
          }}
        >
          <option value="default">Use my delivery settings</option>
          <option value="muted">Mute push and email</option>
          <option value="high">Treat as high priority</option>
        </NativeSelect>
      </label>
      {error && (
        <small className="error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
