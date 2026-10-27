import {
  ArrowUpRight,
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  FileText,
  Hash,
  Link2,
  LockKeyhole,
  MessageSquare,
  MoreHorizontal,
  Search,
  SendHorizontal,
  ShieldCheck,
} from 'lucide-react';
import styles from './landing.module.css';
import { Reveal } from './landing-motion';

function PreviewWindow({
  title,
  children,
  dark = false,
}: {
  title: string;
  children: React.ReactNode;
  dark?: boolean;
}) {
  return (
    <div className={`${styles.previewWindow} ${dark ? styles.glassWindow : ''}`}>
      <div className={styles.windowBar}>
        <span className={styles.windowDots} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>
          Orbit <ChevronRight size={14} /> <strong>{title}</strong>
        </span>
        <small>Product preview</small>
      </div>
      {children}
    </div>
  );
}

export function ConversationPreview() {
  return (
    <div className={styles.previewLandscape}>
      <PreviewWindow title="Product launch">
        <div className={styles.chatPreview}>
          <aside className={styles.previewSidebar} aria-hidden="true">
            <strong>Acme Studio</strong>
            <span>
              <MessageSquare size={15} /> Conversations
            </span>
            <span>
              <Check size={15} /> Tasks
            </span>
            <span>
              <Bot size={15} /> Agents
            </span>
            <span>
              <BookOpen size={15} /> Knowledge
            </span>
            <small>CHANNELS</small>
            <span className={styles.previewSelected}>
              <Hash size={15} /> product-launch
            </span>
            <span>
              <Hash size={15} /> design
            </span>
            <span>
              <Hash size={15} /> engineering
            </span>
          </aside>
          <div className={styles.previewChat}>
            <div className={styles.previewChatHeading}>
              <Hash size={19} />
              <strong>product-launch</strong>
              <span>3 members</span>
              <MoreHorizontal size={19} />
            </div>
            <p className={styles.previewDate}>Today</p>
            <div className={styles.sampleMessage}>
              <span className={styles.sampleAvatar}>MK</span>
              <div>
                <strong>
                  Maya Kim <small>10:24 AM</small>
                </strong>
                <p>
                  The launch brief is ready. Can we turn the final review into a task and keep the
                  decision here?
                </p>
              </div>
            </div>
            <div className={styles.sampleMessage}>
              <span className={`${styles.sampleAvatar} ${styles.botAvatar}`}>
                <Bot size={19} />
              </span>
              <div>
                <strong>
                  Atlas <em>AGENT</em>
                  <small>10:25 AM</small>
                </strong>
                <p>
                  I’ve prepared the next step with the brief attached. You can review the proposed
                  action before it runs.
                </p>
                <div className={styles.inlineTask}>
                  <Check size={16} />
                  <span>
                    Review the launch brief<small>Linked to this conversation</small>
                  </span>
                  <ArrowUpRight size={15} />
                </div>
              </div>
            </div>
            <div className={styles.previewComposer}>
              <span>Message #product-launch</span>
              <SendHorizontal size={17} />
            </div>
          </div>
        </div>
      </PreviewWindow>
    </div>
  );
}

export function AgentPreview() {
  return (
    <div className={`${styles.previewLandscape} ${styles.agentLandscape}`}>
      <PreviewWindow title="Agent execution" dark>
        <div className={styles.agentPreviewBody}>
          <span className={styles.previewBadge}>
            <Bot size={15} /> Atlas · Launch assistant
          </span>
          <h3>Good work. With a clear trail.</h3>
          <p>A scoped run, a visible plan, and your approval where it matters.</p>
          <ol className={styles.runSteps}>
            <li>
              <Check size={16} />
              <span>
                Read the project brief<small>Knowledge · Launch plan, version 3</small>
              </span>
              <em>Complete</em>
            </li>
            <li>
              <Check size={16} />
              <span>
                Check open dependencies<small>Projects · Website launch</small>
              </span>
              <em>Complete</em>
            </li>
            <li>
              <ShieldCheck size={16} />
              <span>
                Create the final review task<small>External or sensitive actions stay gated</small>
              </span>
              <em>Awaiting approval</em>
            </li>
          </ol>
          <div className={styles.approvalFoot}>
            <span>
              <LockKeyhole size={14} /> You’re in control
            </span>
            <span>
              Review action <ArrowUpRight size={14} />
            </span>
          </div>
        </div>
      </PreviewWindow>
    </div>
  );
}

