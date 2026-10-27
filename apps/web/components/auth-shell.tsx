'use client';

import type { ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, Bot, Check, Hash, Orbit } from 'lucide-react';
import { AppearanceControl } from './appearance';
import { LandingMotion, Reveal } from './landing/landing-motion';
import styles from './auth.module.css';

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <LandingMotion>
      <main className={styles.page}>
        <aside className={styles.story} aria-label="Welcome to Orbit">
          <a className={styles.brand} href="/" aria-label="Orbit home">
            <Orbit size={29} strokeWidth={1.8} /> Orbit
          </a>
          <Reveal sequence className={styles.storyContent}>
            <p className={styles.eyebrow}>
              <span /> A shared workspace for people & agents
            </p>
            <h2>
              Great work starts
              <br />
              with shared context.
            </h2>
            <p className={styles.storyDescription}>
              Your conversations, projects, knowledge, and agents. Together, in one orbit.
            </p>
            <div className={styles.preview} aria-hidden="true">
              <div className={styles.previewHeader}>
                <span>
                  <Hash size={17} /> the-next-big-thing
                </span>
                <span className={styles.liveDot} />
              </div>
              <div className={styles.previewMessage}>
                <span className={styles.avatar}>MK</span>
                <div>
                  <strong>
                    Maya <small>Just now</small>
                  </strong>
                  <p>Ready to turn the next big idea into something real?</p>
                </div>
              </div>
              <div className={styles.agentReply}>
                <span className={styles.agentIcon}>
                  <Bot size={18} />
                </span>
                <div>
                  <strong>
                    Atlas <span>AGENT</span>
                  </strong>
                  <p>The context is connected. Let’s find the next step.</p>
                </div>
              </div>
              <div className={styles.previewTask}>
                <span>
                  <Check size={14} />
                </span>{' '}
                One idea. A clear way forward.
                <ArrowUpRight size={15} />
              </div>
            </div>
          </Reveal>
          <div className={styles.storyFooter}>
            <span>Less catching up. More moving forward.</span>
            <span>01 / A new chapter</span>
          </div>
        </aside>
        <section className={styles.formPanel} aria-labelledby="auth-title">
          <header className={styles.formHeader}>
            <a href="/" className={styles.backLink}>
              <ArrowLeft size={16} /> Back to home
            </a>
            <a className={styles.mobileBrand} href="/" aria-label="Orbit home">
              <Orbit size={24} /> Orbit
            </a>
            <AppearanceControl className={styles.appearance ?? ''} />
          </header>
          <div className={styles.formCenter}>{children}</div>
          <footer className={styles.formFooter}>
            <Orbit size={14} /> Your team. Your context. Your next chapter.
          </footer>
        </section>
      </main>
    </LandingMotion>
  );
}
