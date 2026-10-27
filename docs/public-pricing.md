# Public pricing

The landing page presents Free, Team, and Enterprise plans. Team is USD $20 per human member per month, or $16 per month billed annually ($192 per year, a 20% saving). Enterprise uses custom pricing. Prices exclude taxes.

## Benchmark and rationale

Reviewed official public pricing on October 27, 2026:

- [Slack](https://slack.com/intl/en-us/help/articles/39264531104275-Updates-to-feature-availability-and-pricing-for-Slack-plans): Business+ lists $18 per user monthly or $15 per month billed annually.
- [Linear](https://linear.app/pricing): Business lists $16 per user per month billed yearly.
- [Notion](https://www.notion.com/pricing): Business displays $20 per member per month, with a yearly billing option.

The Team offer sits near comparable collaboration products. These comparisons establish a public positioning decision; they do not establish model-cost margins or unlimited agent usage.

## Plan alignment

Public feature copy follows migration `070_commercial_controls.sql`: Free includes three human members and 5 GiB of storage; Team includes 500 GiB and DLP; Enterprise adds SSO, SCIM, and organization governance capabilities. Active human members count once across an organization's workspaces. Guests, service accounts, and agents do not count as paid human seats.

Model, tool, runtime, storage, and media usage remains subject to plan allowances. External providers may charge separately. The page does not promise unlimited execution or independently validated live-provider coverage.

## Payment configuration

`apps/web/components/landing/pricing-config.ts` owns the displayed offer. The billing selector changes presentation only, and plan links enter the dedicated `/sign-up` flow. This change does not create Stripe prices, select a subscription, configure annual checkout, or modify existing subscriptions.

Before enabling paid checkout, configure and independently validate provider prices for both intervals, bind the selected plan and interval to checkout, verify webhook entitlements and proration, and qualify the usage economics. Live payments remain pending.
