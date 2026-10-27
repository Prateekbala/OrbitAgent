'use client';

import { useState } from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun, Monitor, Check } from 'lucide-react';
import { Dialog } from './dialog';
import { Button } from './ui/button';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

const choices = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

function AppearanceOptions() {
  const { theme, setTheme } = useTheme();
  return (
    <ToggleGroup
      type="single"
      value={theme ?? 'light'}
      className="appearance-options"
      spacing={2}
      aria-label="Color theme"
      onValueChange={(value) => {
        if (choices.some((choice) => choice.value === value)) setTheme(value);
      }}
    >
      {choices.map(({ value, label, icon: Icon }) => (
        <ToggleGroupItem key={value} value={value} className="appearance-option">
          <span className={`appearance-sample appearance-sample-${value}`} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="appearance-option-label">
            <Icon size={15} />
            {label}
            <Check className="appearance-check" size={14} aria-hidden="true" />
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function AppearanceControl({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`appearance-trigger ${className}`}
            aria-label="Appearance"
            onClick={() => setOpen(true)}
          >
            <Sun className="theme-light-icon" size={19} />
            <Moon className="theme-dark-icon" size={19} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Appearance</TooltipContent>
      </Tooltip>
      {open && (
        <Dialog title="Appearance" onClose={() => setOpen(false)}>
          <p className="appearance-description">
            Choose how Orbit looks on this device. System follows your device’s appearance.
          </p>
          <AppearanceOptions />
        </Dialog>
      )}
    </>
  );
}

export function AppearanceSettings() {
  return (
    <section className="settings-card appearance-settings" aria-label="Appearance settings">
      <div>
        <h2>Appearance</h2>
        <p>Keep things light, switch to dark, or follow your device.</p>
      </div>
      <AppearanceOptions />
    </section>
  );
}
