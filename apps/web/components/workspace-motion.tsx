'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type UIEvent,
} from 'react';
import {
  LazyMotion,
  MotionConfig,
  domAnimation,
  m,
  useAnimate,
  useMotionValue,
} from 'framer-motion';
import { ArrowUp } from 'lucide-react';
import { Button } from './ui/button';

const Preference = createContext(true);
const readPreference = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const serverPreference = () => true;
function subscribePreference(notify: () => void) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
}

export function WorkspaceMotion({ children }: { children: ReactNode }) {
  const reduced = useSyncExternalStore(subscribePreference, readPreference, serverPreference);
  return (
    <Preference.Provider value={reduced}>
      <LazyMotion features={domAnimation} strict>
        <MotionConfig
          reducedMotion={reduced ? 'always' : 'never'}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
        >
          {children}
        </MotionConfig>
      </LazyMotion>
    </Preference.Provider>
  );
}

export function WorkspaceViewport({ view, children }: { view: string; children: ReactNode }) {
  const reduced = useContext(Preference);
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const generation = useRef(0);
  const entered = useRef('');
  const scrollTarget = useRef<HTMLElement | null>(null);
  const progress = useMotionValue(0);
  const [canReturn, setCanReturn] = useState(false);
  const [returnFocused, setReturnFocused] = useState(false);
  useEffect(() => {
    scrollTarget.current = null;
    progress.set(0);
    setCanReturn(false);
    setReturnFocused(false);
  }, [view, progress]);
  useEffect(() => {
    const element = scope.current;
    if (view === 'chat') {
      entered.current = view;
      return;
    }
    if (!element || reduced || entered.current === view) return;
    entered.current = view;
    const version = ++generation.current;
    const original = { opacity: element.style.opacity, transform: element.style.transform };
    const restore = () => {
      if (generation.current !== version) return;
      element.style.opacity = original.opacity;
      element.style.transform = original.transform;
    };
    element.dataset.sceneEntered = view;
    const playback = animate(
      element,
      { opacity: [0.78, 1], y: [8, 0] },
      { duration: 0.3, ease: [0.22, 1, 0.36, 1] },
    );
    void playback.then(() => {
      playback.cancel();
      restore();
    });
    return () => {
      playback.cancel();
      restore();
    };
  }, [animate, reduced, scope, view]);

  function trackScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.target;
    if (
      view === 'chat' ||
      !(target instanceof HTMLElement) ||
      !target.matches('.page-content, .platform-view, .domain-view, .workspace-document-scroll')
    )
      return;
    scrollTarget.current = target;
    const distance = target.scrollHeight - target.clientHeight;
    progress.set(distance > 0 ? target.scrollTop / distance : 0);
    setCanReturn(target.scrollTop > 360);
  }
  return (
    <div ref={scope} className="content-body" data-view={view} onScrollCapture={trackScroll}>
      {children}
      {view !== 'chat' && (
        <>
          <m.div
            className="workspace-scroll-progress"
            style={{ scaleX: progress }}
            aria-hidden="true"
          />
          <Button
            variant="outline"
            size="icon"
            className="workspace-return-top"
            aria-label="Back to section top"
            hidden={!canReturn && !returnFocused}
            onFocus={() => setReturnFocused(true)}
            onBlur={() => setReturnFocused(false)}
            onClick={() =>
              scrollTarget.current?.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' })
            }
          >
            <ArrowUp size={17} />
          </Button>
        </>
      )}
    </div>
  );
}
