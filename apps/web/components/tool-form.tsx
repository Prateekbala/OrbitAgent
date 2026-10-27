'use client';
import { Button } from './ui/button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { interactiveFormDocument } from '../lib/interactive-form-document';
import { api, post } from '../lib/api';
interface Form {
  id: string;
  title: string;
  description: string;
  fields: unknown;
}
export function InteractiveForm({ formId }: { formId: string }) {
  const { resolvedTheme } = useTheme();
  const initialTheme = useRef<'light' | 'dark'>(resolvedTheme === 'dark' ? 'dark' : 'light');
  const frame = useRef<HTMLIFrameElement>(null),
    [source, setSource] = useState(''),
    [values, setValues] = useState<Record<string, string | number | boolean> | null>(null),
    [error, setError] = useState(''),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false),
    nonce = useRef(''),
    request = useRef('');
  useEffect(() => {
    const controller = new AbortController();
    nonce.current = crypto.randomUUID();
    request.current = crypto.randomUUID();
    void api<Form>(`/execution/forms/${formId}`, { signal: controller.signal })
      .then((form) => {
        if (controller.signal.aborted) return;
        setSource(interactiveFormDocument(form, nonce.current, initialTheme.current));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== 'null' ||
        !event.data ||
        event.data.type !== 'orbit.form' ||
        event.data.nonce !== nonce.current
      )
        return;
      const data = event.data.values as unknown;
      if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        JSON.stringify(data).length > 50000
      )
        return;
      setValues(data as Record<string, string | number | boolean>);
    };
    window.addEventListener('message', receive);
    return () => {
      controller.abort();
      window.removeEventListener('message', receive);
    };
  }, [formId]);
  const synchronizeTheme = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      {
        type: 'orbit.appearance',
        nonce: nonce.current,
        theme: resolvedTheme === 'dark' ? 'dark' : 'light',
      },
      '*',
    );
  }, [resolvedTheme]);
  useEffect(() => {
    synchronizeTheme();
  }, [synchronizeTheme, source]);
  return (
    <section>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {source && !sent && (
        <iframe
          ref={frame}
          onLoad={synchronizeTheme}
          title="Isolated interactive form"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={source}
        />
      )}{' '}
      {values && !sent && (
        <>
          <pre>{JSON.stringify(values, null, 2)}</pre>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void post(`/execution/forms/${formId}/submissions`, {
                clientId: request.current,
                values,
              })
                .then(() => setSent(true))
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            Submit reviewed response
          </Button>
        </>
      )}
      {sent && <p role="status">Form response submitted.</p>}
    </section>
  );
}
