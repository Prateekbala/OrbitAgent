'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowUpRight,
  Bell,
  BookOpen,
  Bot,
  CheckSquare,
  Command,
  Hash,
  Lock,
  MessageSquare,
  Search,
  Settings,
  Users,
  Workflow,
  Activity,
  ShieldCheck,
  Code2,
  ArrowRightLeft,
  Globe2,
  Bookmark,
  Compass,
} from 'lucide-react';
import type { Bootstrap } from '@ao/contracts';
import type { WorkspaceView } from './navigation';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './ui/dialog';

const destinations = [
  { id: 'chat', name: 'Conversations', icon: MessageSquare },
  { id: 'tasks', name: 'Tasks & projects', icon: CheckSquare },
  { id: 'knowledge', name: 'Knowledge', icon: BookOpen },
  { id: 'agents', name: 'Agents', icon: Bot },
  { id: 'notifications', name: 'Notifications', icon: Bell },
  { id: 'automations', name: 'Automations', icon: Workflow },
  { id: 'team', name: 'Team', icon: Users },
  { id: 'settings', name: 'Workspace settings', icon: Settings },
  { id: 'personal', name: 'Saved messages & drafts', icon: Bookmark },
  { id: 'discover', name: 'Discover channels', icon: Compass },
  { id: 'runs', name: 'Agent runs', icon: Activity },
  { id: 'approvals', name: 'Approvals', icon: ShieldCheck },
  { id: 'developer', name: 'Developer platform', icon: Code2 },
  { id: 'migrations', name: 'Migrations & synchronization', icon: ArrowRightLeft },
  { id: 'shared', name: 'Shared channels', icon: Globe2 },
] as const;

export function WorkspaceCommand({
  boot,
  onView,
  onChannel,
}: {
  boot: Bootstrap;
  onView: (view: WorkspaceView) => void;
  onChannel: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k' &&
        !event.isComposing
      ) {
        if (document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        setQuery('');
        setOpen(true);
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const search = query.trim().toLocaleLowerCase();
  const views = destinations.filter((item) => item.name.toLocaleLowerCase().includes(search));
  const channels = boot.channels
    .filter((item) => !item.archived_at && item.name.toLocaleLowerCase().includes(search))
    .slice(0, 12);
  function navigate(action: () => void) {
    setOpen(false);
    action();
  }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const results = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[data-quick-result]') ?? [],
    );
    if (!results.length) return;
    const current = results.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index =
        current < 0
          ? event.key === 'ArrowDown'
            ? 0
            : results.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      results[index]?.focus();
    } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      results[0]?.click();
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) setQuery('');
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="workspace-command-trigger"
          aria-label="Open quick navigation"
        >
          <Command size={13} />
          <span>K</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="workspace-command-dialog">
        <DialogTitle>Go anywhere in your workspace</DialogTitle>
        <DialogDescription>
          Find a destination or jump straight into a conversation.
        </DialogDescription>
        <div onKeyDown={keys}>
          <div className="workspace-command-search">
            <Search size={19} aria-hidden="true" />
            <Input
              type="search"
              aria-label="Find a workspace destination"
              placeholder="Where would you like to go?"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div ref={list} className="workspace-command-results">
            {views.length > 0 && (
              <>
                <p className="workspace-command-label">Workspace</p>
                {views.map((item) => (
                  <Button
                    key={item.id}
                    variant="ghost"
                    data-quick-result="true"
                    onClick={() => navigate(() => onView(item.id))}
                  >
                    <item.icon size={18} />
                    <span>{item.name}</span>
                    <ArrowUpRight size={15} />
                  </Button>
                ))}
              </>
            )}
            {channels.length > 0 && (
              <>
                <p className="workspace-command-label">Conversations</p>
                {channels.map((item) => (
                  <Button
                    key={item.id}
                    variant="ghost"
                    data-quick-result="true"
                    onClick={() => navigate(() => onChannel(item.id))}
                  >
                    {item.visibility === 'private' ? (
                      <Lock size={17} />
                    ) : item.kind === 'channel' ? (
                      <Hash size={18} />
                    ) : (
                      <MessageSquare size={17} />
                    )}
                    <span>{item.name}</span>
                    <ArrowUpRight size={15} />
                  </Button>
                ))}
              </>
            )}
            {!views.length && !channels.length && (
              <p className="workspace-command-empty" role="status">
                No destinations match “{query.trim()}”.
              </p>
            )}
          </div>
        </div>
        <p className="workspace-command-hint">
          <kbd>↑ ↓</kbd> to move <kbd>Enter</kbd> to open <kbd>Esc</kbd> to close
        </p>
      </DialogContent>
    </Dialog>
  );
}
