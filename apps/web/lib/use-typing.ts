'use client';
import { useEffect, useRef } from 'react';
export function useTyping(onTyping: ((active: boolean) => Promise<void>) | undefined) {
  const handler = useRef(onTyping),
    lastSent = useRef(0),
    active = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    handler.current = onTyping;
  }, [onTyping]);
  function stop() {
    clearTimeout(timer.current);
    if (active.current) {
      active.current = false;
      void handler.current?.(false);
    }
    lastSent.current = 0;
  }
  useEffect(() => {
    const blur = () => {
      clearTimeout(timer.current);
      if (active.current) {
        active.current = false;
        void handler.current?.(false);
      }
      lastSent.current = 0;
    };
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', blur);
    return () => {
      blur();
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', blur);
    };
  }, []);
  function changed(body: string) {
    if (!body.trim()) {
      stop();
      return;
    }
    active.current = true;
    if (Date.now() - lastSent.current >= 2000) {
      lastSent.current = Date.now();
      void handler.current?.(true);
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(stop, 2500);
  }
  return { changed, stop };
}
