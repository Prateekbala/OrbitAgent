'use client';
import { NativeSelect } from './ui/native-select';
import { useEffect, useState } from 'react';
import type { ActivitySnapshot, PresenceMode, PresenceState } from '@ao/contracts/activity';
export function PresenceDot({ state = 'offline', name }: { state?: PresenceState; name: string }) {
  const label = state === 'unknown' ? `${name}’s presence is unavailable` : `${name} is ${state}`;
  return (
    <span
      className={`presence-dot presence-${state}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
export function PresenceControl({
  mode,
  onChange,
}: {
  mode: PresenceMode;
  onChange: (mode: PresenceMode) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pendingMode, setPendingMode] = useState<PresenceMode | null>(null);
  return (
    <div className="presence-control">
      <label>
        My presence
        <NativeSelect
          aria-label="My presence"
          value={pendingMode ?? mode}
          disabled={busy}
          onChange={async (event) => {
            const mode = event.target.value as PresenceMode;
            setPendingMode(mode);
            setBusy(true);
            setError('');
            try {
              await onChange(mode);
            } catch (error) {
              setError(error instanceof Error ? error.message : 'Unable to update presence.');
            } finally {
              setPendingMode(null);
              setBusy(false);
            }
          }}
        >
          <option value="automatic">Automatic</option>
          <option value="away">Away</option>
          <option value="invisible">Invisible</option>
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
export function TypingIndicator({
  snapshot,
  received,
  conversation,
  threadId = null,
  me,
}: {
  snapshot: ActivitySnapshot;
  received: number;
  conversation: string;
  threadId?: string | null;
  me: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [received]);
  const names = snapshot.typing
    .filter(
      (person) =>
        person.membership_id !== me &&
        person.conversation_id === conversation &&
        person.thread_id === threadId &&
        received + person.expires_in_ms > now,
    )
    .map((person) => person.name);
  const text =
    names.length === 0
      ? ''
      : names.length === 1
        ? `${names[0]} is typing…`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are typing…`
          : `${names[0]}, ${names[1]} and ${names.length - 2} others are typing…`;
  return (
    <div className="typing-indicator" role="status" aria-live="polite" aria-atomic="true">
      {text && (
        <>
          <span className="typing-dots" aria-hidden="true">
            •••
          </span>{' '}
          {text}
        </>
      )}
    </div>
  );
}
