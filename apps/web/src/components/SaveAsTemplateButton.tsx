import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createTemplate } from '../lib/api';
import { STAGES, type DocumentStage } from '../lib/stages';
import { Modal } from './Modal';

interface SaveAsTemplateButtonProps {
  content: string;
  stage: DocumentStage | null;
  teamId: string;
}

export function SaveAsTemplateButton({ content, stage, teamId }: SaveAsTemplateButtonProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [templateStage, setTemplateStage] = useState<DocumentStage>(stage ?? 'conception');
  const [success, setSuccess] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      createTemplate({
        name,
        description,
        content,
        stage: templateStage,
        teamId,
      }),
    onSuccess: () => {
      setSuccess(true);
      setTimeout(() => {
        setOpen(false);
        setSuccess(false);
        setName('');
        setDescription('');
      }, 1500);
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setTemplateStage(stage ?? 'conception');
          setOpen(true);
        }}
        className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
        title="Save as Template"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
        </svg>
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Save as Template">
        {success ? (
          <div className="flex items-center gap-2 py-4 text-sm text-green-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
            Template saved!
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-slate-500">
              Save the current document content as a reusable template for your team.
            </p>
            <div className="space-y-3">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Template name"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              />
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short description"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              />
              <select
                value={templateStage}
                onChange={(e) => setTemplateStage(e.target.value as DocumentStage)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              >
                {STAGES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => mutation.mutate()}
                disabled={!name || !content || mutation.isPending}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {mutation.isPending ? 'Saving...' : 'Save Template'}
              </button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
