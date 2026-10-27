'use client';

import { useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { ArrowUpRight, Check, ChevronDown, ShieldCheck } from 'lucide-react';
import { MotionLink, Reveal, useLandingReducedMotion } from './landing-motion';
import { publicPlans, publicPricing } from './pricing-config';
import styles from './sections.module.css';

export function PricingSection() {
  const [interval, setInterval] = useState<'annual' | 'monthly'>('annual');
  const reduced = useLandingReducedMotion();
  const annual = interval === 'annual';
  return (
    <section className={styles.pricingSection} id="pricing" aria-labelledby="pricing-title">
      <span id="workspaces" className={styles.anchorAlias} aria-hidden="true" />
      <Reveal className={styles.pricingHeading}>
        <p className={styles.eyebrow}>
          <span />
          Make room for what’s next
        </p>
        <h2 id="pricing-title">
          Start with your team.
          <br />
          Grow into your next chapter.
        </h2>
        <p>
          Conversations, projects, knowledge, and agents in one shared workspace.
          <br className={styles.desktopBreak} /> Choose the room your team needs to move.
        </p>
      </Reveal>
      <fieldset className={styles.billingSwitch}>
        <legend className={styles.srOnly}>Billing frequency</legend>
        {(['monthly', 'annual'] as const).map((value) => (
          <label key={value} className={interval === value ? styles.billingSelected : ''}>
            <input
              type="radio"
              name="billing-frequency"
              value={value}
              checked={interval === value}
              onChange={() => setInterval(value)}
            />
            {value === 'annual' ? 'Yearly' : 'Monthly'}
            {value === 'annual' && <span>Save {publicPricing.annualSavingsPercent}%</span>}
          </label>
        ))}
      </fieldset>
      <Reveal sequence className={styles.pricingGrid}>
        {publicPlans.map((plan) => (
          <article
            key={plan.id}
            className={`${styles.planCard} ${plan.id === 'team' ? styles.featuredPlan : ''}`}
            aria-labelledby={`plan-${plan.id}`}
          >
            <div className={styles.planName}>
              <h3 id={`plan-${plan.id}`}>{plan.name}</h3>
              {plan.id === 'team' && <span>Built for teams</span>}
            </div>
            <p className={styles.planDescription}>{plan.description}</p>
            <div className={styles.planPrice}>
              {plan.id === 'enterprise' ? (
                <strong className={styles.customPrice}>Custom</strong>
              ) : (
                <>
                  <span className={styles.priceSlot}>
                    <AnimatePresence mode="wait" initial={false}>
                      <m.strong
                        key={plan.id === 'free' ? 'free' : interval}
                        initial={reduced ? false : { opacity: 0, y: 7 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={reduced ? { opacity: 1 } : { opacity: 0, y: -5 }}
                        transition={{ duration: reduced ? 0 : 0.16 }}
                      >
                        $
                        {plan.id === 'free'
                          ? 0
                          : annual
                            ? publicPricing.annualMonthly
                            : publicPricing.monthly}
                      </m.strong>
                    </AnimatePresence>
                  </span>
                  <span>{plan.id === 'free' ? 'to get started' : 'per person / month'}</span>
                </>
              )}
            </div>
            <p className={styles.planCadence}>
              {plan.id === 'free'
                ? 'No credit card required.'
                : plan.id === 'enterprise'
                  ? 'A plan shaped around your organization.'
                  : annual
                    ? `$${publicPricing.annualTotal} per person, billed yearly.`
                    : `$${publicPricing.monthly} per person, billed monthly.`}
            </p>
            <MotionLink
              className={`${styles.planCta} ${plan.id === 'team' ? styles.primaryPlanCta : ''}`}
              href="/sign-up"
            >
              {plan.action}
              <ArrowUpRight size={18} />
            </MotionLink>
            <p className={styles.planSummary}>{plan.summary}</p>
            <ul>
              {plan.features.map((feature) => (
                <li key={feature}>
                  <Check size={16} />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </Reveal>
      <p className={styles.pricingNote}>
        Prices in {publicPricing.currency}, before taxes. Paid seats count people, not agents.
        <br />
        Agent runs, storage, and media follow plan allowances; provider charges may apply
        separately.
      </p>
      <div className={styles.pricingFaq}>
        <div>
          <p className={styles.eyebrow}>
            <span />A few good questions
          </p>
          <h3>
            The details,
            <br />
            without the small print.
          </h3>
        </div>
        <div className={styles.faqList}>
          {[
            [
              'Who counts as a paid seat?',
              'An active human member counts once across your organization’s workspaces. Agent accounts, service accounts, and guests do not count as paid human seats.',
            ],
            [
              'Are agent runs unlimited?',
              'Each plan has usage allowances for models, tools, runtime, storage, and media. Budgets and usage reporting help you see what is being used. Connected providers and customer-supplied model keys can have separate provider charges.',
            ],
            [
              'How does yearly pricing work?',
              `Team is $${publicPricing.annualMonthly} per person per month when billed yearly, paid as $${publicPricing.annualTotal} per person for the year. Monthly billing is $${publicPricing.monthly} per person per month. All prices are in USD before taxes.`,
            ],
            [
              'Can I begin with Free?',
              'Yes. Start with up to 3 human members, 5 GB of shared storage, and the shared workspace essentials. Agent execution is available within the Free plan’s usage allowances.',
            ],
          ].map(([question, answer]) => (
            <details key={question}>
              <summary>
                {question}
                <ChevronDown size={18} />
              </summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </div>
      <div className={styles.pricingTrust}>
        <ShieldCheck size={17} />
        Your people, your context, and your agent permissions stay under your control.
      </div>
    </section>
  );
}
