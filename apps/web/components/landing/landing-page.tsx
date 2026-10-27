import {
  ArrowUpRight,
  BookOpen,
  Bot,
  CalendarDays,
  Check,
  CheckSquare,
  GitBranch,
  Github,
  Layers3,
  Link2,
  LockKeyhole,
  MessageSquare,
  Orbit,
  Search,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import { LandingHeader, HeroLandscape, FeatureShowcase } from './landing-client';
import {
  AgentPreview,
  ConnectedWorkPreview,
  ProjectSignalPreview,
  ConversationPreview,
  KnowledgePreview,
} from './product-previews';
import styles from './landing.module.css';
import sections from './sections.module.css';
import { IntegrationShowcase } from './integration-showcase';
import { PricingSection } from './pricing-section';
import { LandingMotion, MotionLink, Reveal, RevealSection } from './landing-motion';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className={styles.eyebrow}>
      <span aria-hidden="true" />
      {children}
    </p>
  );
}
function Cta({
  children = 'Get started',
  href = '/sign-up',
  secondary = false,
}: {
  children?: React.ReactNode;
  href?: string;
  secondary?: boolean;
}) {
  return (
    <MotionLink className={`${styles.cta} ${secondary ? styles.secondaryCta : ''}`} href={href}>
      {children}
      {!secondary && (
        <span>
          <ArrowUpRight size={17} />
        </span>
      )}
    </MotionLink>
  );
}

const context = [
  {
    icon: MessageSquare,
    title: 'Conversations',
    description:
      'Channels, direct messages, and threads that turn discussion into shared direction.',
  },
  {
    icon: CheckSquare,
    title: 'Tasks',
    description: 'Clear owners, subtasks, dependencies, and a shared definition of done.',
  },
  {
    icon: Layers3,
    title: 'Projects',
    description: 'Connect tasks to milestones, timelines, and the bigger picture behind the work.',
  },
  {
    icon: BookOpen,
    title: 'Knowledge',
    description: 'Capture decisions in living pages, with version history your team can return to.',
  },
  {
    icon: Bot,
    title: 'Agents',
    description: 'Delegate with clear instructions, scoped tools, and a visible trail of actions.',
  },
  {
    icon: Search,
    title: 'Memory',
    description: 'Find relevant context, inspect its sources, and keep access boundaries intact.',
  },
];
const workflow = [
  [
    'Gather',
    'Bring your people, conversations, projects, and approved sources into one workspace.',
  ],
  ['Connect', 'Link discussions to tasks and knowledge so the reason behind the work stays close.'],
  [
    'Delegate',
    'Give an agent a clear goal, the right context, and permission to use specific tools.',
  ],
  ['Review', 'Follow progress, inspect sources, and approve important actions before they run.'],
];
const connectors = [
  {
    name: 'GitHub',
    mark: <Github size={24} />,
    color: 'github',
    description: 'Repositories and engineering work',
  },
  {
    name: 'Linear',
    mark: <span className={styles.linearMark} />,
    color: 'linear',
    description: 'Issues and project context',
  },
  {
    name: 'Notion',
    mark: <strong>N</strong>,
    color: 'notion',
    description: 'Pages and shared knowledge',
  },
  {
    name: 'Google Drive',
    mark: <span className={styles.driveMark} />,
    color: 'drive',
    description: 'Files and connected documents',
  },
  {
    name: 'GitLab',
    mark: <GitBranch size={24} />,
    color: 'gitlab',
    description: 'Code, issues, and merge requests',
  },
  {
    name: 'Jira',
    mark: <Layers3 size={24} />,
    color: 'jira',
    description: 'Tickets and delivery context',
  },
  {
    name: 'Microsoft 365',
    mark: (
      <span className={styles.microsoftMark}>
        <i />
        <i />
        <i />
        <i />
      </span>
    ),
    color: 'microsoft',
    description: 'Your organization’s documents',
  },
  {
    name: 'Sentry',
    mark: <Workflow size={24} />,
    color: 'sentry',
    description: 'Errors and technical context',
  },
];

