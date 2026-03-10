import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DocumentTemplate } from '@syncdocs/shared';
import { fetchTemplates } from '../lib/api';
import { STAGES, type DocumentStage } from '../lib/stages';

interface TemplatePickerProps {
  onClose: () => void;
  onCreate: (data: { title: string; content: string; stage?: DocumentStage | null; templateId?: string }) => void;
}

export function TemplatePicker({ onClose, onCreate }: TemplatePickerProps) {
  const [selectedStage, setSelectedStage] = useState<DocumentStage | null>(null);

  const { data: templates, isLoading } = useQuery<DocumentTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => fetchTemplates(),
  });

  const filteredTemplates = templates?.filter(
    (t) => !selectedStage || t.stage === selectedStage,
  ) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="relative w-full max-w-2xl rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">Create Document</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6">
          {/* Blank document option */}
          <button
            type="button"
            onClick={() => onCreate({ title: 'Untitled Document', content: '' })}
            className="mb-6 flex w-full items-center gap-3 rounded-lg border border-slate-200 px-4 py-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50/50"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100">
              <svg className="h-5 w-5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
            </div>
            <div>
              <span className="text-sm font-medium text-slate-900">Blank Document</span>
              <p className="text-xs text-slate-500">Start from scratch</p>
            </div>
          </button>

          {/* Stage rail */}
          <div className="mb-4">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              From Template
            </span>
          </div>

          <div className="mb-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedStage(null)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                selectedStage === null
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              All
            </button>
            {STAGES.map((stage) => (
              <button
                key={stage.id}
                type="button"
                onClick={() => setSelectedStage(stage.id)}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  selectedStage === stage.id
                    ? `${stage.color} ${stage.textColor}`
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${stage.dotColor}`} />
                {stage.label}
              </button>
            ))}
          </div>

          {/* Template list */}
          <div className="max-h-64 overflow-y-auto">
            {isLoading && (
              <p className="py-4 text-center text-xs text-slate-400">Loading templates...</p>
            )}
            {!isLoading && filteredTemplates.length === 0 && (
              <p className="py-4 text-center text-xs text-slate-400">No templates found</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              {filteredTemplates.map((template) => {
                const stageInfo = STAGES.find((s) => s.id === template.stage);
                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() =>
                      onCreate({
                        title: template.name,
                        content: template.content,
                        stage: template.stage as DocumentStage,
                        templateId: template.id,
                      })
                    }
                    className="flex items-start gap-3 rounded-lg border border-slate-200 px-3 py-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50/50"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-900 truncate">
                          {template.name}
                        </span>
                        {stageInfo && (
                          <span
                            className={`flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-bold leading-none ${stageInfo.color} ${stageInfo.textColor}`}
                          >
                            {stageInfo.abbreviation}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500 truncate">
                        {template.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
