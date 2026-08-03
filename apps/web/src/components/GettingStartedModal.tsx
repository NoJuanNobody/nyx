import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from './Modal';
import { getOnboardingProgress, markOnboardingStep } from '../lib/api';

interface GettingStartedModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const STEPS = [
  {
    key: 'repo-connected',
    title: '1. Connect your repository',
    description: 'Link your GitHub repositories so Nyx can detect code changes and keep your documentation in sync.',
    link: { to: '/app/repositories', label: 'Go to Repositories' },
  },
  {
    key: 'first-doc-created',
    title: '2. Create your first spec',
    description: 'Use the dashboard to create a new document. The AI-assisted editor helps you write structured specs quickly.',
    link: { to: '/app/dashboard', label: 'Go to Dashboard' },
  },
  {
    key: 'board-visited',
    title: '3. Explore the product lifecycle',
    description: 'Understand how Nyx guides ideas through five phases: Ideation, Specification, Implementation, Review, and Maintenance.',
    link: { to: '/app/board', label: 'View Lifecycle' },
  },
  {
    key: 'first-ticket-generated',
    title: '4. Generate tickets from specs',
    description: 'Once your spec is ready, Nyx can generate GitHub Issues or Jira tickets directly from your documentation.',
    link: { to: '/app/board', label: 'View Board' },
  },
  {
    key: 'observability-visited',
    title: '5. Monitor drift',
    description: 'As your codebase evolves, Nyx detects when documentation falls out of sync and suggests updates.',
    link: { to: '/app/observability', label: 'View Observability' },
  },
];

export function GettingStartedModal({ isOpen, onClose }: GettingStartedModalProps) {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['onboarding-progress'],
    queryFn: getOnboardingProgress,
    enabled: isOpen,
  });

  const completedSteps = new Set(data?.completedSteps ?? []);
  const completedCount = completedSteps.size;
  const allDone = completedCount === STEPS.length;

  const markMutation = useMutation({
    mutationFn: markOnboardingStep,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['onboarding-progress'] });
    },
  });

  // Auto-close once all steps done on subsequent opens (but not the first time they just completed)
  useEffect(() => {
    if (isOpen && allDone) {
      // Don't auto-close immediately - let the user see the completed state
    }
  }, [isOpen, allDone]);

  // suppress unused variable warning
  void markMutation;

  return (
    <Modal open={isOpen} onClose={onClose} title="Getting Started">
      <div className="space-y-4">
        {/* Progress bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-sm text-slate-500">
            <span>{completedCount}/5 steps complete</span>
            {allDone && <span className="text-green-600 font-medium">All done!</span>}
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-100">
            <div
              className="h-1.5 rounded-full bg-gradient-to-r from-blue-500 to-violet-500 transition-all"
              style={{ width: `${(completedCount / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        {/* Steps */}
        <div className="space-y-2">
          {STEPS.map((step, i) => {
            const done = completedSteps.has(step.key);
            return (
              <div
                key={step.key}
                data-testid={`tutorial-step-${i}`}
                className={`rounded-lg border p-3 transition-colors ${done ? 'border-green-200 bg-green-50/50' : 'border-slate-200 bg-white'}`}
              >
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 ${done ? 'border-green-500 bg-green-500' : 'border-slate-300'}`}>
                    {done && (
                      <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${done ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
                      {step.title}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">{step.description}</p>
                    {!done && step.link && (
                      <Link
                        to={step.link.to}
                        onClick={onClose}
                        className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
                      >
                        {step.link.label}
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                        </svg>
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
