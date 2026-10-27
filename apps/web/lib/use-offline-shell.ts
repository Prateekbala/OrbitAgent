'use client';
import { useEffect } from 'react';
export function useOfflineShell() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator)
      void navigator.serviceWorker.register('/orbit-sw.js').catch(() => {});
  }, []);
}