export function KnowledgePreview() {
  return (
    <div className={`${styles.previewLandscape} ${styles.knowledgeLandscape}`}>
      <PreviewWindow title="Workspace knowledge">
        <div className={styles.knowledgePreviewBody}>
          <div className={styles.previewQuestion}>
            <Search size={18} />
            <span>What did we decide about the launch?</span>
            <ArrowUpRight size={17} />
          </div>
          <p className={styles.answerLabel}>
            <Bot size={16} /> A connected answer, with sources.
          </p>
          <h3>The launch follows the final design review.</h3>
          <p>
            The team agreed to finish accessibility checks before publishing. The review task is
            assigned, and the decision is recorded in the launch plan.
          </p>
          <div className={styles.sourceCards}>
            <span>
              <Hash size={17} />
              <strong>product-launch</strong>
              <small>Source conversation</small>
            </span>
            <span>
              <FileText size={17} />
              <strong>Launch plan</strong>
              <small>Knowledge · version 3</small>
            </span>
            <span>
              <Check size={17} />
              <strong>Final review</strong>
              <small>Linked project task</small>
            </span>
          </div>
          <div className={styles.sourceFoot}>
            <Link2 size={14} /> Sources stay inspectable. Access stays scoped.
          </div>
        </div>
      </PreviewWindow>
    </div>
  );
}

export function ProjectSignalPreview() {
  return (
    <div className={styles.signalStack}>
      <Reveal className={styles.signalCard}>
        <div className={styles.signalBadges}>
          <span>
            <i />
            Ready for review
          </span>
          <span>
            <Hash size={13} />
            product-launch
          </span>
        </div>
        <h3>A clear next step for the launch.</h3>
        <p>
          Maya asked for one final pass. Atlas connected the brief, open tasks, and original
          discussion for your review.
        </p>
        <div className={styles.signalSource}>
          <span>MK</span>
          <div>
            Maya Kim<small>Product team · Source conversation</small>
          </div>
        </div>
        <div className={styles.signalLinks}>
          <span>
            <MessageSquare size={15} />
            Linked discussion
          </span>
          <span>
            <ShieldCheck size={15} />
            Proposed task
          </span>
        </div>
      </Reveal>
    </div>
  );
}

export function ConnectedWorkPreview() {
  return (
    <Reveal
      className={styles.connectedLandscape}
      aria-label="Illustrative connected project context"
    >
      <PreviewWindow title="Project context" dark>
        <div className={styles.memoryHeading}>
          <small>PROJECT</small>
          <h3>Website launch</h3>
        </div>
        <div className={styles.memoryRows}>
          {[
            {
              icon: BookOpen,
              title: 'Scope',
              text: 'Design, engineering, and launch',
              label: 'Launch brief',
            },
            {
              icon: MessageSquare,
              title: 'Decisions',
              text: 'Accessibility before release',
              label: 'Source linked',
            },
            {
              icon: Check,
              title: 'Tasks',
              text: 'Review, resolve, and publish',
              label: 'Clear owners',
            },
            {
              icon: Link2,
              title: 'Dependencies',
              text: 'Final review before publishing',
              label: 'Connected',
            },
          ].map(({ icon: Icon, title, text, label }) => (
            <div key={title}>
              <Icon size={20} />
              <span>
                <strong>{title}</strong>
                <small>{text}</small>
              </span>
              <em>{label}</em>
            </div>
          ))}
        </div>
        <p className={styles.memoryFoot}>
          <LockKeyhole size={14} />
          Context stays within workspace permissions.
        </p>
      </PreviewWindow>
      <Reveal sequence className={styles.contextUpdates}>
        <div className={styles.contextQuote}>
          <p>
            <span>MK</span>Maya Kim<small>Source conversation</small>
          </p>
          <blockquote>
            “Can we finish the <mark>accessibility review</mark> before the launch?”
          </blockquote>
        </div>
        <div className={styles.contextConnector}>
          <Bot size={17} />
          Atlas connects the context
        </div>
        <div className={styles.contextImpact}>
          <div>
            <span>Proposed next steps</span>
            <small>Needs your review</small>
          </div>
          <p>
            <Check size={17} />
            <span>
              Update the review task<small>Link the acceptance criteria</small>
            </span>
          </p>
          <p>
            <FileText size={17} />
            <span>
              Keep the decision close<small>Attach the source discussion</small>
            </span>
          </p>
          <span>
            <ShieldCheck size={15} />
            You review. Then the agent acts.
          </span>
        </div>
      </Reveal>
      <span className={styles.previewCaption}>Illustrative product preview</span>
    </Reveal>
  );
}
