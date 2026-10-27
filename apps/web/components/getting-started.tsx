'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { guideMessages } from '../lib/onboarding-messages';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { ArrowUpRight, Orbit, X } from 'lucide-react';
interface State {
  version: number;
  steps: string[];
  dismissed: boolean;
  locale: string;
}
const steps = ['profile', 'conversation', 'task', 'knowledge', 'notifications'] as const;
export function GettingStarted({
  compact = false,
  onNavigate,
}: {
  compact?: boolean;
  onNavigate?: (step: (typeof steps)[number]) => void;
}) {
  const [state, setState] = useState<State>(),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<State>('/account/onboarding', { signal: controller.signal })
      .then(setState)
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load the guide.');
      });
    return () => controller.abort();
  }, []);
  async function save(next: State) {
    if (busy) return;
    const before = state;
    setState(next);
    setBusy(true);
    setError('');
    try {
      setState(
        await api('/account/onboarding', {
          method: 'PUT',
          body: JSON.stringify({
            version: next.version,
            steps: next.steps,
            dismissed: next.dismissed,
          }),
        }),
      );
    } catch (e) {
      setState(before);
      setError(e instanceof Error ? e.message : 'Unable to save your progress.');
    } finally {
      setBusy(false);
    }
  }
  const copy = guideMessages(state?.locale ?? 'en');
  if (compact && (!state || state.dismissed || state.steps.length === steps.length)) return null;
  return (
    <Card asChild>
      <section
        className={compact ? 'workspace-welcome' : 'settings-card'}
        aria-label="Getting started"
      >
        {compact && <Orbit size={25} aria-hidden="true" />}
        <div>
          <h2>{copy.title}</h2>
          <p className="muted">{copy.description}</p>
          {compact && state && (
            <progress value={state.steps.length} max={steps.length} aria-label={copy.progress} />
          )}
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {state && (
          <>
            {!compact && (
              <p>
                {state.steps.length} / {steps.length} {copy.progress}
              </p>
            )}
            <Button variant="outline" onClick={() => setOpen(true)}>
              {compact ? 'Set up your workspace' : copy.title}
            </Button>
            {compact && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Dismiss welcome"
                disabled={busy}
                onClick={() => void save({ ...state, dismissed: true })}
              >
                <X size={16} />
              </Button>
            )}
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent>
                <DialogTitle>{copy.title}</DialogTitle>
                <DialogDescription>{copy.description}</DialogDescription>
                <ol className="onboarding-steps">
                  {steps.map((step, i) => (
                    <li key={step} className="guide-step">
                      <label>
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={state.steps.includes(step)}
                          onChange={(e) =>
                            void save({
                              ...state,
                              steps: e.target.checked
                                ? [...state.steps, step]
                                : state.steps.filter((s) => s !== step),
                            })
                          }
                        />
                        {copy.steps[i]}
                      </label>
                      {onNavigate && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Open ${copy.steps[i]}`}
                          onClick={() => {
                            setOpen(false);
                            onNavigate(step);
                          }}
                        >
                          <ArrowUpRight size={16} />
                        </Button>
                      )}
                    </li>
                  ))}
                </ol>
                <progress value={state.steps.length} max={5} aria-label={copy.progress} />
                <Button
                  disabled={busy}
                  onClick={() => {
                    void save({ ...state, dismissed: true });
                    setOpen(false);
                  }}
                >
                  {copy.close}
                </Button>
              </DialogContent>
            </Dialog>
          </>
        )}
      </section>
    </Card>
  );
}
