'use client';
import { useRef } from 'react';

export function useRequestIdentity() {
  const request = useRef<{ signature: string; id: string } | null>(null);
  return (input: unknown) => {
    const signature = JSON.stringify(input);
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    return request.current.id;
  };
}
