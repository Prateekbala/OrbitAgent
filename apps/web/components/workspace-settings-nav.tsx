'use client';

import { useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
const sections = [
  ['overview', 'Overview'],
  ['profile', 'Profile & security'],
  ['appearance', 'Appearance'],
  ['organization', 'Organization'],
  ['connections', 'Connections'],
] as const;

export function WorkspaceSettingsNav() {
  const [active, setActive] = useState('overview');
  return (
    <ToggleGroup
      className="workspace-settings-nav"
      type="single"
      aria-label="Settings sections"
      value={active}
      onValueChange={(value) => {
        if (!value) return;
        setActive(value);
        document
          .getElementById(`workspace-settings-${value}`)
          ?.scrollIntoView({ block: 'start', behavior: 'auto' });
      }}
    >
      {sections.map(([id, label]) => (
        <ToggleGroupItem key={id} value={id}>
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
