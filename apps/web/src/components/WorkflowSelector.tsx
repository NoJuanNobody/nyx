interface WorkflowOption {
  variant: 'scripted' | 'unscripted';
  label: string;
  description: string;
  stages: string[];
  icon: string;
}

const WORKFLOW_OPTIONS: WorkflowOption[] = [
  {
    variant: 'scripted',
    label: 'Scripted',
    description: 'Full pre-production with script, treatment, and storyboard before filming.',
    stages: ['Script & Treatment', 'Storyboard', 'Production Notes', 'Rough Cut', 'Color & Sound', 'Final Delivery'],
    icon: '📝',
  },
  {
    variant: 'unscripted',
    label: 'Unscripted',
    description: 'Flexible, spontaneous production using talking points and a shot list instead of a script.',
    stages: ['Brief & Concept', 'Shot List / Outline', 'Recording Notes', 'Rough Cut', 'Color & Sound', 'Final Delivery'],
    icon: '🎥',
  },
];

interface WorkflowSelectorProps {
  onSelect: (variant: 'scripted' | 'unscripted') => void;
  selected?: 'scripted' | 'unscripted' | null;
}

export function WorkflowSelector({ onSelect, selected }: WorkflowSelectorProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
        Video Production Workflow
      </p>
      <div className="grid grid-cols-2 gap-3">
        {WORKFLOW_OPTIONS.map((option) => {
          const isSelected = selected === option.variant;
          return (
            <button
              key={option.variant}
              type="button"
              onClick={() => onSelect(option.variant)}
              className={`flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors ${
                isSelected
                  ? 'border-blue-400 bg-blue-50 ring-1 ring-blue-400'
                  : 'border-slate-200 hover:border-blue-300 hover:bg-blue-50/40'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xl">{option.icon}</span>
                <span className="text-sm font-semibold text-slate-900">{option.label}</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">{option.description}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {option.stages.map((stage, i) => (
                  <span
                    key={stage}
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-100 text-slate-600"
                  >
                    {i + 1}. {stage}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
