'use client';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { Bot, Plus, Pause, Play } from 'lucide-react';
import type { Agent, Bootstrap } from '@ao/contracts';
import { useState } from 'react';
import { MemoryPanel } from './memory-panel';
import { AgentControls } from './agent-controls';
import { Avatar, Empty } from './primitives';
import { WorkspaceHeading, CollectionSkeleton } from './workspace-heading';
export function AgentView({
  agents,
  onCreate,
  onToggle,
  onRotate,
  canManage,
  boot,
  memoryRevision,
  loading = false,
}: {
  agents: Agent[];
  onCreate: () => void;
  onToggle: (agent: Agent) => Promise<void>;
  onRotate: (agent: Agent) => Promise<void>;
  canManage: boolean;
  boot: Bootstrap;
  memoryRevision: number;
  loading?: boolean;
}) {
  const [selected, setSelected] = useState<Agent | null>(null);
  return (
    <section className="page-content agents-page">
      <WorkspaceHeading
        icon={Bot}
        eyebrow="Your extended team"
        title="Your agents"
        description="Give every agent a clear role, the right context, and permission to act."
      />
      {loading && !agents.length ? (
        <CollectionSkeleton label="Loading agents…" />
      ) : agents.length === 0 ? (
        <Empty
          icon={Bot}
          title="Make your first introduction"
          description="Give your agent a name, a role, and a workspace identity. Connect its runtime with a scoped credential."
          action={
            canManage ? (
              <Button size="sm" className="primary small" onClick={() => onCreate()}>
                Add an agent <Plus size={16} />
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="card-grid">
          {agents.map((agent) => (
            <Card key={agent.id} asChild>
              <article className="agent-card">
                <div className="card-top agent-identity">
                  <Avatar name={agent.name} agent />
                  <div>
                    <h3>{agent.name}</h3>
                    <span className="agent-identity-caption">
                      {agent.runtime === 'managed' ? 'Hosted agent' : 'Connected runtime'}
                    </span>
                  </div>
                  <Badge
                    variant="outline"
                    className={`state ${agent.status === 'active' ? 'active' : 'blocked'}`}
                  >
                    {agent.status}
                  </Badge>
                </div>
                <p className="agent-instructions">{agent.instructions}</p>
                <div className="agent-runtime">
                  {agent.runtime === 'managed'
                    ? 'Hosted runtime · controlled execution'
                    : 'External runtime · connection required'}
                </div>
                <Button
                  variant="outline"
                  className="subtle-button"
                  onClick={() => setSelected(agent)}
                >
                  Agent controls
                </Button>
                {canManage && agent.status !== 'archived' && (
                  <Button
                    variant="outline"
                    className="subtle-button"
                    onClick={() => void onToggle(agent)}
                  >
                    {agent.status === 'active' ? <Pause size={14} /> : <Play size={14} />}{' '}
                    {agent.status === 'active' ? 'Pause agent' : 'Resume agent'}
                  </Button>
                )}
                {canManage && agent.runtime === 'external' && agent.status !== 'archived' && (
                  <Button
                    variant="outline"
                    className="subtle-button"
                    onClick={() => void onRotate(agent)}
                  >
                    Rotate credential
                  </Button>
                )}
              </article>
            </Card>
          ))}
        </div>
      )}
      <MemoryPanel
        key={boot.workspace.retrieval_epoch}
        revision={memoryRevision}
        memberId={boot.me.id}
        destinations={boot.channels}
      />
      {selected && (
        <AgentControls
          agent={selected}
          boot={boot}
          canManage={canManage}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
