'use client';

import { useState, type ReactNode } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { ArrowUpRight, Link2, Orbit, Search, ShieldCheck } from 'lucide-react';
import { Reveal, useLandingReducedMotion } from './landing-motion';
import styles from './sections.module.css';

export interface LandingConnector {
  name: string;
  description: string;
  category: 'Engineering' | 'Knowledge';
  mark: ReactNode;
  accentClassName: string;
}
const categories = ['All tools', 'Engineering', 'Knowledge'] as const;

export function IntegrationShowcase({ connectors }: { connectors: LandingConnector[] }) {
  const [category, setCategory] = useState<(typeof categories)[number]>('All tools');
  const [query, setQuery] = useState('');
  const reduced = useLandingReducedMotion();
  const search = query.trim().toLocaleLowerCase();
  const filtered = connectors.filter(
    (connector) =>
      (category === 'All tools' || connector.category === category) &&
      `${connector.name} ${connector.description}`.toLocaleLowerCase().includes(search),
  );

  return (
    <div className={styles.integrationLayout}>
      <Reveal sequence className={styles.connectionScene} aria-hidden="true">
        {connectors.map((connector) => (
          <span key={connector.name} className={`${styles.sceneTile} ${connector.accentClassName}`}>
            {connector.mark}
          </span>
        ))}
        <div className={styles.sceneCenter}>
          <Orbit size={35} />
          <strong>Shared context</strong>
          <span>One connected workspace.</span>
        </div>
        <p>Bring the work into Orbit.</p>
      </Reveal>
      <div className={styles.catalog}>
        <div className={styles.catalogIntro}>
          <div>
            <span className={styles.miniLabel}>Your connection catalog</span>
            <h3>
              Good tools.
              <br />
              Even better together.
            </h3>
          </div>
          <Link2 size={25} strokeWidth={1.5} />
        </div>
        <label className={styles.catalogSearch}>
          <Search size={17} />
          <span className={styles.srOnly}>Find a connection</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a connection…"
          />
        </label>
        <div className={styles.catalogFilters} role="group" aria-label="Connection categories">
          {categories.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={category === item}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <p className={styles.catalogStatus} role="status">
          {filtered.length} {filtered.length === 1 ? 'connection' : 'connections'} to explore
        </p>
        <div className={styles.catalogResults}>
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              key={`${category}:${search}`}
              className={styles.catalogGrid}
              initial={reduced ? false : { opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 1 } : { opacity: 0 }}
              transition={{ duration: reduced ? 0 : 0.14 }}
            >
              {filtered.map((connector) => (
                <a
                  className={styles.connectionCard}
                  href="/app"
                  key={connector.name}
                  aria-label={`Explore ${connector.name} connection`}
                >
                  <span className={`${styles.connectionIcon} ${connector.accentClassName}`}>
                    {connector.mark}
                  </span>
                  <ArrowUpRight size={15} />
                  <strong>{connector.name}</strong>
                  <span>{connector.description}</span>
                </a>
              ))}
              {!filtered.length && (
                <div className={styles.emptyConnections}>
                  <Search size={23} />
                  <strong>No matching connections.</strong>
                  <p>Try a different tool name or category.</p>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      setCategory('All tools');
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              )}
            </m.div>
          </AnimatePresence>
        </div>
        <p className={styles.connectionConsent}>
          <ShieldCheck size={16} />
          Your provider account. Your chosen permissions.
        </p>
        <a className={styles.textLink} href="/app">
          Open your connection catalog
          <ArrowUpRight size={17} />
        </a>
      </div>
    </div>
  );
}
