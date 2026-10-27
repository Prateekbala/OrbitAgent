import type { FastifyRequest } from 'fastify';
import type { Permission } from '@ao/contracts';
import type { Identity } from '../lib/policy.js';
import { AppError } from '../lib/errors.js';
const management = new Set<Permission>(['people.manage', 'agents.manage', 'workspace.manage']);
export function hasPermission(p: Identity, permission: Permission) {
  const override = p.permissions?.[permission];
  if (override !== undefined) return override;
  if (p.accessType === 'service') return false;
  if (p.accessType === 'guest')
    return [
      'messages.read',
      'messages.write',
      'tasks.read',
      'tasks.write',
      'knowledge.read',
      'files.read',
      'files.write',
      'projects.read',
      'people.read',
    ].includes(permission);
  return !management.has(permission) || (p.kind === 'human' && ['owner', 'admin'].includes(p.role));
}
export function authorizeRequest(p: Identity, req: FastifyRequest) {
  const path = (req.routeOptions.url ?? req.url.split('?')[0]!).replace(/^\/v1\//, '');
  const write = !['GET', 'HEAD'].includes(req.method);
  if (p.credentialId) {
    const scope = path.startsWith('agent/inbox')
      ? write
        ? 'inbox.work'
        : 'inbox.read'
      : /^(events|activity)(\/|$)/.test(path)
        ? 'inbox.read'
        : /^(messages|conversations)(\/|$)/.test(path)
          ? write
            ? 'messages.write'
            : 'messages.read'
          : /^tasks(\/|$)/.test(path)
            ? write
              ? 'tasks.write'
              : 'tasks.read'
            : /^knowledge(\/|$)/.test(path) && !write
              ? 'knowledge.read'
              : (/^search(\/|$)/.test(path) &&
                    (!write ||
                      ['search/retrieve', 'search/answer', 'search/embeddings'].includes(path))) ||
                  (/^memory(\/|$)/.test(path) && !write)
                ? 'search.read'
                : /^files(\/|$)/.test(path) && !write
                  ? 'files.read'
                  : undefined;
    if (!scope || !p.credentialScopes?.includes(scope))
      throw new AppError(
        403,
        'CREDENTIAL_SCOPE_REQUIRED',
        'This credential does not grant that operation.',
      );
    const capability = scope.startsWith('inbox.') ? 'messages.read' : scope;
    const denied =
      capability === 'search.read'
        ? ['messages.read', 'tasks.read', 'knowledge.read', 'files.read', 'projects.read'].some(
            (permission) => p.permissions?.[permission as Permission] === false,
          )
        : p.permissions?.[capability as Permission] === false;
    if (denied)
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'The agent membership no longer grants this capability.',
      );
    return;
  }
  if (path.startsWith('agent/inbox') && p.kind === 'agent' && p.accessType !== 'service') return;
  let permission: Permission | undefined;
  if (p.accessType === 'guest' && ['conversations/direct', 'conversations/groups'].includes(path))
    throw new AppError(
      403,
      'GUEST_CONVERSATION_RESTRICTED',
      'Guests collaborate in conversations shared by an administrator.',
    );
  if (/^(account|organizations|auth|workspaces)(\/|$)/.test(path)) {
    if (p.accessType === 'service')
      throw new AppError(403, 'HUMAN_REQUIRED', 'This operation requires a human account.');
    return;
  }
  if (
    /^messages\/[^/]+\/(saved|follow)$/.test(path) ||
    /^conversations\/[^/]+\/draft$/.test(path) ||
    path === 'sidebar'
  ) {
    if (p.kind !== 'human' || !hasPermission(p, 'messages.read'))
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'Personal organization requires a human account with message access.',
      );
    return;
  }
  if (/^(sidebar|drafts|saved-messages|followed-threads|scheduled-messages)(\/|$)/.test(path)) {
    if (p.kind !== 'human')
      throw new AppError(403, 'HUMAN_REQUIRED', 'Personal organization requires a human account.');
    if (!hasPermission(p, write ? 'messages.write' : 'messages.read'))
      throw new AppError(403, 'PERMISSION_DENIED', 'Message permission is required.');
    return;
  }
  if (path === 'bootstrap' && p.accessType === 'service' && !hasPermission(p, 'people.read'))
    throw new AppError(403, 'PERMISSION_DENIED', 'Bootstrap requires people.read.');
  if (/^(bootstrap|events|activity|presence|notifications|notification-delivery)(\/|$)/.test(path))
    return;
  if (path.startsWith('collections/')) return;
  if (/^search(\/|$)/.test(path)) {
    if (
      !['messages.read', 'tasks.read', 'knowledge.read', 'files.read', 'projects.read'].every((v) =>
        hasPermission(p, v as Permission),
      )
    )
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'Search requires permission to read searchable content.',
      );
    return;
  }
  if (/^(migrations|migration-normalize|workspace-export)(\/|$)/.test(path))
    permission = 'workspace.manage';
  else if (/^shared-channels(\/|$)/.test(path))
    permission = write ? 'messages.write' : 'messages.read';
  else if (/^(automations|automation-occurrences)(\/|$)/.test(path))
    permission = write ? 'execution.manage' : 'execution.read';
  else if (/^connections(\/|$)/.test(path))
    permission = write ? 'execution.manage' : 'knowledge.read';
  else if (/^memory(\/|$)/.test(path)) permission = write ? 'knowledge.write' : 'knowledge.read';
  else if (/^(members|invitations)(\/|$)/.test(path))
    permission = write ? 'people.manage' : 'people.read';
  else if (/^channels(\/|$)/.test(path)) permission = 'messages.read';
  else if (/^calls(\/|$)/.test(path)) permission = write ? 'messages.write' : 'messages.read';
  else if (/^agents?(\/|$)/.test(path)) permission = write ? 'agents.manage' : 'agents.read';
  else if (/^(runs|approvals|execution)(\/|$)/.test(path))
    permission = write ? 'execution.manage' : 'execution.read';
  else if (/^audit(\/|$)/.test(path)) permission = 'workspace.manage';
  else if (/^file-shares(\/|$)/.test(path)) permission = 'files.read';
  else if (/^(files|tasks\/[^/]+\/attachments|conversations\/[^/]+\/files)(\/|$)/.test(path))
    permission = write ? 'files.write' : 'files.read';
  else if (
    /^(tasks|task-schedules|work-templates|workflow-runs|workflow-triggers|workflow-notices|calendar)(\/|$)/.test(
      path,
    )
  )
    permission = write ? 'tasks.write' : 'tasks.read';
  else if (/^(projects|labels|portfolios|business-calendars)(\/|$)/.test(path))
    permission = write ? 'projects.write' : 'projects.read';
  else if (/^knowledge-retention$/.test(path)) permission = 'workspace.manage';
  else if (/^knowledge(\/|$)/.test(path)) permission = write ? 'knowledge.write' : 'knowledge.read';
  else if (/^conversations$/.test(path) || (write && /^conversations\/[^/]+\/members/.test(path)))
    permission = 'workspace.manage';
  else if (/^(conversations|messages)(\/|$)/.test(path))
    permission = write ? 'messages.write' : 'messages.read';
  if (permission && !hasPermission(p, permission))
    throw new AppError(403, 'PERMISSION_DENIED', `This account lacks ${permission}.`);
  if (
    permission &&
    ['guest', 'service'].includes(p.accessType ?? '') &&
    (permission.startsWith('execution.') ||
      permission.startsWith('agents.') ||
      permission.endsWith('.manage'))
  )
    throw new AppError(
      403,
      'PERMISSION_DENIED',
      'Restricted accounts cannot administer workspace resources or hosted execution.',
    );
  if (!permission && (p.accessType === 'service' || p.accessType === 'guest'))
    throw new AppError(
      403,
      'PERMISSION_DENIED',
      'This operation is not available to restricted accounts.',
    );
}
