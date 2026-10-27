'use client';
import { Button } from './ui/button';
export function PageControls({
  next,
  busy,
  error,
  onMore,
}: {
  next: string | null;
  busy: boolean;
  error: string;
  onMore: () => Promise<unknown>;
}) {
  if (!next && !error) return null;
  return (
    <div className="page-controls">
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {next ? (
        <Button variant="outline" type="button" disabled={busy} onClick={() => void onMore()}>
          {busy ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
}
