'use client';
import { useEffect, useState } from 'react';
import { dlpPolicy } from '@ao/contracts/file-governance';
import type { z } from 'zod';
import { api } from '../lib/api';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
export function FilePolicySettings() {
  const [policy, setPolicy] = useState<z.infer<typeof dlpPolicy>>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<z.infer<typeof dlpPolicy>>('/files/policy', { signal: controller.signal })
      .then(setPolicy)
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load file policies.');
      });
    return () => controller.abort();
  }, []);
  return (
    <Card asChild>
      <section className="settings-card commercial-panel" aria-label="File protection">
        <h2>File protection</h2>
        <p className="muted">
          Data inspection checks supported UTF-8 text files up to 2 MB. Strict inspection blocks
          other formats; malware scanning remains required.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p role="status">
            Policy saved. Existing files are blocked until inspection under this policy completes.
          </p>
        )}
        {policy && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setSaved(false);
              setError('');
              try {
                setPolicy(
                  await api('/files/policy', { method: 'PUT', body: JSON.stringify(policy) }),
                );
                setSaved(true);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Unable to save this policy.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              <input
                type="checkbox"
                checked={policy.enabled}
                onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })}
              />{' '}
              Enable data inspection
            </label>
            <label>
              <input
                type="checkbox"
                checked={policy.requireInspection}
                onChange={(e) => setPolicy({ ...policy, requireInspection: e.target.checked })}
              />{' '}
              Require successful inspection before downloads
            </label>
            <fieldset>
              <legend>Detectors</legend>
              {(['private_key', 'aws_key', 'credit_card', 'ssn'] as const).map((value) => (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={policy.detectors.includes(value)}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        detectors: e.target.checked
                          ? [...policy.detectors, value]
                          : policy.detectors.filter((d) => d !== value),
                      })
                    }
                  />
                  {value.replaceAll('_', ' ')}
                </label>
              ))}
            </fieldset>
            <label>
              <input
                type="checkbox"
                checked={policy.sharing}
                onChange={(e) => setPolicy({ ...policy, sharing: e.target.checked })}
              />{' '}
              Allow recipient-restricted expiring links
            </label>
            <label>
              Maximum link lifetime (hours)
              <Input
                type="number"
                min={1}
                max={168}
                required
                value={policy.maxShareHours}
                onChange={(e) => setPolicy({ ...policy, maxShareHours: Number(e.target.value) })}
              />
            </label>
            <Button disabled={busy}>Save file policy</Button>
          </form>
        )}
      </section>
    </Card>
  );
}
