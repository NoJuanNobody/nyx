import { useNavigate } from 'react-router-dom';
import type { PlanLimitDetails } from '../lib/api';

interface UpgradeModalProps {
  details: PlanLimitDetails;
  onClose: () => void;
}

const FEATURE_LABELS: Record<string, string> = {
  documents: 'Documents',
  teamMembers: 'Team Members',
  ai: 'AI Features',
  voice: 'Voice Agent',
};

const PLAN_BENEFITS: Record<string, string[]> = {
  pro: [
    'Unlimited documents',
    'Up to 5 team members',
    'Advanced AI analysis',
    'All integrations',
    'Version history & PDF export',
  ],
  team: [
    'Everything in Pro',
    'Unlimited team members',
    'Voice agent (meeting intelligence)',
    'Priority AI processing',
    'Audit trail & SSO support',
  ],
};

export function UpgradeModal({ details, onClose }: UpgradeModalProps) {
  const navigate = useNavigate();
  const featureLabel = FEATURE_LABELS[details.feature ?? ''] ?? details.feature ?? 'this feature';
  const limitDisplay = details.limit === -1 ? 'unlimited' : String(details.limit);
  const currentPlan = details.plan ?? 'free';
  const suggestedPlan = currentPlan === 'free' ? 'pro' : 'team';
  const benefits = PLAN_BENEFITS[suggestedPlan] ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="rounded-t-xl bg-gradient-to-r from-blue-500 to-violet-500 px-6 py-5 text-white">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold">Plan Limit Reached</h2>
              <p className="mt-1 text-sm text-blue-100">
                You've used {details.current} of {limitDisplay} {featureLabel.toLowerCase()} on
                the <span className="font-medium capitalize">{currentPlan}</span> plan.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="ml-4 rounded-md p-1 text-white/70 hover:text-white transition-colors"
              aria-label="Close"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          <p className="text-sm font-medium text-slate-700">
            Upgrade to <span className="capitalize font-semibold text-violet-600">{suggestedPlan}</span> to get:
          </p>
          <ul className="mt-3 space-y-2">
            {benefits.map((benefit) => (
              <li key={benefit} className="flex items-center gap-2 text-sm text-slate-600">
                <svg className="h-4 w-4 flex-shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                {benefit}
              </li>
            ))}
          </ul>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 border-t border-slate-100 px-6 py-4">
          <button
            type="button"
            onClick={() => {
              onClose();
              navigate('/settings?tab=billing');
            }}
            className="flex-1 rounded-lg bg-gradient-to-r from-blue-500 to-violet-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:from-blue-600 hover:to-violet-600 transition-all"
          >
            Upgrade Plan
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            Maybe Later
          </button>
        </div>
      </div>
    </div>
  );
}
