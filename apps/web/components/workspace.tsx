'use client';
import { Button } from './ui/button';
import { Calls } from './calls';
import { DeliverySourceControl } from './delivery-source-control';
import { AppearanceControl, AppearanceSettings } from './appearance';
import { messageDay, messageDayLabel } from '../lib/message-dates';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { Card } from './ui/card';
import { Separator } from './ui/separator';
import { MigrationHub } from './migration-hub';
import { SharedChannelHub } from './shared-channel-hub';
import { ConnectionSettings } from './connection-settings';
import { useOfflineShell } from '../lib/use-offline-shell';
import { PersonalMessages } from './personal-messages';
import { ChannelBrowser } from './channel-browser';
import { SidebarSettings } from './sidebar-settings';
import { useOfflineOutbox } from '../lib/use-offline-outbox';
import {
  clearPrivateStorage,
  clearPrivateConversation,
  cacheBootstrap,
  cachedBootstrap,
} from '../lib/private-storage';
import type { SidebarPreferences } from '@ao/contracts/personal';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
import { VirtualMessages } from './virtual-messages';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Hash,
  Plus,
  Search,
  CheckSquare,
  ShieldCheck,
  Settings2,
  Bookmark,
  Workflow,
  Code2,
  ArrowRightLeft,
  Globe2,
  Bot,
  BookOpen,
  PanelRight,
  LogOut,
  X,
  Copy,
  Activity,
  Users,
  MessageSquare,
  Bell,
  Menu,
  Pin,
  Lock,
} from 'lucide-react';
import type {
  Bootstrap,
  Message,
  Agent,
  Page,
  AuditEvent,
  RealtimeBatch,
  InboxNotification,
} from '@ao/contracts';
import { api, post, HttpError } from '../lib/api';
import { useRealtime } from '../lib/use-realtime';
import { useReadPosition } from '../lib/use-read-position';
import { useTimelineScroll } from '../lib/use-timeline-scroll';
import { Auth } from './auth';
import { Dialog } from './dialog';
import { CreateDialog } from './create-dialog';
import { Navigation, type WorkspaceView } from './navigation';
import { AutomationView } from './automation-view';
import { DeveloperView } from './developer-view';
import { ExecutionView } from './execution-view';
import { VerificationGate } from './verification-gate';
import { TeamView } from './team-view';
import { Avatar } from './primitives';
import { MessageRow } from './conversation';
import { Composer } from './composer';
import { NewConversationDialog, ConversationDetailsDialog } from './conversation-dialogs';
import { useNotifications } from '../lib/use-notifications';
import { useActivity } from '../lib/use-activity';
import { NotificationCenter, ConversationNotifications } from './notifications';
import { PresenceControl, PresenceDot, TypingIndicator } from './activity';
import { AgentView } from './domain-views';
import { TaskView } from './task-view';
import { GettingStarted } from './getting-started';
import { WorkspaceTransition } from './workspace-transition';
import { WorkspaceMotion, WorkspaceViewport } from './workspace-motion';
import { WorkspaceCommand } from './workspace-command';
import { WorkspaceSettingsNav } from './workspace-settings-nav';
import { WorkspaceHeading } from './workspace-heading';
import { FilePolicySettings } from './file-policy-settings';
import { SharedFileLink } from './file-details';
import { AccountSettings } from './account-settings';
import { OrganizationSettings } from './organization-settings';
import { ServiceAccountSettings } from './service-account-settings';
import { KnowledgeView } from './knowledge-view';
import { SearchView } from './search-view';
import { useMessageHistory } from '../lib/use-message-history';
type View = WorkspaceView;
export function Workspace() {
  useOfflineShell();
  const [boot, setBoot] = useState<Bootstrap | null>(null),
    [newConversation, setNewConversation] = useState(false),
    [showDetails, setShowDetails] = useState(false),
    [loading, setLoading] = useState(true),
    [signedOut, setSignedOut] = useState(false),
    [verificationRequired, setVerificationRequired] = useState(false),
    [identityRequired, setIdentityRequired] = useState(''),
    [view, setView] = useState<View>('chat'),
    [channel, setChannel] = useState(''),
    [anchor, setAnchor] = useState<{
      id: string;
      conversation_id: string;
      thread_id: string | null;
      root: Message | null;
    } | null>(null),
    [jump, setJump] = useState<{
      id: string;
      conversation_id: string;
      thread_id: string | null;
      root: Message | null;
    } | null>(null),
    [thread, setThread] = useState<Message | null>(null),
    [taskRevision, setTaskRevision] = useState(0),
    [selectedTask, setSelectedTask] = useState<string | null>(null),
    [selectedAutomation, setSelectedAutomation] = useState<string | null>(null),
    [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null),
    [selectedAgentRun, setSelectedAgentRun] = useState<string | null>(null),
    [agents, setAgents] = useState<Agent[]>([]),
    [pages, setPages] = useState<Page[]>([]),
    [audit, setAudit] = useState<AuditEvent[]>([]),
    [dialog, setDialog] = useState<'channel' | 'task' | 'agent' | 'page' | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(''),
    [query, setQuery] = useState(''),
    [searchQuery, setSearchQuery] = useState(''),
    [searchRevision, setSearchRevision] = useState(0),
    [selectedPage, setSelectedPage] = useState<Page | null>(null),
    [inspector, setInspector] = useState(false),
    [mobileNavigation, setMobileNavigation] = useState(false);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const closeNavigation = useCallback(() => {
    setMobileNavigation(false);
    navigationToggle.current?.focus();
  }, []);
  const [personalRevision, setPersonalRevision] = useState(0),
    [personalTab, setPersonalTab] = useState<'saved-messages' | 'pins'>('saved-messages'),
    [sidebar, setSidebar] = useState<SidebarPreferences>({
      sections: [],
      hiddenIds: [],
      version: 0,
    });
  const clearSelectedAgentRun = useCallback(() => setSelectedAgentRun(null), []);
  const identity =
    boot && !signedOut && !verificationRequired ? `${boot.workspace.id}:${boot.me.id}` : null;
  const agentCollection = useCursorPage<Agent>(
    identity && view === 'agents' ? identity : null,
    '/collections/agents',
  );
  const knowledgeCollection = useCursorPage<Page>(
    identity && view === 'knowledge' ? identity : null,
    '/collections/knowledge',
  );
  const auditCollection = useCursorPage<AuditEvent>(
    identity && view === 'settings' ? identity : null,
    '/collections/audit',
  );
  useEffect(() => setAgents(agentCollection.items), [agentCollection.items]);
  useEffect(() => setPages(knowledgeCollection.items), [knowledgeCollection.items]);
  useEffect(() => setAudit(auditCollection.items), [auditCollection.items]);
  useEffect(() => {
    if (!identity) return;
    const controller = new AbortController();
    void api<SidebarPreferences>('/sidebar', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setSidebar(value);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [identity, personalRevision]);
  const mainHistory = useMessageHistory(
    identity,
    channel,
    null,
    anchor?.thread_id ?? anchor?.id ?? null,
    view === 'chat',
  );
  const replyHistory = useMessageHistory(
    identity,
    channel,
    thread?.id ?? null,
    anchor?.thread_id === thread?.id ? (anchor?.id ?? null) : null,
    view === 'chat' && Boolean(thread),
  );
  const messages = mainHistory.items,
    replies = replyHistory.items;
  const notifications = useNotifications(identity);
  const activity = useActivity(identity);
  const requestVersion = useRef(0);
  const authorityVersion = useRef(0);
  const bootstrapRequest = useRef({ version: 0, controller: null as AbortController | null });
  const bootstrapSnapshot = useRef<Bootstrap | null>(null);
  const activeChannel = useRef(channel);
  const invalidateBootstrap = useCallback(() => {
    bootstrapRequest.current.version++;
    bootstrapRequest.current.controller?.abort();
  }, []);
  useLayoutEffect(() => {
    bootstrapSnapshot.current = boot;
    activeChannel.current = channel;
  }, [boot, channel]);
  useEffect(() => () => invalidateBootstrap(), [invalidateBootstrap]);
  useLayoutEffect(() => {
    authorityVersion.current++;
    invalidateBootstrap();
    setPages([]);
    setSelectedPage(null);
    setSelectedTask(null);
  }, [identity, invalidateBootstrap]);
  const hasWorkspace = boot !== null;
  const contentKey = `${boot?.workspace.id ?? ''}:${boot?.me.id ?? ''}:${view}:${channel}:${thread?.id ?? ''}:${searchQuery}:${anchor?.id ?? ''}`;
  const currentContent = useRef(contentKey);
  useLayoutEffect(() => {
    currentContent.current = contentKey;
    requestVersion.current++;
  }, [contentKey]);
  useLayoutEffect(() => {
    setThread(null);
    setShowDetails(false);
    setAnchor(null);
    mainHistory.clear();
    replyHistory.clear();
  }, [channel]);
  useEffect(() => {
    if (jump?.conversation_id === channel) {
      setAnchor(jump);
      setThread(jump.root);
      setJump(null);
    }
  }, [jump, channel]);
  const scrolledAnchor = useRef('');
  useEffect(() => {
    if (!anchor) scrolledAnchor.current = '';
    if (anchor && scrolledAnchor.current !== anchor.id) {
      const node = document.querySelector(`[data-message-id="${anchor.id}"]`);
      if (node) {
        node.scrollIntoView({ block: 'center' });
        scrolledAnchor.current = anchor.id;
      }
    }
  }, [anchor, messages, replies]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && mobileNavigation) closeNavigation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavigation, closeNavigation]);
  const revokeConversations = useCallback(
    (ids: string[]) => {
      const snapshotForCache = bootstrapSnapshot.current;
      if (snapshotForCache)
        for (const id of ids)
          void clearPrivateConversation(
            `${snapshotForCache.workspace.id}:${snapshotForCache.me.id}`,
            id,
          ).catch(() => {});
      const revoked = new Set(ids);
      authorityVersion.current++;
      requestVersion.current++;
      invalidateBootstrap();
      notifications.invalidate();
      setSelectedTask(null);
      setSelectedWorkflow(null);
      setSelectedAutomation(null);
      setSelectedAgentRun(null);
      setTaskRevision((value) => value + 1);
      setAudit([]);
      setPages((current) =>
        current.filter((page) => !page.conversation_id || !revoked.has(page.conversation_id)),
      );
      setSelectedPage((current) =>
        current?.conversation_id && revoked.has(current.conversation_id) ? null : current,
      );
      setJump((current) => (current && revoked.has(current.conversation_id) ? null : current));
      const snapshot = bootstrapSnapshot.current;
      const channels =
        snapshot?.channels.filter((conversation) => !revoked.has(conversation.id)) ?? [];
      if (snapshot) bootstrapSnapshot.current = { ...snapshot, channels };
      setBoot((current) =>
        current
          ? {
              ...current,
              channels: current.channels.filter((conversation) => !revoked.has(conversation.id)),
            }
          : current,
      );
      setChannel((current) => (revoked.has(current) ? (channels[0]?.id ?? '') : current));
      if (revoked.has(activeChannel.current)) {
        mainHistory.clear();
        replyHistory.clear();
        setThread(null);
        setShowDetails(false);
        setAnchor(null);
      }
    },
    [invalidateBootstrap, notifications.invalidate, mainHistory.clear, replyHistory.clear],
  );
  const refreshBootstrap = useCallback(async (): Promise<boolean> => {
    invalidateBootstrap();
    const version = bootstrapRequest.current.version;
    const controller = new AbortController();
    bootstrapRequest.current.controller = controller;
    const valid = () => bootstrapRequest.current.version === version && !controller.signal.aborted;
    try {
      const data = await api<Bootstrap>('/bootstrap', { signal: controller.signal });
      if (!valid()) return false;
      const previous = bootstrapSnapshot.current;
      if (
        previous?.workspace.id === data.workspace.id &&
        previous.workspace.retrieval_epoch !== data.workspace.retrieval_epoch
      ) {
        setSearchRevision((value) => value + 1);
      }
      const activeHistory = data.channels.find((c) => c.id === activeChannel.current),
        oldHistory = previous?.channels.find((c) => c.id === activeChannel.current);
      if (
        activeHistory?.history_policy === 'join_time' &&
        !activeHistory.joined &&
        (oldHistory?.joined || oldHistory?.history_policy !== 'join_time')
      ) {
        authorityVersion.current++;
        mainHistory.clear();
        replyHistory.clear();
        setThread(null);
        setAnchor(null);
      }

      if (previous?.workspace.id === data.workspace.id && previous.me.id === data.me.id) {
        const accessible = new Set(data.channels.map((conversation) => conversation.id));
        const removed = previous.channels
          .filter((conversation) => !accessible.has(conversation.id))
          .map((conversation) => conversation.id);
        if (removed.length) revokeConversations(removed);
      }
      bootstrapSnapshot.current = data;
      void cacheBootstrap(data).catch(() => {});
      setBoot((current) =>
        current && JSON.stringify(current) === JSON.stringify(data) ? current : data,
      );
      setVerificationRequired(false);
      setIdentityRequired('');
      setSignedOut(false);
      setChannel((current) =>
        data.channels.some((c) => c.id === current) ? current : data.channels[0]?.id || '',
      );
      setLoading(false);
      return true;
    } catch (e) {
      if (!valid()) return false;
      if (!navigator.onLine) {
        const cached = await cachedBootstrap().catch(() => null);
        if (cached && valid()) {
          bootstrapSnapshot.current = cached;
          setBoot(cached);
          setSignedOut(false);
          setChannel((current) =>
            cached.channels.some((c) => c.id === current)
              ? current
              : (cached.channels[0]?.id ?? ''),
          );
          setLoading(false);
          return true;
        }
      }
      if (e instanceof HttpError && e.status === 401) {
        setSignedOut(true);
        setIdentityRequired('');
        setBoot(null);
        bootstrapSnapshot.current = null;
        mainHistory.clear();
        replyHistory.clear();
        setThread(null);
        setVerificationRequired(false);
      } else if (e instanceof HttpError && e.code === 'EMAIL_NOT_VERIFIED') {
        setSignedOut(false);
        setIdentityRequired('');
        setVerificationRequired(true);
        setBoot(null);
        bootstrapSnapshot.current = null;
        mainHistory.clear();
        replyHistory.clear();
        setThread(null);
      } else if (
        e instanceof HttpError &&
        [
          'MFA_ENROLLMENT_REQUIRED',
          'SSO_REQUIRED',
          'DOMAIN_RESTRICTED',
          'WORKSPACE_REQUIRED',
        ].includes(e.code ?? '')
      ) {
        setSignedOut(false);
        setVerificationRequired(false);
        setIdentityRequired(e.message);
        setBoot(null);
        bootstrapSnapshot.current = null;
        mainHistory.clear();
        replyHistory.clear();
        setThread(null);
      } else setError(e instanceof Error ? e.message : 'Unable to load workspace.');
      return false;
    } finally {
      if (valid()) setLoading(false);
    }
  }, [invalidateBootstrap, revokeConversations, mainHistory.clear, replyHistory.clear]);
  const loadBoot = useCallback(async () => {
    await refreshBootstrap();
  }, [refreshBootstrap]);
  const enterWorkspace = useCallback(async () => {
    setLoading(true);
    setSignedOut(false);
    setError('');
    await refreshBootstrap();
  }, [refreshBootstrap]);
  const refresh = useCallback(async () => {
    if (!hasWorkspace || currentContent.current !== contentKey) return true;
    const version = ++requestVersion.current;
    const apply = (update: () => void) => {
      if (version === requestVersion.current && currentContent.current === contentKey) update();
    };
    try {
      if (view === 'chat' && channel) {
        const loaded = await Promise.all([mainHistory.refresh(), replyHistory.refresh()]);
        if (loaded.some((ok) => !ok)) return false;
      }
      if (view === 'tasks') {
        apply(() => setTaskRevision((value) => value + 1));
      }
      if (view === 'agents') {
        await agentCollection.refresh();
      }
      if (view === 'knowledge') {
        await knowledgeCollection.refresh();
      }
      if (view === 'search') apply(() => setSearchRevision((value) => value + 1));
      if (view === 'settings') {
        await auditCollection.refresh();
      }
    } catch (error) {
      apply(() => setError(error instanceof Error ? error.message : 'Unable to load content.'));
      return false;
    }
    return true;
  }, [
    hasWorkspace,
    view,
    channel,
    thread,
    searchQuery,
    contentKey,
    anchor,
    mainHistory.refresh,
    replyHistory.refresh,
    agentCollection.refresh,
    knowledgeCollection.refresh,
    auditCollection.refresh,
  ]);
  const deepLink = useRef('');
  useEffect(() => {
    if (!identity) {
      deepLink.current = '';
      return;
    }
    const url = new URL(window.location.href),
      message = url.searchParams.get('message'),
      workspace = url.searchParams.get('workspace');
    if (
      !message ||
      !/^[0-9a-f-]{36}$/i.test(message) ||
      (workspace && !/^[0-9a-f-]{36}$/i.test(workspace)) ||
      deepLink.current === identity + ':' + message
    )
      return;
    deepLink.current = identity + ':' + message;
    const controller = new AbortController(),
      snapshot = bootstrapSnapshot.current,
      authority = authorityVersion.current;
    if (!snapshot) return;
    void (async () => {
      try {
        if (workspace && workspace !== snapshot.workspace.id) {
          const spaces = await api<{ id: string; workspace_id: string }[]>('/workspaces', {
              signal: controller.signal,
            }),
            target = spaces.find((s) => s.workspace_id === workspace);
          if (!target) throw new Error('This message belongs to a workspace you cannot access.');
          await post('/workspaces/switch', { membershipId: target.id });
          window.location.reload();
          return;
        }
        const target = await api<{
          id: string;
          conversation_id: string;
          thread_id: string | null;
          root: Message | null;
        }>(`/messages/${message}/context`, { signal: controller.signal });
        if (!controller.signal.aborted && authority === authorityVersion.current) {
          setChannel(target.conversation_id);
          setView('chat');
          setJump(target);
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to open this message link.');
      }
    })();
    return () => controller.abort();
  }, [identity]);
  const outbox = useOfflineOutbox(identity, refresh);
  useEffect(() => {
    void loadBoot();
  }, [loadBoot]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const synchronize = useCallback(
    async (events?: RealtimeBatch['events']) => {
      if (
        !events ||
        events.some((event) =>
          [
            'memory.',
            'connection.',
            'retrieval.',
            'transcript.',
            'knowledge.',
            'message.',
            'migration.',
          ].some((prefix) => event.event_type.startsWith(prefix)),
        )
      )
        setSearchRevision((value) => value + 1);
      if (!events || events.some((event) => event.event_type === 'personal.changed'))
        setPersonalRevision((v) => v + 1);
      const needsBoot =
        !events ||
        events.some(
          (event) =>
            !event.event_type.startsWith('notification.') &&
            !['message.edited', 'message.reaction_changed'].includes(event.event_type),
        );
      if (needsBoot && !(await refreshBootstrap()))
        throw new Error('Unable to refresh workspace access.');

      if (
        !events ||
        events.some(
          (event) =>
            event.event_type.startsWith('notification.') ||
            event.event_type.startsWith('message.') ||
            event.event_type === 'migration.message_imported' ||
            event.event_type === 'shared_channel.changed' ||
            event.event_type.startsWith('conversation.') ||
            event.event_type.startsWith('approval.') ||
            event.event_type.startsWith('member.'),
        )
      )
        await notifications.refresh();
      events = events?.filter((event) => !event.event_type.startsWith('notification.'));
      if (events && events.length === 0) return;
      const needsContent =
        !events ||
        view === 'settings' ||
        (view === 'search' &&
          events.some(
            (event) =>
              ['message.created', 'message.edited', 'message.deleted'].includes(event.event_type) ||
              event.event_type.startsWith('knowledge.') ||
              ['memory.', 'connection.', 'transcript.', 'task.', 'file.'].some((prefix) =>
                event.event_type.startsWith(prefix),
              ) ||
              event.event_type.startsWith('member.') ||
              event.event_type.startsWith('conversation.member'),
          )) ||
        events.some((event) =>
          view === 'chat'
            ? event.conversation_id === channel || event.event_type.startsWith('member.')
            : !event.event_type.startsWith('message.') && event.event_type !== 'conversation.read',
        );
      if (needsContent && !(await refresh())) throw new Error('Unable to refresh live content.');
    },
    [refresh, refreshBootstrap, view, channel, notifications.refresh],
  );

  const connection = useRealtime(
    boot && !signedOut && !verificationRequired ? `${boot.workspace.id}:${boot.me.id}` : null,
    synchronize,
    loadBoot,
    activity.receive,
    revokeConversations,
  );
  const markRead = useReadPosition(
    channel,
    Boolean(boot && view === 'chat' && !signedOut && !verificationRequired),
  );
  const timelineScroll = useTimelineScroll(channel, messages, view === 'chat');
  const threadScroll = useTimelineScroll(
    thread?.id ?? '',
    replies,
    view === 'chat' && Boolean(thread),
  );
  async function send(
    body: string,
    clientId: string,
    attachmentIds: string[],
    mentionIds: string[],
    threadId?: string,
  ) {
    await post(`/conversations/${channel}/messages`, {
      body,
      format: 'markdown',
      expectedAuthorId: boot?.me.id,
      expectedMembershipVersion: boot?.me.version,
      expectedAccessInterval: boot?.channels.find((c) => c.id === channel)?.access_interval_id,
      clientId,
      attachmentIds,
      mentionIds,
      ...(threadId ? { threadId } : {}),
    });
  }
  async function openNotification(notification: InboxNotification) {
    const authority = authorityVersion.current,
      scope = currentContent.current;
    if (notification.message_id) {
      const target = await api<{
        id: string;
        conversation_id: string;
        thread_id: string | null;
        root: Message | null;
      }>(`/messages/${notification.message_id}/context`);
      if (authorityVersion.current !== authority || currentContent.current !== scope)
        throw new Error('Your access or navigation changed. Open the notification again.');
      setChannel(target.conversation_id);
      setView('chat');
      setJump(target);
      return;
    }
    if (
      notification.kind === 'task_assigned' ||
      notification.kind === 'task_comment' ||
      notification.kind === 'task_reminder' ||
      notification.kind === 'task_activity'
    ) {
      const target = notification.task_id ?? notification.resource_id;
      await api(`/tasks/${target}`);
      if (authorityVersion.current !== authority || currentContent.current !== scope)
        throw new Error('Your access or navigation changed. Open the notification again.');
      setSelectedTask(target);
      setView('tasks');
      return;
    }
    if (notification.kind === 'workflow_attention' && notification.workflow_run_id) {
      await api('/workflow-runs/' + notification.workflow_run_id);
      if (authorityVersion.current !== authority || currentContent.current !== scope)
        throw new Error('Your access changed. Open this notification again.');
      setSelectedTask(null);
      setSelectedWorkflow(notification.workflow_run_id);
      setView('tasks');
      return;
    }
    if (notification.kind === 'automation_attention' && notification.automation_id) {
      await api('/automations/' + notification.automation_id);
      if (authorityVersion.current !== authority || currentContent.current !== scope)
        throw new Error('Your access changed. Open this notification again.');
      setSelectedAutomation(notification.automation_id);
      setView('automations');
      return;
    }
    if (notification.kind === 'agent_attention') {
      if (notification.agent_run_id) await api(`/runs/${notification.agent_run_id}/detail`);
      if (authorityVersion.current !== authority || currentContent.current !== scope)
        throw new Error('Your access changed. Open this notification again.');
      setSelectedAgentRun(notification.agent_run_id ?? null);
      setView('runs');
      return;
    }
    if (notification.kind === 'approval_request') {
      setView('approvals');
      return;
    }
    if (notification.conversation_id) {
      setChannel(notification.conversation_id);
      setView('chat');
    }
  }
  const taskCreateRequest = useRef<{ signature: string; id: string } | null>(null);
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(event.currentTarget);
    try {
      if (dialog === 'channel') {
        const result = await post<{ id: string }>('/conversations', {
          name: f.get('name'),
          description: f.get('description'),
          visibility: f.get('visibility'),
        });
        await loadBoot();
        setChannel(result.id);
        setView('chat');
      }
      if (dialog === 'task') {
        const input = {
          title: f.get('title'),
          description: f.get('description'),
          priority: f.get('priority'),
          ...(f.get('assigneeId') ? { assigneeId: f.get('assigneeId') } : {}),
          ...(f.get('conversationId') ? { conversationId: f.get('conversationId') } : {}),
          ...(f.get('dueDate') ? { dueDate: f.get('dueDate') } : {}),
          ...(f.get('projectId') ? { projectId: f.get('projectId') } : {}),
          ...(f.get('milestoneId') ? { milestoneId: f.get('milestoneId') } : {}),
          labelIds: JSON.parse(String(f.get('labelIds') || '[]')) as string[],
        };
        const signature = JSON.stringify(input);
        if (taskCreateRequest.current?.signature !== signature)
          taskCreateRequest.current = { signature, id: crypto.randomUUID() };
        await post('/tasks', { ...input, clientId: taskCreateRequest.current.id });
        taskCreateRequest.current = null;
      }
      if (dialog === 'agent') {
        const result = await post<{ key?: string }>('/agents', {
          name: f.get('name'),
          role: f.get('role'),
          runtime: f.get('runtime') ?? 'external',
        });
        if (result.key) setKey(result.key);
      }
      if (dialog === 'page')
        await post('/knowledge', {
          kind: f.get('kind') ?? 'page',
          title: f.get('title'),
          body: f.get('body'),
          ...(f.get('conversationId') ? { conversationId: f.get('conversationId') } : {}),
        });
      setDialog(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save.');
    } finally {
      setBusy(false);
    }
  }
  async function toggleAgent(agent: Agent) {
    try {
      await api(`/agents/${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: agent.status === 'active' ? 'paused' : 'active' }),
      });
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to update agent.');
    }
  }
  async function rotateAgent(agent: Agent) {
    try {
      const result = await post<{ key: string }>(`/agents/${agent.id}/credentials/rotate`, {});
      setKey(result.key);
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to rotate agent credential.');
    }
  }
  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setSearchQuery(query.trim());
    setView('search');
  }
  if (loading) return <WorkspaceTransition />;
  if (verificationRequired) return <VerificationGate onContinue={loadBoot} />;
  if (identityRequired)
    return (
      <main className="identity-gate">
        <p className="runtime-notice" role="alert">
          {identityRequired}
        </p>
        <AccountSettings onChange={loadBoot} />
        <OrganizationSettings />
        <Button size="sm" className="primary small" onClick={() => void loadBoot()}>
          Continue to workspace
        </Button>
        <a className="text-button" href="/sign-in?reauth=1">
          Sign in with another method
        </a>
      </main>
    );
  if (signedOut)
    return <Auth initialRegister={false} navigation="routes" onComplete={enterWorkspace} />;
  if (!boot)
    return (
      <WorkspaceTransition
        error={error || 'Your workspace could not be loaded. Check your connection and try again.'}
        onRetry={() => void enterWorkspace()}
      />
    );
  const current = boot.channels.find((c) => c.id === channel);
  const title =
    view === 'chat'
      ? (current?.name ?? 'Conversations')
      : {
          notifications: 'Notifications',
          tasks: 'Tasks',
          runs: 'Agent runs',
          approvals: 'Approvals',
          team: 'Team',
          automations: 'Automations',
          developer: 'Developer',
          migrations: 'Migrations',
          shared: 'Shared channels',
          agents: 'Agents',
          knowledge: 'Knowledge',
          settings: 'Workspace settings',
          search: 'Search results',
          personal: 'Your messages',
          discover: 'Channel discovery',
        }[view];
  const dayStarts = new Set(
    messages
      .filter(
        (item, index) =>
          index === 0 ||
          messageDay(messages[index - 1]!.created_at) !== messageDay(item.created_at),
      )
      .map((item) => item.id),
  );
  const SectionIcon = {
    chat: MessageSquare,
    tasks: CheckSquare,
    agents: Bot,
    knowledge: BookOpen,
    notifications: Bell,
    runs: Activity,
    approvals: ShieldCheck,
    team: Users,
    settings: Settings2,
    search: Search,
    personal: Bookmark,
    discover: Hash,
    automations: Workflow,
    developer: Code2,
    migrations: ArrowRightLeft,
    shared: Globe2,
  }[view];
  const sectionDescription = {
    chat: '',
    tasks: 'Tasks, subtasks, dependencies, and due dates.',
    agents: 'Agent identities, instructions, credentials, and memory.',
    knowledge: 'Documents, shared context, and version history.',
    notifications: 'Mentions, replies, and updates for you.',
    runs: 'Execution history, results, and runtime activity.',
    approvals: 'Review proposed actions before they execute.',
    team: 'Members, invitations, roles, and workspace access.',
    settings: 'Your account, preferences, and workspace configuration.',
    search: 'Search conversations, tasks, documents, and files.',
    personal: 'Saved messages, followed threads, drafts, and scheduled delivery.',
    discover: 'Find public channels and conversations shared with you.',
    automations: 'Recurring checks, event rules, and scheduled workflows.',
    developer: 'API keys, OAuth applications, MCP, and webhooks.',
    migrations: 'Imports, synchronization, and workspace exports.',
    shared: 'Conversations shared with other organizations.',
  }[view];
  return (
    <WorkspaceMotion>
      <div className="workspace" data-section={view} data-navigation-open={mobileNavigation}>
        <SharedFileLink key={identity} />
        {mobileNavigation && (
          <Button
            variant="ghost"
            className="navigation-scrim"
            aria-label="Dismiss navigation"
            onClick={closeNavigation}
          />
        )}
        <div className="topbar">
          <Button
            variant="ghost"
            ref={navigationToggle}
            className="mobile-nav-toggle icon-button"
            aria-label="Open navigation"
            aria-controls="workspace-navigation"
            aria-expanded={mobileNavigation}
            onClick={() => setMobileNavigation(!mobileNavigation)}
          >
            <Menu size={21} />
          </Button>
          <span className="breadcrumbs">
            {boot.workspace.name} <span>/</span>{' '}
            <strong>{view === 'chat' ? 'Conversations' : title}</strong>
          </span>
          <form className="search" onSubmit={search}>
            <Search size={15} />
            <Input
              aria-label="Search messages"
              placeholder={`Search ${boot.workspace.name}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </form>
          <WorkspaceCommand
            boot={boot}
            onView={(next) => {
              if (mobileNavigation) closeNavigation();
              if (next === 'tasks') setSelectedTask(null);
              setView(next);
              setError('');
            }}
            onChannel={(id) => {
              if (mobileNavigation) closeNavigation();
              setChannel(id);
              setView('chat');
              setThread(null);
              mainHistory.clear();
            }}
          />
          <AppearanceControl className="mobile-appearance-control" />
        </div>
        <Navigation
          key={identity}
          onClose={closeNavigation}
          boot={boot}
          sidebar={sidebar}
          queued={outbox.items.length}
          view={view}
          channel={channel}
          onView={(next) => {
            if (mobileNavigation) closeNavigation();
            if (next === 'personal') setPersonalTab('saved-messages');
            if (next === 'tasks') setSelectedTask(null);
            setView(next);
            setError('');
          }}
          onCreate={(kind) => {
            if (mobileNavigation) closeNavigation();
            setDialog(kind);
          }}
          onConversation={() => {
            if (mobileNavigation) closeNavigation();
            setNewConversation(true);
          }}
          notifications={notifications.count}
          presenceFallback={activity.snapshot.presence_complete === false ? 'unknown' : 'offline'}
          presenceStates={Object.fromEntries(
            activity.snapshot.presence.map((person) => [person.membership_id, person.state]),
          )}
          presence={
            <PresenceControl mode={activity.snapshot.own_mode} onChange={activity.preference} />
          }
          onChannel={(id) => {
            if (mobileNavigation) closeNavigation();
            setChannel(id);
            setThread(null);
            mainHistory.clear();
          }}
        />
        <main className="main">
          <header className="content-header">
            <div className="header-title">
              <span className="title-icon">
                {view === 'chat' ? (
                  current?.kind === 'group' ? (
                    <Users size={23} />
                  ) : current?.kind === 'direct' ? (
                    <MessageSquare size={23} />
                  ) : (
                    <Hash size={23} />
                  )
                ) : (
                  <SectionIcon size={22} />
                )}
              </span>
              <div>
                <h1>{title}</h1>
                <p>
                  {view === 'chat'
                    ? current?.description ||
                      (current?.kind === 'channel'
                        ? ''
                        : 'Messages and files are shared only with participants.')
                    : sectionDescription}
                </p>
              </div>
            </div>
            {view === 'chat' ? (
              <div className="conversation-header-actions">
                {current && <Calls conversation={current.id} me={boot.me.id} />}
                {current?.kind === 'channel' &&
                  current.visibility === 'public' &&
                  (!inspector || thread) && (
                    <div
                      className="conversation-presence"
                      role="group"
                      aria-label="Workspace presence"
                    >
                      {boot.members
                        .filter((member) => member.kind === 'human')
                        .slice(0, 3)
                        .map((member) => (
                          <span className="conversation-person" key={member.id} title={member.name}>
                            <Avatar name={member.name} />
                            <PresenceDot
                              name={member.name}
                              state={
                                activity.snapshot.presence.find(
                                  (person) => person.membership_id === member.id,
                                )?.state ??
                                (activity.snapshot.presence_complete === false
                                  ? 'unknown'
                                  : 'offline')
                              }
                            />
                          </span>
                        ))}
                    </div>
                  )}
                <Button
                  variant="ghost"
                  className="conversation-members"
                  aria-label="View participants"
                  onClick={() => setShowDetails(true)}
                >
                  <Users size={18} />
                  <span>Members</span>
                </Button>
                <Button
                  variant="ghost"
                  className="icon-button"
                  aria-label="Toggle channel details"
                  aria-pressed={inspector}
                  onClick={() => setInspector(!inspector)}
                >
                  <PanelRight size={19} />
                </Button>
              </div>
            ) : (
              ['tasks', 'agents', 'knowledge'].includes(view) && (
                <Button
                  size="sm"
                  className="primary small"
                  onClick={() =>
                    setDialog(view === 'tasks' ? 'task' : view === 'agents' ? 'agent' : 'page')
                  }
                >
                  <Plus size={16} />
                  {view === 'tasks' ? 'New task' : view === 'agents' ? 'Add agent' : 'New page'}
                </Button>
              )
            )}
          </header>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <Button variant="outline" aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={15} />
              </Button>
            </div>
          )}
          {view === 'chat' && (
            <GettingStarted
              key={`welcome:${identity}`}
              compact
              onNavigate={(step) => {
                if (step === 'conversation') setNewConversation(true);
                else if (step === 'task') {
                  setView('tasks');
                  setDialog('task');
                } else
                  setView(
                    step === 'profile'
                      ? 'settings'
                      : step === 'knowledge'
                        ? 'knowledge'
                        : 'notifications',
                  );
              }}
            />
          )}
          <WorkspaceViewport view={view}>
            {view === 'notifications' && (
              <NotificationCenter
                key={`${identity}:${authorityVersion.current}`}
                revision={notifications.revision}
                onChanged={notifications.refresh}
                onOpen={openNotification}
              />
            )}
            {view === 'automations' && (
              <AutomationView key={identity} boot={boot} initialId={selectedAutomation} />
            )}
            {view === 'developer' && <DeveloperView key={identity} boot={boot} />}
            {view === 'migrations' && <MigrationHub key={identity} boot={boot} />}
            {view === 'shared' && (
              <SharedChannelHub
                key={identity}
                boot={boot}
                onOpen={(id) => {
                  setChannel(id);
                  setView('chat');
                }}
              />
            )}
            {view === 'team' && (
              <TeamView key={boot.workspace.id} boot={boot} onChange={loadBoot} />
            )}
            {(view === 'runs' || view === 'approvals') && (
              <ExecutionView
                key={`${identity}:${authorityVersion.current}:${boot.me.version ?? 0}:${boot.me.role}:${JSON.stringify(boot.me.permissions ?? {})}:${view}`}
                mode={view}
                boot={boot}
                initialRunId={selectedAgentRun}
                onRunOpened={clearSelectedAgentRun}
              />
            )}
            {view === 'chat' && (
              <>
                <section className="conversation">
                  {messages.length === 0 && (
                    <div className="conversation-welcome">
                      <h2>
                        {current?.kind === 'channel' ? 'Welcome to #' : 'Welcome to '}
                        {current?.name}
                      </h2>
                      <p>
                        {current?.description ? `${current.description} ` : ''}Share an idea, ask a
                        question, or bring an agent into the conversation.
                      </p>
                    </div>
                  )}
                  <div className="conversation-toolbar">
                    <span className="conversation-tab">
                      <MessageSquare size={15} /> Messages
                    </span>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setPersonalTab('pins');
                        setView('personal');
                      }}
                    >
                      <Pin size={14} /> Pinned messages
                    </Button>
                    <span className="conversation-access">
                      {current?.kind !== 'channel' || current?.visibility === 'private' ? (
                        <>
                          <Lock size={13} /> Private conversation
                        </>
                      ) : (
                        <>
                          <Hash size={13} /> Workspace channel
                        </>
                      )}
                    </span>
                  </div>
                  <div
                    className="messages"
                    ref={timelineScroll.container}
                    onScroll={timelineScroll.onScroll}
                  >
                    {mainHistory.older !== null && (
                      <Button
                        variant="outline"
                        className="history-button"
                        disabled={mainHistory.paging}
                        onClick={() => void mainHistory.olderPage()}
                      >
                        Load older messages
                      </Button>
                    )}
                    {mainHistory.error && (
                      <p role="alert">
                        {mainHistory.error}{' '}
                        <Button variant="outline" onClick={() => void mainHistory.refresh()}>
                          Retry history
                        </Button>
                      </p>
                    )}
                    {messages.length === 0 && (
                      <p className="quiet-empty">A clean slate. Start the conversation below.</p>
                    )}
                    <VirtualMessages
                      items={messages}
                      container={timelineScroll.container}
                      anchor={anchor?.id}
                      render={(message) => (
                        <>
                          {dayStarts.has(message.id) && (
                            <div className="message-day-divider">
                              <span>{messageDayLabel(message.created_at)}</span>
                            </div>
                          )}
                          <MessageRow
                            key={message.id}
                            message={message}
                            me={boot.me}
                            workspaceId={boot.workspace.id}
                            onChanged={refresh}
                            onRead={markRead}
                            onThread={() => setThread(message)}
                          />
                        </>
                      )}
                    />
                  </div>
                  {mainHistory.newer !== null && (
                    <Button
                      variant="outline"
                      className="history-button"
                      disabled={mainHistory.paging}
                      onClick={() => void mainHistory.newerPage()}
                    >
                      Load newer messages
                    </Button>
                  )}
                  {timelineScroll.unseen && (
                    <Button
                      variant="outline"
                      className="jump-to-latest"
                      onClick={timelineScroll.jump}
                    >
                      Jump to latest messages
                    </Button>
                  )}
                  {anchor && (
                    <Button
                      variant="outline"
                      className="jump-to-latest"
                      onClick={() => {
                        timelineScroll.jump();
                        setAnchor(null);
                        setThread(null);
                      }}
                    >
                      Back to latest conversation
                    </Button>
                  )}
                  <TypingIndicator
                    snapshot={activity.snapshot}
                    received={activity.received}
                    conversation={channel}
                    me={boot.me.id}
                  />
                  {current?.archived_at ? (
                    <p role="status" className="archived-banner">
                      This channel is archived. Its history is available; restore it to send new
                      messages.
                    </p>
                  ) : current?.history_policy === 'join_time' && !current.joined ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        void api(`/conversations/${channel}/join`, { method: 'PUT' })
                          .then(loadBoot)
                          .catch((e) =>
                            setError(e instanceof Error ? e.message : 'Unable to join channel.'),
                          );
                      }}
                    >
                      Join channel to send and read new messages
                    </Button>
                  ) : (
                    <Composer
                      key={channel}
                      conversationId={channel}
                      identity={identity!}
                      authorId={boot.me.id}
                      membershipVersion={boot.me.version}
                      accessInterval={current?.access_interval_id}
                      onSent={refresh}
                      onTyping={(active) => activity.typing(channel, undefined, active)}
                      onSend={(body, clientId, attachmentIds, mentionIds) =>
                        send(body, clientId, attachmentIds, mentionIds)
                      }
                      placeholder={`Message ${current?.kind === 'channel' ? '#' : ''}${current?.name ?? 'conversation'}`}
                    />
                  )}
                  <footer className="composer-footer">
                    <span>
                      <strong>Enter</strong> to send · <strong>Shift + Enter</strong> for a new line
                    </span>
                    <span>
                      {connection === 'live'
                        ? 'Live updates connected'
                        : connection === 'connecting'
                          ? 'Connecting live updates…'
                          : 'Reconnecting live updates…'}{' '}
                      <span className={connection === 'live' ? 'online-dot' : 'reconnecting-dot'} />
                    </span>
                  </footer>
                </section>
                {thread ? (
                  <aside className="thread-panel">
                    <header>
                      <strong>Thread</strong>
                      <Button
                        variant="outline"
                        aria-label="Close thread"
                        onClick={() => setThread(null)}
                      >
                        <X size={18} />
                      </Button>
                    </header>
                    <DeliverySourceControl key={thread.id} scope="thread" resourceId={thread.id} />
                    <MessageRow
                      message={messages.find((message) => message.id === thread.id) ?? thread}
                      me={boot.me}
                      workspaceId={boot.workspace.id}
                      onChanged={refresh}
                      onRead={markRead}
                    />
                    <div className="date-divider">
                      <span>
                        {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
                        {replyHistory.older !== null || replyHistory.newer !== null
                          ? ' loaded'
                          : ''}
                      </span>
                    </div>
                    <div
                      className="thread-replies"
                      ref={threadScroll.container}
                      onScroll={threadScroll.onScroll}
                    >
                      {replyHistory.older !== null && (
                        <Button
                          variant="outline"
                          className="history-button"
                          disabled={replyHistory.paging}
                          onClick={() => void replyHistory.olderPage()}
                        >
                          Load older replies
                        </Button>
                      )}
                      {replyHistory.error && (
                        <p role="alert">
                          {replyHistory.error}{' '}
                          <Button variant="outline" onClick={() => void replyHistory.refresh()}>
                            Retry replies
                          </Button>
                        </p>
                      )}
                      <VirtualMessages
                        items={replies}
                        container={threadScroll.container}
                        anchor={anchor?.id}
                        render={(m) => (
                          <MessageRow
                            key={m.id}
                            message={m}
                            me={boot.me}
                            workspaceId={boot.workspace.id}
                            onChanged={refresh}
                            onRead={markRead}
                          />
                        )}
                      />
                    </div>
                    {replyHistory.newer !== null && (
                      <Button
                        variant="outline"
                        className="history-button"
                        disabled={replyHistory.paging}
                        onClick={() => void replyHistory.newerPage()}
                      >
                        Load newer replies
                      </Button>
                    )}
                    {threadScroll.unseen && (
                      <Button
                        variant="outline"
                        className="jump-to-latest"
                        onClick={threadScroll.jump}
                      >
                        Jump to latest replies
                      </Button>
                    )}
                    <TypingIndicator
                      snapshot={activity.snapshot}
                      received={activity.received}
                      conversation={channel}
                      threadId={thread.id}
                      me={boot.me.id}
                    />
                    <Composer
                      key={thread.id}
                      conversationId={channel}
                      identity={identity!}
                      authorId={boot.me.id}
                      membershipVersion={boot.me.version}
                      accessInterval={current?.access_interval_id}
                      threadId={thread.id}
                      onSent={refresh}
                      onTyping={(active) => activity.typing(channel, thread.id, active)}
                      onSend={(body, clientId, attachmentIds, mentionIds) =>
                        send(body, clientId, attachmentIds, mentionIds, thread.id)
                      }
                      placeholder="Reply to thread"
                    />
                  </aside>
                ) : (
                  inspector && (
                    <aside className="inspector">
                      <div className="inspector-art" aria-hidden="true">
                        {current?.kind === 'channel' ? (
                          <Hash size={30} />
                        ) : (
                          <MessageSquare size={30} />
                        )}
                      </div>
                      <span className="eyebrow">
                        {current?.kind === 'channel'
                          ? 'ABOUT THIS CHANNEL'
                          : 'ABOUT THIS CONVERSATION'}
                      </span>
                      <h3>
                        {current?.kind === 'channel' ? '#' : ''}
                        {current?.name ?? 'Conversation'}
                      </h3>
                      <p>
                        {current?.description ||
                          'Conversations, decisions, and shared context for your team.'}
                      </p>
                      <div className="detail-line">
                        <Hash size={16} />
                        {current?.kind === 'direct'
                          ? 'Direct message'
                          : current?.kind === 'group'
                            ? 'Private group'
                            : current?.visibility === 'private'
                              ? 'Private channel'
                              : 'Open to workspace'}
                      </div>
                      <div className="detail-line">
                        <Activity size={16} />
                        Changes sync automatically
                      </div>
                      <ConversationNotifications
                        key={channel}
                        conversation={channel}
                        revision={notifications.revision}
                      />
                      <DeliverySourceControl scope="conversation" resourceId={channel} />
                      <Separator className="inspector-divider" />
                      <span className="eyebrow">
                        {current?.kind === 'channel' ? 'YOUR TEAM' : 'PARTICIPANTS'}
                      </span>
                      <Button
                        variant="outline"
                        className="subtle-button"
                        onClick={() => setShowDetails(true)}
                      >
                        <Users size={16} />
                        Manage participants
                      </Button>
                      <div className="member-list">
                        {(current?.kind === 'channel' ? boot.members : []).slice(0, 6).map((m) => (
                          <div key={m.id}>
                            <Avatar name={m.name} agent={m.kind === 'agent'} />
                            <span>
                              {m.name}{' '}
                              {m.kind === 'human' && (
                                <PresenceDot
                                  name={m.name}
                                  state={
                                    activity.snapshot.presence.find(
                                      (person) => person.membership_id === m.id,
                                    )?.state ??
                                    (activity.snapshot.presence_complete === false
                                      ? 'unknown'
                                      : 'offline')
                                  }
                                />
                              )}
                              <small>
                                {m.kind === 'agent'
                                  ? 'Agent teammate'
                                  : m.role === 'owner'
                                    ? 'Workspace owner'
                                    : 'Teammate'}
                              </small>
                            </span>
                            <Badge variant="outline" className="status-pill">
                              {m.kind === 'agent' ? 'Agent' : 'Member'}
                            </Badge>
                          </div>
                        ))}
                      </div>
                      {current?.kind === 'channel' && (
                        <Button
                          variant="outline"
                          className="subtle-button"
                          onClick={() => {
                            setView('agents');
                            setDialog('agent');
                          }}
                        >
                          <Plus size={15} /> Add an agent
                        </Button>
                      )}
                    </aside>
                  )
                )}
              </>
            )}
            {view === 'tasks' && (
              <TaskView
                key={`${identity}:${authorityVersion.current}`}
                revision={taskRevision}
                openWorkflow={selectedWorkflow}
                onWorkflow={setSelectedWorkflow}
                me={boot.me}
                members={boot.members}
                channels={boot.channels}
                selectedId={selectedTask}
                onSelect={setSelectedTask}
                onChanged={refresh}
                onCreate={() => setDialog('task')}
              />
            )}
            {view === 'agents' && (
              <AgentView
                key={`${identity}:${authorityVersion.current}:${boot.me.version ?? 0}:${boot.me.role}:${JSON.stringify(boot.me.permissions ?? {})}`}
                boot={boot}
                memoryRevision={searchRevision}
                agents={agents}
                loading={agentCollection.busy}
                onCreate={() => setDialog('agent')}
                onToggle={toggleAgent}
                onRotate={rotateAgent}
                canManage={
                  ['owner', 'admin'].includes(boot.me.role) &&
                  boot.me.permissions?.['agents.manage'] !== false
                }
              />
            )}
            {view === 'personal' && (
              <PersonalMessages
                key={`${identity}:${authorityVersion.current}:${personalTab}:${channel}`}
                identity={identity!}
                revision={personalRevision}
                outbox={outbox.items}
                initialTab={personalTab}
                conversation={channel}
                onRetry={outbox.retry}
                onRemove={outbox.remove}
                onOpen={async (id) => {
                  const expected = authorityVersion.current,
                    scope = currentContent.current;
                  try {
                    const target = await api<NonNullable<typeof anchor>>(`/messages/${id}/context`);
                    if (expected !== authorityVersion.current || scope !== currentContent.current)
                      return;
                    setChannel(target.conversation_id);
                    setView('chat');
                    setJump(target);
                  } catch (error) {
                    if (expected === authorityVersion.current && scope === currentContent.current)
                      setError(error instanceof Error ? error.message : 'Unable to open message.');
                  }
                }}
                onConversation={(id, threadId) => {
                  if (!threadId) {
                    setChannel(id);
                    setView('chat');
                    return;
                  }
                  const expected = authorityVersion.current,
                    scope = currentContent.current;
                  void api<{ items: Message[] }>(
                    `/conversations/${id}/messages/history?around=${threadId}&limit=1`,
                  )
                    .then((history) => {
                      if (expected !== authorityVersion.current || scope !== currentContent.current)
                        return;
                      const root = history.items.find((message) => message.id === threadId);
                      if (!root) throw new Error('This draft thread is no longer available.');
                      setChannel(id);
                      setView('chat');
                      setJump({ id: threadId, conversation_id: id, thread_id: null, root });
                    })
                    .catch((error) => {
                      if (expected === authorityVersion.current && scope === currentContent.current)
                        setError(
                          error instanceof Error ? error.message : 'Unable to open draft thread.',
                        );
                    });
                }}
              />
            )}
            {view === 'discover' && (
              <ChannelBrowser
                boot={boot}
                revision={personalRevision}
                onOpen={(id) => {
                  setChannel(id);
                  setView('chat');
                }}
                onChanged={loadBoot}
              />
            )}
            {view === 'agents' && (
              <PageControls {...agentCollection} onMore={agentCollection.more} />
            )}
            {view === 'knowledge' && (
              <KnowledgeView
                boot={boot}
                key={`${identity}:${authorityVersion.current}`}
                pages={pages}
                loading={knowledgeCollection.busy}
                onChanged={refresh}
                selectedPage={selectedPage}
                setSelectedPage={setSelectedPage}
                onCreate={() => setDialog('page')}
              />
            )}
            {view === 'search' && (
              <SearchView
                key={`${identity}:${authorityVersion.current}:${boot.workspace.retrieval_epoch}`}
                onEvidence={async (hit) => {
                  const expected = authorityVersion.current,
                    scope = currentContent.current;
                  if (hit.kind === 'message') {
                    const context = await api<NonNullable<typeof anchor>>(
                      `/messages/${hit.id}/context`,
                    );
                    if (expected !== authorityVersion.current || scope !== currentContent.current)
                      return;
                    setChannel(context.conversation_id);
                    setView('chat');
                    setJump(context);
                  } else if (hit.kind === 'knowledge') {
                    const page = await api<Page>(`/knowledge/${hit.id}`);
                    if (expected !== authorityVersion.current || scope !== currentContent.current)
                      return;
                    setSelectedPage(page);
                    setView('knowledge');
                  } else if (hit.kind === 'task') {
                    await api(`/tasks/${hit.id}`);
                    if (expected !== authorityVersion.current || scope !== currentContent.current)
                      return;
                    setSelectedTask(hit.id);
                    setView('tasks');
                  } else if (hit.kind === 'file') {
                    window.open(`/api/v1/files/${hit.id}/content`, '_blank', 'noopener,noreferrer');
                  }
                }}
                query={searchQuery}
                revision={searchRevision}
                channels={boot.channels}
                members={boot.members}
                onMessage={async (id) => {
                  const expected = authorityVersion.current,
                    scope = currentContent.current;
                  const context = await api<NonNullable<typeof anchor>>(`/messages/${id}/context`);
                  if (expected !== authorityVersion.current || scope !== currentContent.current)
                    return;
                  setChannel(context.conversation_id);
                  setView('chat');
                  setJump(context);
                }}
                onPage={async (id) => {
                  const expected = authorityVersion.current,
                    scope = currentContent.current;
                  const page = await api<Page>(`/knowledge/${id}`);
                  if (expected !== authorityVersion.current || scope !== currentContent.current)
                    return;
                  setSelectedPage(page);
                  setView('knowledge');
                }}
              />
            )}
            {view === 'knowledge' && (
              <PageControls {...knowledgeCollection} onMore={knowledgeCollection.more} />
            )}
            {view === 'settings' && (
              <section className="page-content workspace-settings">
                <WorkspaceHeading
                  icon={Settings2}
                  eyebrow="Make Orbit your own"
                  title="Workspace settings"
                  description="Manage your profile, team preferences, connections, and workspace controls."
                />
                <WorkspaceSettingsNav />
                <div className="workspace-settings-anchor" id="workspace-settings-overview">
                  <GettingStarted key={identity} />
                </div>
                <div className="workspace-settings-anchor" id="workspace-settings-appearance">
                  <AppearanceSettings />
                </div>
                <div className="workspace-settings-anchor" id="workspace-settings-profile">
                  <AccountSettings onChange={loadBoot} />
                </div>
                <SidebarSettings
                  boot={boot}
                  onChanged={async () => {
                    setPersonalRevision((v) => v + 1);
                    await loadBoot();
                  }}
                />
                <div className="workspace-settings-anchor" id="workspace-settings-organization">
                  <OrganizationSettings />
                </div>
                {['owner', 'admin'].includes(boot.me.role) && <FilePolicySettings key={identity} />}
                <div className="workspace-settings-anchor" id="workspace-settings-connections">
                  <ConnectionSettings
                    key={`${identity}:${authorityVersion.current}:${JSON.stringify(boot.me.permissions ?? {})}`}
                    boot={boot}
                  />
                </div>
                {boot.me.role === 'owner' && <ServiceAccountSettings boot={boot} />}
                <div className="settings-grid">
                  <Card asChild>
                    <article className="settings-card">
                      <span className="eyebrow">WORKSPACE</span>
                      <h2>{boot.workspace.name}</h2>
                      <p className="muted">
                        {boot.me.name} · {boot.me.role}
                      </p>
                      <p>
                        {boot.members.length} members · {boot.channels.length} accessible channels
                      </p>
                      <Button
                        variant="outline"
                        className="subtle-button"
                        onClick={async () => {
                          await clearPrivateStorage().catch(() => {});
                          await post('/auth/signout', {});
                          invalidateBootstrap();
                          bootstrapSnapshot.current = null;
                          setBoot(null);
                          setSignedOut(true);
                        }}
                      >
                        <LogOut size={15} />
                        Sign out
                      </Button>
                    </article>
                  </Card>
                  <Card asChild>
                    <article className="settings-card">
                      <span className="eyebrow">TEAM & ACCESS</span>
                      <h3>Keep your workspace in good hands.</h3>
                      <p className="muted">
                        Review your team’s roles and agent access as your workspace grows.
                        Organization policies keep responsibilities and permissions clear.
                      </p>
                      <div className="document-actions">
                        <Button variant="outline" onClick={() => setView('team')}>
                          Manage members
                        </Button>
                        <Button variant="outline" onClick={() => setView('agents')}>
                          Review agents
                        </Button>
                      </div>
                    </article>
                  </Card>
                </div>
                <h3 className="section-title">Workspace activity</h3>
                <div className="audit-list">
                  {audit.length === 0 ? (
                    <p className="muted">Your workspace activity will appear here.</p>
                  ) : (
                    audit.map((event) => (
                      <div key={event.id}>
                        <Activity size={15} />
                        <span>
                          <strong>{event.actor_name}</strong> {event.action.replaceAll('.', ' ')}
                        </span>
                        <time>{new Date(event.created_at).toLocaleString()}</time>
                      </div>
                    ))
                  )}
                </div>
                <PageControls {...auditCollection} onMore={auditCollection.more} />
              </section>
            )}
          </WorkspaceViewport>
        </main>
        {newConversation && (
          <NewConversationDialog
            boot={boot}
            onClose={() => setNewConversation(false)}
            onCreated={async (id) => {
              await loadBoot();
              setChannel(id);
              setView('chat');
            }}
          />
        )}
        {showDetails && current && (
          <ConversationDetailsDialog
            key={current.id}
            channel={current}
            presence={activity.snapshot.presence}
            boot={boot}
            onClose={() => setShowDetails(false)}
            onChanged={loadBoot}
          />
        )}
        {dialog && (
          <CreateDialog
            dialog={dialog}
            members={boot.members}
            channels={boot.channels}
            busy={busy}
            error={error}
            onClose={() => setDialog(null)}
            onSubmit={create}
          />
        )}
        {key && (
          <Dialog title="Your agent credential" onClose={() => setKey('')}>
            <p className="muted">
              Save this credential securely. It will not be shown again. Your runtime can read its
              inbox at <code>/v1/agent/inbox</code> and post messages using this Bearer credential.
            </p>
            <code className="credential">{key}</code>
            <Button className="primary" onClick={() => void navigator.clipboard.writeText(key)}>
              <Copy size={16} />
              Copy credential
            </Button>
            <p className="muted">
              Choose the agent from the composer’s mention picker to create work. Creating an
              identity does not start an AI runtime.
            </p>
          </Dialog>
        )}
      </div>
    </WorkspaceMotion>
  );
}
