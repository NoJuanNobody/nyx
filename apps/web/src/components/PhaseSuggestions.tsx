import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createDocument } from '../lib/api';
import { STAGES, type DocumentStage } from '../lib/stages';

interface PhaseSuggestionsProps {
  teamId: string;
}

export function PhaseSuggestions({ teamId }: PhaseSuggestionsProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (stage: DocumentStage) =>
      createDocument({
        title: 'Untitled Document',
        content: '',
        teamId,
        stage,
      }),
    onSuccess: (doc) => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      navigate(`/documents/${doc.id}`);
    },
  });

  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Start from a Phase</h2>
      <div className="grid grid-cols-5 gap-3">
        {STAGES.map((stage) => (
          <div
            key={stage.id}
            className={`rounded-xl border ${stage.borderColor} bg-white p-4 transition-shadow hover:shadow-md`}
          >
            <div className={`mb-2 inline-flex rounded-lg ${stage.color} p-1.5`}>
              <span className={`text-xs font-bold ${stage.textColor}`}>{stage.abbreviation}</span>
            </div>
            <h3 className="text-sm font-medium text-slate-900">{stage.label}</h3>
            <p className="mt-0.5 text-xs text-slate-500">{stage.subtitle}</p>
            <button
              type="button"
              onClick={() => createMutation.mutate(stage.id)}
              disabled={createMutation.isPending}
              className={`mt-3 w-full rounded-lg border ${stage.borderColor} px-2 py-1 text-xs font-medium ${stage.textColor} transition-colors hover:${stage.color}`}
            >
              Create
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
