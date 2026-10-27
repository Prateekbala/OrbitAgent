'use client';
import { useRef } from 'react';
import { Dialog as DialogRoot, DialogContent, DialogTitle } from './ui/dialog';
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const previousFocus = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="app-dialog"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (previousFocus.current?.isConnected) previousFocus.current.focus();
        }}
      >
        <header>
          <DialogTitle asChild>
            <h2>{title}</h2>
          </DialogTitle>
        </header>
        {children}
      </DialogContent>
    </DialogRoot>
  );
}
