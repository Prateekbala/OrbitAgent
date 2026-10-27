'use client';

import {
  LazyMotion,
  MotionConfig,
  domAnimation,
  m,
  stagger,
  useAnimate,
  useInView,
} from 'framer-motion';
import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';

const ease = [0.22, 1, 0.36, 1] as const;
const MotionPreference = createContext(true);
const serverMotionPreference = () => true;
const motionPreference = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function subscribeMotionPreference(notify: () => void) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
}

export function useLandingReducedMotion() {
  return useContext(MotionPreference);
}

export function LandingMotion({ children }: { children: ReactNode }) {
  const reduced = useSyncExternalStore(
    subscribeMotionPreference,
    motionPreference,
    serverMotionPreference,
  );
  return (
    <MotionPreference.Provider value={reduced}>
      <LazyMotion features={domAnimation} strict>
        <MotionConfig
          reducedMotion={reduced ? 'always' : 'never'}
          transition={{ duration: 0.4, ease }}
        >
          {children}
        </MotionConfig>
      </LazyMotion>
    </MotionPreference.Provider>
  );
}

function useEntrance<T extends HTMLElement>(sequence: boolean, delay: number) {
  const [scope, animate] = useAnimate<T>();
  const visible = useInView(scope, { once: true, amount: 0.1 });
  const reduced = useLandingReducedMotion();

  useEffect(() => {
    const element = scope.current;
    if (!element) return;
    if (reduced) return;
    if (!visible || element.dataset.motionEntered === 'true') return;
    const targets = sequence
      ? Array.from(element.children).filter(
          (child): child is HTMLElement => child instanceof HTMLElement,
        )
      : [element];
    const previous = targets.map((target) => ({
      target,
      opacity: target.style.opacity,
      translate: target.style.translate,
    }));
    const restore = () =>
      previous.forEach(({ target, opacity, translate }) => {
        target.style.opacity = opacity;
        target.style.translate = translate;
      });
    element.dataset.motionEntered = 'true';
    const playback = animate(
      targets,
      { opacity: [0.65, 1], translate: ['0px 14px', '0px 0px'] },
      { duration: 0.65, ease, delay: sequence ? stagger(0.075, { startDelay: delay }) : delay },
    );
    void playback.then(restore);
    return () => {
      playback.stop();
      restore();
    };
  }, [animate, delay, reduced, scope, sequence, visible]);

  return scope;
}

type EntranceOptions = { sequence?: boolean; delay?: number };

export function Reveal({
  children,
  sequence = false,
  delay = 0,
  ...props
}: ComponentPropsWithoutRef<'div'> & EntranceOptions) {
  const ref = useEntrance<HTMLDivElement>(sequence, delay);
  return (
    <div {...props} ref={ref}>
      {children}
    </div>
  );
}

export function RevealSection({
  children,
  sequence = false,
  delay = 0,
  ...props
}: ComponentPropsWithoutRef<'section'> & EntranceOptions) {
  const ref = useEntrance<HTMLElement>(sequence, delay);
  return (
    <section {...props} ref={ref}>
      {children}
    </section>
  );
}

export function MotionLink({
  children,
  ...props
}: {
  children: ReactNode;
  href: string;
  className: string;
}) {
  const reduced = useLandingReducedMotion();
  return (
    <m.a
      {...props}
      whileHover={reduced === false ? { y: -2 } : {}}
      whileTap={reduced === false ? { scale: 0.98 } : {}}
    >
      {children}
    </m.a>
  );
}
