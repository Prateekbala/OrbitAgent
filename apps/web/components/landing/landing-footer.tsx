import Image from 'next/image';
import { ArrowUpRight } from 'lucide-react';
import { MotionLink, ParallaxArtwork, Reveal } from './landing-motion';
import styles from './landing.module.css';

const navigation = [
  {
    title: 'Explore',
    links: [
      ['Home', '/'],
      ['Why Orbit', '#why-orbit'],
      ['Pricing', '#pricing'],
    ],
  },
  {
    title: 'Product',
    links: [
      ['Messaging', '#feature-conversations'],
      ['AI agents', '#feature-agents'],
      ['Knowledge', '#feature-knowledge'],
      ['Integrations', '#integrations'],
    ],
  },
  {
    title: 'Workspace',
    links: [
      ['Get started', '/sign-up'],
      ['Sign in', '/sign-in'],
      ['Reset password', '/forgot-password'],
    ],
  },
] as const;

export function LandingFooter() {
  return (
    <>
      <div className={styles.hatch} aria-hidden="true" />
      <footer className={styles.footer} aria-labelledby="footer-title">
        <ParallaxArtwork
          className={styles.footerLandscape}
          artworkClassName={styles.footerImageLayer}
        >
          <Image
            src="/landing/footer-landscape.webp"
            alt=""
            fill
            unoptimized
            className={styles.footerArtwork}
          />
        </ParallaxArtwork>
        <div className={styles.footerInner}>
          <Reveal sequence className={styles.footerTop}>
            <div className={styles.footerIntro}>
              <h2 id="footer-title">
                Less catching up.
                <br />
                More moving forward.
              </h2>
              <MotionLink className={styles.footerCta} href="/sign-up">
                Get started with Orbit
                <ArrowUpRight size={19} aria-hidden="true" />
              </MotionLink>
            </div>
            <nav className={styles.footerLinks} aria-label="Footer navigation">
              {navigation.map(({ title, links }) => (
                <div key={title}>
                  <h3>{title}</h3>
                  <ul>
                    {links.map(([label, href]) => (
                      <li key={href}>
                        <a href={href}>{label}</a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          </Reveal>
        </div>
      </footer>
    </>
  );
}
