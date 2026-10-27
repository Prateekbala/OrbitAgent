'use client';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '@ao/contracts';

export function useTimelineScroll(scope: string, messages: Message[], enabled: boolean) {
  const container = useRef<HTMLDivElement>(null),
    position = useRef({ scope, initialized: false, pinned: true, last: '', first: '', height: 0 });
  const [unseen, setUnseen] = useState(false);
  const jump = useCallback(() => {
    const node = container.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    position.current.pinned = true;
    setUnseen(false);
  }, []);
  useLayoutEffect(() => {
    if (position.current.scope !== scope || !enabled) {
      position.current = {
        scope,
        initialized: false,
        pinned: true,
        last: '',
        first: '',
        height: 0,
      };
      setUnseen(false);
    }
    const latest = messages.at(-1)?.id,
      node = container.current;
    if (!enabled || !latest || !node) return;
    const first = messages[0]?.id ?? '';
    if (
      position.current.initialized &&
      position.current.first !== first &&
      position.current.last === latest
    ) {
      node.scrollTop += node.scrollHeight - position.current.height;
    } else if (!position.current.initialized || position.current.pinned) jump();
    else if (position.current.last !== latest) setUnseen(true);
    position.current.initialized = true;
    position.current.last = latest;
    position.current.first = first;
    position.current.height = node.scrollHeight;
  }, [scope, messages, enabled, jump]);
  const onScroll = useCallback(() => {
    const node = container.current;
    if (!node) return;
    position.current.pinned = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    if (position.current.pinned) setUnseen(false);
  }, []);
  return { container, onScroll, unseen, jump };
}
