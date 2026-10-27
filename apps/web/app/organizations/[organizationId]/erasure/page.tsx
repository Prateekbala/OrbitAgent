'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import {
  ErasureProgress,
  type OrganizationErasure,
} from '../../../../components/enterprise-controls';
import { Button } from '../../../../components/ui/button';
export default function OrganizationErasurePage() {
  const { organizationId } = useParams<{ organizationId: string }>(),
    [job, setJob] = useState<OrganizationErasure | null>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError('');
      try {
        if (!/^[a-f0-9-]{36}$/.test(organizationId)) throw new Error();
        setJob(
          await api<OrganizationErasure | null>(
            '/organizations/' + organizationId + '/erasure',
            signal ? { signal } : {},
          ),
        );
      } catch {
        if (!signal?.aborted)
          setError(
            'Deletion progress is unavailable. Sign in with the requesting organization owner account.',
          );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [organizationId],
  );
  useEffect(() => {
    const c = new AbortController();
    void refresh(c.signal);
    return () => c.abort();
  }, [refresh]);
  return (
    <main className="status-page">
      <h1>Organization deletion</h1>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading deletion progress…</p>}
      {job && <ErasureProgress job={job} />}{' '}
      {!loading && job === null && !error && <p>No deletion request has been recorded.</p>}
      <Button disabled={loading} variant="outline" onClick={() => void refresh()}>
        Refresh deletion progress
      </Button>
      <Link href="/app">Return to your workspaces</Link>
    </main>
  );
}
