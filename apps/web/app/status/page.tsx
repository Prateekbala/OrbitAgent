'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
const response = z.object({
  incidents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      state: z.string(),
      message: z.string(),
      updatedAt: z.string(),
    }),
  ),
});
type Incident = z.infer<typeof response>['incidents'][number];
export default function StatusPage() {
  const [items, setItems] = useState<Incident[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      setItems(
        response.parse(await api('/status', { cache: 'no-store', ...(signal ? { signal } : {}) }))
          .incidents,
      );
    } catch {
      if (!signal?.aborted) setError('Status updates are temporarily unavailable.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  return (
    <main className="status-page">
      <Link href="/" className="status-brand">
        Orbit <span>Service updates</span>
      </Link>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>Service status</h1>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="muted">
            Published incident communications. Automated uptime monitoring and contractual service
            commitments require deployment qualification.
          </p>
          <Button variant="outline" disabled={loading} onClick={() => void refresh()}>
            Refresh status
          </Button>
          {loading && <p role="status">Loading updates…</p>}
          {error && <p role="alert">{error}</p>}
          {!loading && !error && items.length === 0 && <p role="status">No published incidents.</p>}
          <div className="status-incidents">
            {items.map((item) => (
              <article key={item.id}>
                <span className="status-state">{item.state}</span>
                <h2>{item.title}</h2>
                <p>{item.message}</p>
                <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString()}</time>
              </article>
            ))}
          </div>
        </CardContent>
      </Card>
      <Link href="/app">Back to workspace</Link>
    </main>
  );
}
