import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { generateDocument, createDocument } from '../lib/api';
import { MarkdownPreview } from './MarkdownPreview';

interface DashboardAIPromptProps {
  teamId: string;
}

const QUICK_ACTIONS = [
  'Write a spec for a new feature',
  'Explain a piece of code',
  'Draft an onboarding guide',
];

export function DashboardAIPrompt({ teamId }: DashboardAIPromptProps) {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<{ title: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  }, [prompt]);

  const handleSubmit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || isLoading) return;

    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await generateDocument(trimmed);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateDoc = async () => {
    if (!result) return;
    setIsLoading(true);
    try {
      const doc = await createDocument({
        title: result.title,
        content: result.content,
        teamId,
      });
      navigate(`/app/documents/${doc.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create document');
      setIsLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 shadow-sm">
          <svg className="h-4 w-4 text-white" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2L9.19 8.63L2 9.24L7.46 13.97L5.82 21L12 17.27L18.18 21L16.54 13.97L22 9.24L14.81 8.63L12 2Z" />
          </svg>
        </div>
        <h2 className="text-sm font-semibold text-slate-900">AI Assistant</h2>
      </div>

      {!result ? (
        <>
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              disabled={isLoading}
              placeholder="Ask AI to generate a document..."
              rows={2}
              className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-300 focus:bg-white focus:ring-1 focus:ring-blue-100 disabled:opacity-60"
            />
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => setPrompt(action)}
                className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
              >
                {action}
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-between">
            {error && <p className="text-xs text-red-500">{error}</p>}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!prompt.trim() || isLoading}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-40"
            >
              {isLoading ? (
                <>
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Generating...
                </>
              ) : (
                'Generate'
              )}
            </button>
          </div>
        </>
      ) : (
        <div>
          <div className="mb-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
            <h3 className="mb-1 text-sm font-medium text-slate-900">{result.title}</h3>
            <div className="max-h-48 overflow-y-auto text-xs text-slate-600">
              <MarkdownPreview content={result.content.slice(0, 500) + (result.content.length > 500 ? '...' : '')} />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCreateDoc}
              disabled={isLoading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-40"
            >
              Create doc from this
            </button>
            <button
              type="button"
              onClick={() => { setResult(null); setPrompt(''); }}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
            >
              Start over
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
