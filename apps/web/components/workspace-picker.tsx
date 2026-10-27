'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronDown, LoaderCircle, Orbit, Settings } from 'lucide-react';
import type { Bootstrap, WorkspaceMembership } from '@ao/contracts';
import { api, post } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from './ui/dialog';

export function WorkspacePicker({ boot, onSettings }: { boot: Bootstrap; onSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const [spaces, setSpaces] = useState<WorkspaceMembership[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setQuery('');
    setSpaces([]);
    void api<WorkspaceMembership[]>('/workspaces', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setSpaces(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : 'Unable to load workspaces.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open]);
  async function switchWorkspace(space: WorkspaceMembership) {
    if (switching || space.workspace_id === boot.workspace.id) return;
    setSwitching(space.id);
    setError('');
    try {
      await post('/workspaces/switch', { membershipId: space.id });
      window.location.assign('/app');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to switch workspace.');
      setSwitching('');
    }
  }
  const filtered = spaces.filter((space) =>
    space.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!switching) setOpen(value);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="workspace-title"
          aria-label={`Switch workspace: ${boot.workspace.name}`}
        >
          <span title={boot.workspace.name}>{boot.workspace.name}</span>
          <ChevronDown size={16} />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Your workspaces</DialogTitle>
        <DialogDescription>
          Choose where you want to work. Each workspace keeps its own conversations and access.
        </DialogDescription>
        <Input
          type="search"
          aria-label="Find a workspace"
          placeholder="Find a workspace…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={Boolean(switching)}
        />
        <div
          className="workspace-picker-list"
          aria-label="Available workspaces"
          aria-busy={loading || Boolean(switching)}
        >
          {loading && <p role="status">Loading your workspaces…</p>}
          {filtered.map((space) => (
            <Button
              variant="outline"
              key={space.id}
              aria-label={`Open ${space.name}`}
              aria-current={space.workspace_id === boot.workspace.id ? 'true' : undefined}
              disabled={Boolean(switching) || space.workspace_id === boot.workspace.id}
              onClick={() => void switchWorkspace(space)}
            >
              <Orbit size={22} />
              <span>
                <strong>{space.name}</strong>
                <small>
                  {space.role}
                  {space.workspace_id === boot.workspace.id ? ' · Current workspace' : ''}
                </small>
              </span>
              {switching === space.id ? (
                <LoaderCircle size={17} />
              ) : space.workspace_id === boot.workspace.id ? (
                <Check size={17} />
              ) : null}
            </Button>
          ))}
          {!loading && !error && !filtered.length && (
            <p role="status">No workspaces match your search.</p>
          )}
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Button
          variant="ghost"
          disabled={Boolean(switching)}
          onClick={() => {
            setOpen(false);
            onSettings();
          }}
        >
          <Settings size={16} /> Workspace settings
        </Button>
      </DialogContent>
    </Dialog>
  );
}
