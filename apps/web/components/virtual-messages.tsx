'use client';
import { useLayoutEffect, useRef, type RefObject, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Message } from '@ao/contracts';
export function VirtualMessages({
  items,
  container,
  anchor,
  render,
}: {
  items: Message[];
  container: RefObject<HTMLDivElement | null>;
  anchor?: string | undefined;
  render: (message: Message) => ReactNode;
}) {
  const enabled = items.length > 80,
    virtualizer = useVirtualizer({
      count: items.length,
      getScrollElement: () => container.current,
      getItemKey: (index) => items[index]!.id,
      estimateSize: () => 150,
      overscan: 10,
      enabled,
    });
  const positioned = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!enabled || !anchor) {
      positioned.current = null;
      return;
    }
    if (positioned.current === anchor) return;
    const index = items.findIndex((item) => item.id === anchor);
    if (index >= 0) {
      const frame = requestAnimationFrame(() => {
        virtualizer.scrollToIndex(index, { align: 'center' });
        positioned.current = anchor;
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [anchor, enabled, items, virtualizer]);
  if (!enabled) return items.map((item) => <div key={item.id}>{render(item)}</div>);
  return (
    <div
      className="virtual-messages"
      style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
      data-virtualized="true"
    >
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          ref={virtualizer.measureElement}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${row.start}px)`,
          }}
        >
          {render(items[row.index]!)}
        </div>
      ))}
    </div>
  );
}
