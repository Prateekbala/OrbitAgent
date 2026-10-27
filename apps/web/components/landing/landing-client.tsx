'use client';
import { Button } from '../ui/button';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Menu, Orbit, Pause, Play, X } from 'lucide-react';
import { AnimatePresence, m, useScroll, useTransform } from 'framer-motion';
import { useLandingReducedMotion } from './landing-motion';
import styles from './landing.module.css';
import sections from './sections.module.css';

const navigation = [
  ['Product', '#product'],
  ['Features', '#features'],
  ['Integrations', '#integrations'],
  ['Pricing', '#pricing'],
] as const;

export function LandingHeader() {
  const [open, setOpen] = useState(false);
  const reduced = useLandingReducedMotion();
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  return (
    <header className={styles.header}>
      <a className={styles.brand} href="/" aria-label="Orbit home">
        <span className={styles.brandMark}>
          <Orbit size={27} />
        </span>
        Orbit
      </a>
      <nav className={styles.desktopNav} aria-label="Main navigation">
        {navigation.map(([label, href]) => (
          <a key={href} href={href}>
            {label}
          </a>
        ))}
      </nav>
      <div className={styles.headerActions}>
        <a className={styles.headerSignIn} href="/sign-in">
          Sign in
        </a>
        <a className={styles.headerCta} href="/sign-up">
          Get started
          <span>
            <ArrowUpRight size={16} />
          </span>
        </a>
      </div>
      <Button
        variant="ghost"
        ref={toggle}
        className={styles.menuToggle}
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="landing-navigation"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X size={23} /> : <Menu size={23} />}
      </Button>
      <AnimatePresence initial={false}>
        {open && (
          <m.nav
            className={styles.mobileNav}
            id="landing-navigation"
            aria-label="Mobile navigation"
            initial={reduced === false ? { opacity: 0, y: -6 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced === false ? { opacity: 0, y: -4 } : { opacity: 0 }}
            transition={{ duration: reduced === false ? 0.18 : 0 }}
          >
            {navigation.map(([label, href]) => (
              <a key={href} href={href} onClick={() => setOpen(false)}>
                {label}
                <ArrowUpRight size={16} />
              </a>
            ))}
            <a href="/sign-in">
              Sign in
              <ArrowUpRight size={16} />
            </a>
          </m.nav>
        )}
      </AnimatePresence>
    </header>
  );
}

export function HeroLandscape() {
  const ref = useRef<HTMLVideoElement>(null);
  const reduced = useLandingReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], [0, 32]);
  const scale = useTransform(scrollYProgress, [0, 1], [1, 1.04]);
  const [paused, setPaused] = useState(false);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } })
      .connection;
    let visible = false;
    const update = () => {
      const allowed = !motion.matches && !connection?.saveData;
      setAvailable(allowed);
      if (!allowed || paused || document.hidden || !visible) {
        video.pause();
        return;
      }
      if (!video.getAttribute('src')) video.src = '/landing/landscape.mp4';
      void video.play().catch(() => {});
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      update();
    });
    observer.observe(video);
    motion.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
      video.pause();
    };
  }, [paused]);
  return (
    <>
      <m.video
        ref={ref}
        className={styles.heroVideo}
        poster="/landing/landscape.png"
        muted
        loop
        playsInline
        preload="none"
        aria-hidden="true"
        tabIndex={-1}
        style={{ y: reduced || paused ? 0 : y, scale: reduced || paused ? 1 : scale }}
      />
      {available && (
        <Button
          variant="ghost"
          type="button"
          className={styles.motionToggle}
          aria-label={paused ? 'Play background animation' : 'Pause background animation'}
          onClick={() => setPaused(!paused)}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </Button>
      )}
    </>
  );
}

const features = [
  { id: 'feature-conversations', label: 'Shared conversations' },
  { id: 'feature-agents', label: 'Agent execution' },
  { id: 'feature-knowledge', label: 'Inspectable knowledge' },
] as const;

export function FeatureShowcase({ children }: { children: ReactNode[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string>(features[0].id);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-18% 0px -48% 0px' },
    );
    root.querySelectorAll('section').forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);
  return (
    <div className={sections.featureShowcase} ref={ref}>
      <nav className={sections.featureNavigation} aria-label="Explore Orbit features">
        {features.map(({ id, label }, index) => (
          <a
            key={id}
            href={`#${id}`}
            aria-current={active === id ? 'location' : undefined}
            onClick={() => setActive(id)}
          >
            <span>1.{index}</span>
            {label}
          </a>
        ))}
      </nav>
      {features.map(({ id, label }, index) => (
        <section className={sections.featureStory} key={id} id={id} aria-label={label}>
          {children[index]}
        </section>
      ))}
    </div>
  );
}
