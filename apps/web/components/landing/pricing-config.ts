const monthly = 20,
  annualMonthly = 16;
export const publicPricing = {
  currency: 'USD',
  monthly,
  annualMonthly,
  annualTotal: annualMonthly * 12,
  annualSavingsPercent: Math.round((1 - annualMonthly / monthly) * 100),
} as const;

export const publicPlans = [
  {
    id: 'free',
    name: 'Free',
    description: 'Find your team’s shared rhythm.',
    summary: 'For a small team with a big idea.',
    action: 'Start for free',
    features: [
      'Up to 3 human members',
      'Channels, threads, and direct messages',
      'Tasks, projects, and knowledge pages',
      '5 GB of shared storage',
      'Agent execution with usage allowances',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    description: 'More people. More possibilities.',
    summary: 'For teams building momentum together.',
    action: 'Get started with Team',
    features: [
      'Everything in Free',
      'More agent and automation capacity',
      '500 GB of shared storage',
      'File data-loss prevention controls',
      'Usage budgets, forecasts, and warnings',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'Your organization. On your terms.',
    summary: 'For work that needs more control.',
    action: 'Explore Enterprise',
    features: [
      'Everything in Team',
      'SAML SSO and SCIM provisioning',
      'Organization and workspace policies',
      'Audit exports and retention controls',
      'Expanded usage allowances',
    ],
  },
] as const;
