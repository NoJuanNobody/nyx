/**
 * Credit cost configuration for agentic tasks.
 * Each entry maps a task type identifier to the number of credits consumed.
 */
export const CREDIT_COSTS = {
  spec_analysis: 1,
  document_generation: 3,
  drift_detection: 2,
  ticket_generation: 2,
  voice_agent_per_minute: 5,
  onboarding_scan: 5,
  bulk_ticket_review: 3,
  context_matching: 1,
  intake_processing: 2,
  agent_workflow: 4,
} as const;

export type CreditTaskType = keyof typeof CREDIT_COSTS;

/**
 * Credit pack definitions available for purchase.
 * priceId maps to Stripe price IDs via environment variables.
 */
export const CREDIT_PACKS = [
  {
    id: 'credits_100',
    label: '100 Credits',
    credits: 100,
    priceCents: 1000,
    priceLabel: '$10',
    stripePriceId: process.env.STRIPE_PRICE_CREDITS_100 || 'price_credits_100_placeholder',
    popular: false,
  },
  {
    id: 'credits_500',
    label: '500 Credits',
    credits: 500,
    priceCents: 4000,
    priceLabel: '$40',
    stripePriceId: process.env.STRIPE_PRICE_CREDITS_500 || 'price_credits_500_placeholder',
    popular: true,
  },
  {
    id: 'credits_1000',
    label: '1,000 Credits',
    credits: 1000,
    priceCents: 7000,
    priceLabel: '$70',
    stripePriceId: process.env.STRIPE_PRICE_CREDITS_1000 || 'price_credits_1000_placeholder',
    popular: false,
  },
] as const;

export type CreditPackId = (typeof CREDIT_PACKS)[number]['id'];
