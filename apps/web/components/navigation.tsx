'use client';
import { useState } from 'react';
import { Button } from './ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import {
  Orbit,
  Command,
  ChevronDown,
  MessageSquare,
  CheckSquare,
  Bot,
  BookOpen,
  Plus,
  Hash,
  Lock,
  ArrowUpRight,
  Settings,
  Activity,
  ShieldCheck,
  Users,
  Bell,
  X,
  Search,
} from 'lucide-react';
import type { SidebarPreferences } from '@ao/contracts/personal';
import type { Bootstrap, PresenceState } from '@ao/contracts';
import type { CreateKind } from './create-dialog';
import { PresenceDot } from './activity';
import { Avatar } from './primitives';
import { AppearanceControl } from './appearance';
import { WorkspacePicker } from './workspace-picker';

export type WorkspaceView =
  | 'chat'
  | 'tasks'
  | 'agents'
  | 'knowledge'
  | 'settings'
  | 'search'
  | 'runs'
  | 'approvals'
  | 'team'
  | 'notifications'
  | 'personal'
  | 'discover'
  | 'automations'
  | 'developer'
  | 'migrations'
  | 'shared';
const views = [
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'personal', label: 'Your messages', icon: BookOpen },
  { id: 'discover', label: 'Discover channels', icon: Hash },
  { id: 'chat', label: 'Conversations', icon: MessageSquare },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'runs', label: 'Agent runs', icon: Activity },
  { id: 'automations', label: 'Automations', icon: Activity },
  { id: 'developer', label: 'Developer', icon: Command },
  { id: 'migrations', label: 'Migrations', icon: ArrowUpRight },
  { id: 'shared', label: 'Shared channels', icon: Users },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { id: 'team', label: 'Team', icon: Users },
] as const;
const primaryViews = new Set<WorkspaceView>([
  'notifications',
  'personal',
  'discover',
  'chat',
  'tasks',
  'knowledge',
]);
type Channel = Bootstrap['channels'][number];

function ChannelLink({
  channel,
  selected,
  presence,
  onOpen,
}: {
  channel: Channel;
  selected: boolean;
  presence?: PresenceState;
  onOpen: (id: string) => void;
}) {
  return (
    <Button
      variant="ghost"
      className={selected ? 'selected' : ''}
      aria-current={selected ? 'page' : undefined}
      onClick={() => onOpen(channel.id)}
    >
      {channel.kind === 'direct' ? (
        <PresenceDot name={channel.name} state={presence ?? 'offline'} />
      ) : channel.kind === 'group' ? (
        <Users size={16} />
      ) : channel.visibility === 'private' ? (
        <Lock size={15} />
      ) : (
        <Hash size={17} />
      )}
      <span>{channel.name}</span>
      {channel.unread_count > 0 && (
        <Badge
          variant="outline"
          className="unread-badge"
          aria-label={`${channel.unread_count} unread messages`}
        >
          {channel.unread_count > 99 ? '99+' : channel.unread_count}
        </Badge>
      )}
    </Button>
  );
}

