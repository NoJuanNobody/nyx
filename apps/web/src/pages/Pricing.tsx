import { Link } from 'react-router-dom';

interface Plan {
  id: string;
  name: string;
  price: number | null;
  interval: string | null;
  features: string[];
  popular?: boolean;
}

const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    interval: null,
    features: [
      '1 user, 1 project, 1 repo',
      '5 documents',
      'Manual drift check only',
      '10 AI credits/month',
      'GitHub Issues integration',
    ],
  },
  {
    id: 'starter',
    name: 'Starter',
    price: 24,
    interval: 'month',
    features: [
      '1 user, 3 projects, 2 repos',
      'Unlimited documents',
      'Automated drift detection',
      '100 AI operations/month',
      'GitHub Issues + Jira integrations',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 59,
    interval: 'month',
    popular: true,
    features: [
      'Up to 5 users, 10 projects',
      'Unlimited repos',
      'All integrations',
      '500 AI operations/month',
      'MCP/agent integrations',
      'BYOK available',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    price: 129,
    interval: 'month',
    features: [
      'Up to 25 users',
      'Unlimited projects and repos',
      'BYOK required for AI features',
      'Unlimited AI via BYOK',
      'Priority support',
      'Full version control',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: null,
    interval: null,
    features: [
      'Everything in Team',
      'SSO, SLA, dedicated support',
      'Custom integrations',
      'Self-hosted option',
    ],
  },
];

export function Pricing() {
  return (
    <div className="min-h-screen bg-gray-50 py-16 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">Simple, transparent pricing</h1>
          <p className="text-lg text-gray-600">
            Start free. Upgrade as your team grows.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-6">
          {PLANS.map((plan) => (
            <div
              key={plan.id}
              className={`relative flex flex-col rounded-2xl border bg-white p-6 shadow-sm ${
                plan.popular
                  ? 'border-indigo-500 ring-2 ring-indigo-500'
                  : 'border-gray-200'
              }`}
            >
              {plan.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="rounded-full bg-indigo-500 px-3 py-1 text-xs font-semibold text-white">
                    Most popular
                  </span>
                </div>
              )}

              <div className="mb-6">
                <h2 className="text-lg font-semibold text-gray-900">{plan.name}</h2>
                <div className="mt-2">
                  {plan.price === null ? (
                    <p className="text-2xl font-bold text-gray-900">Custom</p>
                  ) : plan.price === 0 ? (
                    <p className="text-2xl font-bold text-gray-900">Free</p>
                  ) : (
                    <p className="text-2xl font-bold text-gray-900">
                      ${plan.price}
                      <span className="text-sm font-normal text-gray-500">/mo</span>
                    </p>
                  )}
                </div>
              </div>

              <ul className="mb-8 flex-1 space-y-2">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-gray-600">
                    <svg
                      className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>

              <Link
                to={plan.price === null ? '/contact' : '/app/settings?tab=billing'}
                className={`block w-full rounded-lg py-2 text-center text-sm font-semibold transition-colors ${
                  plan.popular
                    ? 'bg-indigo-500 text-white hover:bg-indigo-600'
                    : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                }`}
              >
                {plan.price === null ? 'Contact sales' : plan.price === 0 ? 'Get started free' : 'Get started'}
              </Link>
            </div>
          ))}
        </div>

        <p className="mt-10 text-center text-sm text-gray-500">
          All paid plans include a 14-day free trial. No credit card required to start.
        </p>
      </div>
    </div>
  );
}