export function LandingPage() {
  return (
    <LandingMotion>
      <div className={styles.page}>
        <a className={styles.skipLink} href="#landing-main">
          Skip to content
        </a>
        <LandingHeader />
        <main id="landing-main">
          <section className={styles.hero} aria-labelledby="hero-title">
            <HeroLandscape />
            <Reveal sequence className={styles.heroContent}>
              <Label>A Shared Workspace For People & AI Agents</Label>
              <h1 id="hero-title">
                AI that connects your team
                <br className={styles.desktopBreak} /> to the work that matters
              </h1>
              <p className={styles.heroDescription}>
                One workspace for conversations, projects, knowledge, and AI agents. Turn shared
                context into clear next steps, with your team in control.
              </p>
              <div className={styles.heroActions}>
                <Cta />
                <Cta href="#how-to" secondary>
                  See how it works
                </Cta>
              </div>
            </Reveal>
            <Reveal className={styles.heroProof}>
              <p>From the first conversation to the next clear step.</p>
              <div>
                <span>
                  <MessageSquare />
                  Conversations
                </span>
                <span>
                  <Layers3 />
                  Projects
                </span>
                <span>
                  <BookOpen />
                  Knowledge
                </span>
                <span>
                  <Bot />
                  Agents
                </span>
              </div>
            </Reveal>
          </section>

          <div className={styles.audienceStrip}>
            <span>Built for people who build together</span>
            <div>
              {[
                'Engineering teams',
                'Product & design',
                'Creative studios',
                'Operations',
                'Distributed teams',
              ].map((name) => (
                <span key={name}>
                  <i />
                  {name}
                </span>
              ))}
            </div>
          </div>

          <section className={`${styles.section} ${styles.problem}`} id="product">
            <Reveal className={styles.problemHeading}>
              <Label>Good Work Needs Shared Context</Label>
              <h2>
                The work starts in conversation.
                <br />
                Keep the context with it.
              </h2>
            </Reveal>
            <Reveal className={styles.problemColumns}>
              <p className={styles.problemIntro}>Work changes with every conversation.</p>
              <div className={styles.problemList}>
                {[
                  'A decision gets buried in a thread.',
                  'A task loses the conversation behind it.',
                  'An update never reaches the right teammate.',
                  'An agent starts without the context it needs.',
                ].map((text) => (
                  <p key={text}>
                    {text}
                    <ArrowUpRight size={17} />
                  </p>
                ))}
              </div>
              <div className={styles.problemStatement}>
                <p>The information is there.</p>
                <h3>Bring it into orbit.</h3>
                <p>
                  Connect the discussion, the decision, and the next step. Give people and agents
                  the context to move together.
                </p>
              </div>
            </Reveal>
            <Reveal className={styles.signalLandscape}>
              <ProjectSignalPreview />
              <span className={styles.previewCaption}>Illustrative product preview</span>
            </Reveal>
          </section>

          <div className={styles.hatch} aria-hidden="true" />
          <section
            className={`${styles.section} ${styles.connectedSection}`}
            id="connected-context"
          >
            <Reveal className={styles.connectedHeading}>
              <Label>Context That Moves With The Work</Label>
              <h2>
                Everything your team discussed.
                <br />
                Connected to what happens next.
              </h2>
              <p>
                A message becomes a decision. A decision shapes the next task. Orbit keeps the
                conversation, the knowledge, and the work connected, with your review before an
                agent takes an important action.
              </p>
            </Reveal>
            <ConnectedWorkPreview />
          </section>
          <div className={styles.hatch} aria-hidden="true" />
          <section className={styles.section}>
            <Reveal className={styles.splitHeading}>
              <div>
                <Label>Meet Your Shared Workspace</Label>
                <h2>
                  Your team’s work.
                  <br />
                  Connected, not scattered.
                </h2>
              </div>
              <p>
                Turn a conversation into a task and a decision into shared knowledge. Bring an agent
                into the work with the context it needs, connected to where it all started.
              </p>
            </Reveal>
            <Reveal sequence className={styles.contextGrid}>
              {context.map(({ icon: Icon, title, description }) => (
                <article key={title}>
                  <Icon size={24} strokeWidth={1.5} />
                  <h3>{title}</h3>
                  <p>{description}</p>
                  <span>
                    <Check size={14} />
                    Part of your workspace
                  </span>
                </article>
              ))}
            </Reveal>
          </section>

          <RevealSection
            className={`${styles.section} ${styles.workflow} ${sections.workflowSection}`}
            id="how-to"
          >
            <Label>How It Works</Label>
            <h2>
              Bring the context.
              <br />
              Keep the work moving.
            </h2>
            <div className={styles.workflowGrid}>
              {workflow.map(([title, description], index) => (
                <article key={title}>
                  <span>0{index + 1}</span>
                  <h3>{title}</h3>
                  <p>{description}</p>
                </article>
              ))}
            </div>
          </RevealSection>

          <section className={sections.featureSection} id="features">
            <div className={sections.featureContainer}>
              <Reveal className={sections.featureIntro}>
                <Label>Features</Label>
                <h2>
                  One place for the work.
                  <br />
                  And everything behind it.
                </h2>
                <p>
                  The conversation, the next step, and the thinking that connects them. Give people
                  and agents a shared place to move work forward.
                </p>
              </Reveal>
              <FeatureShowcase>
                {[
                  <Reveal key="conversations">
                    <div className={sections.featureDescription}>
                      <div>
                        <span className={sections.storyIndex}>01 / Conversations</span>
                        <h3>
                          Keep the conversation.
                          <br />
                          And what comes from it.
                        </h3>
                      </div>
                      <div>
                        <p>
                          Discuss ideas, share files, and bring agents into the thread. Turn a
                          useful conversation into a clear next step, with the original thinking
                          still attached.
                        </p>
                        <ul>
                          <li>
                            <Check size={15} />
                            Channels, threads, and direct messages
                          </li>
                          <li>
                            <Check size={15} />
                            Files and decisions in context
                          </li>
                        </ul>
                      </div>
                    </div>
                    <ConversationPreview />
                  </Reveal>,
                  <Reveal key="agents">
                    <div className={sections.featureDescription}>
                      <div>
                        <span className={sections.storyIndex}>02 / Agents</span>
                        <h3>
                          Delegate the work.
                          <br />
                          Keep the direction.
                        </h3>
                      </div>
                      <div>
                        <p>
                          Give an agent a clear assignment and the right permissions. Follow its
                          progress, inspect the sources, and review important actions before they
                          run.
                        </p>
                        <ul>
                          <li>
                            <Check size={15} />
                            Versioned instructions and scoped tools
                          </li>
                          <li>
                            <Check size={15} />
                            Visible progress and human approvals
                          </li>
                        </ul>
                      </div>
                    </div>
                    <AgentPreview />
                  </Reveal>,
                  <Reveal key="knowledge">
                    <div className={sections.featureDescription}>
                      <div>
                        <span className={sections.storyIndex}>03 / Knowledge</span>
                        <h3>
                          Ask your workspace.
                          <br />
                          Follow the source.
                        </h3>
                      </div>
                      <div>
                        <p>
                          Find answers across conversations, tasks, and pages. See the evidence
                          behind an answer and return to the decision that shaped it, within your
                          workspace’s access boundaries.
                        </p>
                        <ul>
                          <li>
                            <Check size={15} />
                            Living pages and version history
                          </li>
                          <li>
                            <Check size={15} />
                            Searchable context and cited answers
                          </li>
                        </ul>
                      </div>
                    </div>
                    <KnowledgePreview />
                  </Reveal>,
                ]}
              </FeatureShowcase>
            </div>
          </section>

          <RevealSection
            className={`${styles.section} ${styles.followThrough} ${sections.tasksSection}`}
          >
            <div>
              <Label>From Conversation To Completion</Label>
              <h2>
                Good ideas deserve
                <br />a clear next step.
              </h2>
              <p>
                Turn a discussion into a task with an owner, a deadline, and a clear definition of
                done. Connect subtasks and dependencies, and keep the original conversation close.
              </p>
              <a className={styles.inlineLink} href="/app">
                Explore your workspace <ArrowUpRight size={17} />
              </a>
            </div>
            <Reveal
              sequence
              className={styles.taskStack}
              aria-label="Illustrative project task preview"
            >
              <div className={styles.taskStackLabel}>
                <Layers3 size={16} />
                Website launch<small>Product preview</small>
              </div>
              {[
                ['Review the launch brief', 'Design review', 'In progress'],
                ['Resolve accessibility checks', 'Engineering', 'In review'],
                ['Publish the final release notes', 'Launch', 'Up next'],
              ].map(([title, label, state], index) => (
                <div className={styles.taskPreviewCard} key={title}>
                  <span className={styles.taskCheck}>
                    {index === 1 ? <Check size={16} /> : <span />}
                  </span>
                  <div>
                    <small>{label}</small>
                    <h3>{title}</h3>
                    <p>
                      <MessageSquare size={12} />
                      Linked discussion{' '}
                      <span>
                        <CalendarDays size={12} />
                        Due date
                      </span>
                    </p>
                  </div>
                  <em>{state}</em>
                </div>
              ))}
            </Reveal>
          </RevealSection>

          <div className={styles.hatch} aria-hidden="true" />
          <section className={sections.integrationsSection} id="integrations">
            <Reveal className={sections.sectionHeading}>
              <div>
                <Label>Works Where Your Team Works</Label>
                <h2>
                  Your tools, connected.
                  <br />
                  Your context, together.
                </h2>
              </div>
              <p>
                Bring approved documents, issues, and code into the conversation. Choose what’s
                connected, who can see it, and what your agents can do.
              </p>
            </Reveal>
            <IntegrationShowcase
              connectors={connectors.map((connector) => ({
                name: connector.name,
                description: connector.description,
                mark: connector.mark,
                accentClassName: styles[connector.color] ?? '',
                category: ['Notion', 'Google Drive', 'Microsoft 365'].includes(connector.name)
                  ? 'Knowledge'
                  : 'Engineering',
              }))}
            />
          </section>

          <RevealSection
            className={`${styles.section} ${styles.principles} ${sections.principlesSection}`}
            id="why-orbit"
          >
            <Label>Built Around Your Team</Label>
            <h2>
              AI that works with your team.
              <br />
              On your terms.
            </h2>
            <Reveal sequence className={styles.principleGrid}>
              <article>
                <Link2 size={25} />
                <h3>You choose what’s connected.</h3>
                <p>
                  Bring in the conversations and sources that matter. Keep ownership and allowed
                  access explicit.
                </p>
              </article>
              <article>
                <ShieldCheck size={25} />
                <h3>You review important actions.</h3>
                <p>
                  Approval policies put a checkpoint between an agent’s proposal and a sensitive
                  operation.
                </p>
              </article>
              <article>
                <LockKeyhole size={25} />
                <h3>Your boundaries stay in place.</h3>
                <p>
                  Workspace permissions and source access shape what people and agents can see and
                  use.
                </p>
              </article>
            </Reveal>
          </RevealSection>

          <PricingSection />

          <RevealSection className={`${styles.finalCta} ${sections.closingSection}`}>
            <Label>Your Next Chapter</Label>
            <h2>
              Less catching up.
              <br />
              More moving work forward.
            </h2>
            <p>Bring your people, your agents, and your next big idea into Orbit.</p>
            <div>
              <Cta />
              <Cta href="/sign-in" secondary>
                Sign in to your workspace
              </Cta>
            </div>
          </RevealSection>
        </main>
        <footer className={styles.footer}>
          <div className={styles.footerTop}>
            <div>
              <a className={styles.brand} href="/" aria-label="Orbit home">
                <span className={styles.brandMark}>
                  <Orbit size={27} />
                </span>
                Orbit
              </a>
              <p>
                A shared workspace
                <br />
                for people and agents.
              </p>
            </div>
            <nav aria-label="Product links">
              <strong>Product</strong>
              <a href="#product">Overview</a>
              <a href="#features">Features</a>
              <a href="#integrations">Integrations</a>
            </nav>
            <nav aria-label="Explore links">
              <strong>Explore</strong>
              <a href="#how-to">How it works</a>
              <a href="#why-orbit">Why Orbit</a>
              <a href="#pricing">Plans & pricing</a>
            </nav>
            <nav aria-label="Account links">
              <strong>Workspace</strong>
              <a href="/sign-up">Get started</a>
              <a href="/sign-in">Sign in</a>
              <a href="/forgot-password">Account recovery</a>
            </nav>
          </div>
          <div className={styles.footerBottom}>
            <span>Orbit · Your team, in sync.</span>
            <span>Built for the way you work next.</span>
          </div>
        </footer>
      </div>
    </LandingMotion>
  );
}