export function Navigation({
  boot,
  view,
  channel,
  onView,
  onCreate,
  onChannel,
  onConversation,
  notifications,
  presenceStates,
  presenceFallback = 'offline',
  presence,
  sidebar,
  queued,
  onClose,
}: {
  boot: Bootstrap;
  view: WorkspaceView;
  channel: string;
  onView: (view: WorkspaceView) => void;
  onCreate: (kind: CreateKind) => void;
  onChannel: (id: string) => void;
  onConversation: () => void;
  notifications: number;
  presenceStates: Record<string, PresenceState>;
  presenceFallback?: PresenceState;
  presence?: React.ReactNode;
  sidebar?: SidebarPreferences;
  queued?: number;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const assigned = new Set(sidebar?.sections.flatMap((section) => section.conversationIds) ?? []);
  const hidden = new Set(sidebar?.hiddenIds ?? []);
  const visible = boot.channels.filter(
    (item) =>
      !item.archived_at &&
      !hidden.has(item.id) &&
      item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const ungrouped = visible.filter((item) => !assigned.has(item.id));
  const openChannel = (id: string) => {
    onChannel(id);
    onView('chat');
  };
  function viewLink(item: (typeof views)[number]) {
    return (
      <Button
        variant="ghost"
        key={item.id}
        className={view === item.id ? 'selected' : ''}
        aria-current={view === item.id ? 'page' : undefined}
        onClick={() => onView(item.id)}
      >
        <item.icon size={18} />
        {item.label}
        {item.id === 'notifications' && notifications > 0 && (
          <Badge
            variant="outline"
            className="unread-badge"
            aria-label={`${notifications} unread notifications`}
          >
            {notifications > 99 ? '99+' : notifications}
          </Badge>
        )}
        {item.id === 'personal' && !!queued && (
          <Badge variant="outline" className="unread-badge">
            {queued}
          </Badge>
        )}
      </Button>
    );
  }
  function channelLink(item: Channel) {
    return (
      <ChannelLink
        key={item.id}
        channel={item}
        selected={view === 'chat' && channel === item.id}
        presence={
          item.peer_id ? (presenceStates[item.peer_id] ?? presenceFallback) : presenceFallback
        }
        onOpen={openChannel}
      />
    );
  }
  return (
    <>
      <aside className="rail" aria-label="Workspace shortcuts">
        <div className="orbit-mark" title="Orbit">
          <Orbit size={27} />
        </div>
        <Button
          variant="ghost"
          className="rail-active"
          aria-label="Workspace"
          onClick={() => onView('chat')}
        >
          <span>{boot.workspace.name.slice(0, 1).toUpperCase()}</span>
        </Button>
        <div className="rail-shortcuts">
          {(
            [
              { id: 'chat', label: 'Home', name: 'chat', icon: MessageSquare },
              { id: 'tasks', label: 'Tasks', name: 'tasks', icon: CheckSquare },
              { id: 'agents', label: 'Agents', name: 'agents', icon: Bot },
              { id: 'notifications', label: 'Activity', name: 'activity', icon: Bell },
            ] as const
          ).map((item) => (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  className={view === item.id ? 'rail-shortcut selected' : 'rail-shortcut'}
                  aria-label={`Open ${item.name}`}
                  aria-current={view === item.id ? 'page' : undefined}
                  onClick={() => onView(item.id)}
                >
                  <item.icon size={21} />
                  <small>{item.label}</small>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        <div className="rail-bottom">
          <AppearanceControl />
          <PresenceDot state={presenceStates[boot.me.id] ?? presenceFallback} name={boot.me.name} />
          <Avatar name={boot.me.name} />
        </div>
      </aside>
      <aside className="sidebar" id="workspace-navigation" aria-label="Workspace navigation">
        <Button
          variant="ghost"
          className="mobile-nav-close icon-button"
          aria-label="Close navigation"
          onClick={onClose}
        >
          <X size={20} />
        </Button>
        <div className="workspace-heading">
          <WorkspacePicker boot={boot} onSettings={() => onView('settings')} />
          <Button
            variant="ghost"
            className="workspace-compose icon-button"
            aria-label="New conversation"
            onClick={onConversation}
          >
            <MessageSquare size={18} />
          </Button>
        </div>
        <div className="sidebar-search">
          <Search size={14} aria-hidden="true" />
          <Input
            type="search"
            aria-label="Find a conversation"
            autoComplete="off"
            placeholder="Find a conversation…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear conversation filter"
              onClick={() => setQuery('')}
            >
              <X size={13} />
            </Button>
          )}
        </div>
        <nav className="sidebar-content" aria-label="Workspace views">
          <div className="main-nav">
            {views.filter((item) => primaryViews.has(item.id)).map(viewLink)}
          </div>
          <div className="nav-section">
            <span>Channels</span>
            <Button variant="ghost" aria-label="Create channel" onClick={() => onCreate('channel')}>
              <Plus size={15} />
            </Button>
          </div>
          <nav className="channel-nav" aria-label="Channels">
            {ungrouped.filter((item) => item.kind === 'channel').map(channelLink)}
          </nav>
          <div className="nav-section">
            <span>Direct messages</span>
            <Button variant="ghost" aria-label="Start a direct message" onClick={onConversation}>
              <Plus size={15} />
            </Button>
          </div>
          <nav className="channel-nav" aria-label="Direct and group messages">
            {ungrouped.filter((item) => item.kind !== 'channel').map(channelLink)}
          </nav>
          {sidebar?.sections.map((section) => (
            <div key={section.id}>
              <div className="nav-section">
                <span>{section.name}</span>
              </div>
              <nav className="channel-nav" aria-label={section.name}>
                {section.conversationIds
                  .map((id) => visible.find((item) => item.id === id))
                  .filter((item): item is Channel => !!item)
                  .map(channelLink)}
              </nav>
            </div>
          ))}
          {query.trim() && !visible.length && (
            <p className="sidebar-search-empty" role="status">
              No conversations match “{query.trim()}”.
            </p>
          )}
          <details className="sidebar-tools" open>
            <summary>
              <Command size={14} />
              Workspace tools
              <ChevronDown size={13} />
            </summary>
            <div className="main-nav">
              {views.filter((item) => !primaryViews.has(item.id)).map(viewLink)}
            </div>
          </details>
          {presence}
        </nav>
        <Button variant="ghost" className="sidebar-settings" onClick={() => onView('settings')}>
          <Settings size={16} /> Settings & activity
        </Button>
      </aside>
    </>
  );
}
