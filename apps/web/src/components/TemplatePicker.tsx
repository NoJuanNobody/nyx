import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { DocumentTemplate } from '@nyx/shared';
import { fetchTemplates, createTemplate, deleteTemplate } from '../lib/api';
import { STAGES, type DocumentStage } from '../lib/stages';
import { Portal } from './Portal';

interface TemplatePickerProps {
  onClose: () => void;
  onCreate: (data: { title: string; content: string; stage?: DocumentStage | null; templateId?: string }) => void;
  teamId?: string;
}

export function TemplatePicker({ onClose, onCreate, teamId }: TemplatePickerProps) {
  const [selectedStage, setSelectedStage] = useState<DocumentStage | null>(null);
  const [tab, setTab] = useState<'built-in' | 'custom'>('built-in');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTemplate, setNewTemplate] = useState({ name: '', description: '', content: '', stage: 'conception' as DocumentStage });

  const queryClient = useQueryClient();

  const { data: templates, isLoading } = useQuery<DocumentTemplate[]>({
    queryKey: ['templates', teamId],
    queryFn: () => fetchTemplates(undefined, teamId),
  });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; description: string; content: string; stage: DocumentStage; teamId: string }) =>
      createTemplate(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setShowCreateForm(false);
      setNewTemplate({ name: '', description: '', content: '', stage: 'conception' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteTemplate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
  });

  const builtInTemplates = (templates ?? []).filter(t => !(t as any).teamId);
  const customTemplates = (templates ?? []).filter(t => !!(t as any).teamId);

  const filteredBuiltIn = builtInTemplates.filter(
    (t) => !selectedStage || t.stage === selectedStage,
  );

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        onClick={onClose}
        data-testid="template-picker-backdrop"
      >
        <div
          className="relative w-full max-w-2xl rounded-xl bg-white shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          data-testid="template-picker-card"
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

          {/* Tabs: Built-in vs Custom */}
          <div className="mb-4 flex items-center gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setTab('built-in')}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === 'built-in' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Built-in Templates
            </button>
            <button
              type="button"
              onClick={() => setTab('custom')}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === 'custom' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              My Templates {customTemplates.length > 0 && `(${customTemplates.length})`}
            </button>
          </div>

          {tab === 'built-in' && (
            <>
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
                {!isLoading && filteredBuiltIn.length === 0 && (
                  <p className="py-4 text-center text-xs text-slate-400">No templates found</p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {filteredBuiltIn.map((template) => {
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
            </>
          )}

          {tab === 'custom' && (
            <div>
              {/* Create template button */}
              {teamId && !showCreateForm && (
                <button
                  type="button"
                  onClick={() => setShowCreateForm(true)}
                  className="mb-4 flex w-full items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500 transition-colors hover:border-blue-300 hover:bg-blue-50/50 hover:text-blue-600"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  Create Custom Template
                </button>
              )}

              {/* Create form */}
              {showCreateForm && teamId && (
                <div className="mb-4 space-y-3 rounded-lg border border-blue-200 bg-blue-50/30 p-4">
                  <input
                    type="text"
                    placeholder="Template name"
                    value={newTemplate.name}
                    onChange={(e) => setNewTemplate(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <input
                    type="text"
                    placeholder="Short description"
                    value={newTemplate.description}
                    onChange={(e) => setNewTemplate(prev => ({ ...prev, description: e.target.value }))}
                    className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <select
                    value={newTemplate.stage}
                    onChange={(e) => setNewTemplate(prev => ({ ...prev, stage: e.target.value as DocumentStage }))}
                    className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  >
                    {STAGES.map(s => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                  <textarea
                    placeholder="Template content (markdown)"
                    value={newTemplate.content}
                    onChange={(e) => setNewTemplate(prev => ({ ...prev, content: e.target.value }))}
                    rows={4}
                    className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm font-mono focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      type="button"
                      onClick={() => setShowCreateForm(false)}
                      className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!newTemplate.name || !newTemplate.content || createMutation.isPending}
                      onClick={() => createMutation.mutate({ ...newTemplate, teamId })}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {createMutation.isPending ? 'Saving...' : 'Save Template'}
                    </button>
                  </div>
                </div>
              )}

              {/* Custom template grid */}
              <div className="max-h-64 overflow-y-auto">
                {customTemplates.length === 0 && !showCreateForm && (
                  <p className="py-8 text-center text-xs text-slate-400">
                    No custom templates yet. Create one to get started!
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {customTemplates
                    .filter(t => !selectedStage || t.stage === selectedStage)
                    .map((template) => {
                      const stageInfo = STAGES.find((s) => s.id === template.stage);
                      return (
                        <div key={template.id} className="group relative">
                          <button
                            type="button"
                            onClick={() =>
                              onCreate({
                                title: template.name,
                                content: template.content,
                                stage: template.stage as DocumentStage,
                                templateId: template.id,
                              })
                            }
                            className="flex w-full items-start gap-3 rounded-lg border border-slate-200 px-3 py-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50/50"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-slate-900 truncate">
                                  {template.name}
                                </span>
                                {stageInfo && (
                                  <span className={`flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-bold leading-none ${stageInfo.color} ${stageInfo.textColor}`}>
                                    {stageInfo.abbreviation}
                                  </span>
                                )}
                              </div>
                              <p className="mt-0.5 text-xs text-slate-500 truncate">{template.description}</p>
                            </div>
                          </button>
                          {/* Delete button */}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(template.id); }}
                            className="absolute right-1 top-1 hidden rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-500 group-hover:block"
                            title="Delete template"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                            </svg>
                          </button>
                        </div>
                      );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
        </div>
      </div>
    </Portal>
  );
}
