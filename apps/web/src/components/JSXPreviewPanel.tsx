import { useState, useRef, useEffect, useCallback } from 'react';
import { generateJSXPreview, refineJSXPreview } from '../lib/api';
import { JSXPreviewRenderer } from './JSXPreviewRenderer';

type ViewMode = 'preview' | 'code' | 'split';

interface RefinementMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface JSXPreviewPanelProps {
  specContext?: string;
}

export function JSXPreviewPanel({ specContext }: JSXPreviewPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [currentJSX, setCurrentJSX] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<RefinementMessage[]>([]);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  }, [prompt]);

  const handleGenerate = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || isLoading) return;

    setError(null);
    setIsLoading(true);
    setPrompt('');

    const userMsg: RefinementMessage = { role: 'user', content: trimmed, timestamp: new Date() };
    setChatHistory((prev) => [...prev, userMsg]);

    try {
      const result = await generateJSXPreview(trimmed, specContext);
      setCurrentJSX(result.jsx);
      setViewMode('preview');
      const assistantMsg: RefinementMessage = {
        role: 'assistant',
        content: 'Preview generated — rendering in iframe.',
        timestamp: new Date(),
      };
      setChatHistory((prev) => [...prev, assistantMsg]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Generation failed';
      setError(msg);
      setChatHistory((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${msg}`, timestamp: new Date() },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [prompt, isLoading, specContext]);

  const handleRefine = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || isLoading || !currentJSX) return;

    setError(null);
    setIsLoading(true);
    setPrompt('');

    const userMsg: RefinementMessage = { role: 'user', content: trimmed, timestamp: new Date() };
    setChatHistory((prev) => [...prev, userMsg]);

    try {
      const result = await refineJSXPreview(currentJSX, trimmed);
      setCurrentJSX(result.jsx);
      const assistantMsg: RefinementMessage = {
        role: 'assistant',
        content: 'Preview updated with your changes.',
        timestamp: new Date(),
      };
      setChatHistory((prev) => [...prev, assistantMsg]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Refinement failed';
      setError(msg);
      setChatHistory((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${msg}`, timestamp: new Date() },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [prompt, isLoading, currentJSX]);

  const handleSubmit = useCallback(() => {
    if (currentJSX) {
      handleRefine();
    } else {
      handleGenerate();
    }
  }, [currentJSX, handleGenerate, handleRefine]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleCopy = useCallback(async () => {
    if (!currentJSX) return;
    await navigator.clipboard.writeText(currentJSX);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [currentJSX]);

  const handleDownload = useCallback(() => {
    if (!currentJSX) return;
    const blob = new Blob([currentJSX], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'preview.jsx';
    a.click();
    URL.revokeObjectURL(url);
  }, [currentJSX]);

  const SUGGESTIONS = [
    'A dashboard with a sidebar, header, and 3 metric cards',
    'A project status board with progress bars and task list',
    'A quarterly report with summary stats and a bar chart',
    'A user profile card with avatar, stats, and action buttons',
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      {currentJSX && (
        <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-200 px-3 py-1.5">
          {/* View mode tabs */}
          <div className="flex rounded-lg bg-slate-100 p-0.5">
            {(['preview', 'code', 'split'] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-all ${
                  viewMode === mode
                    ? 'bg-white text-slate-700 shadow-sm'
                    : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
          {/* Actions */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleCopy}
              title="Copy JSX"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            >
              {copied ? (
                <svg className="h-3.5 w-3.5 text-green-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
              ) : (
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" />
                </svg>
              )}
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              title="Download as .jsx"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              .jsx
            </button>
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {!currentJSX ? (
          /* Empty state */
          <div className="flex h-full flex-col items-center justify-center px-4 py-8">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-md shadow-violet-200/50">
              <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
              </svg>
            </div>
            <p className="mb-1 text-center text-xs font-medium text-slate-600">
              Generate a live UI preview
            </p>
            <p className="mb-4 text-center text-[11px] text-slate-400">
              Describe a UI and Claude will render it in a sandboxed iframe
            </p>
            <div className="w-full space-y-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setPrompt(s)}
                  className="block w-full rounded-lg border border-slate-150 bg-slate-50/80 px-3 py-2 text-left text-[11px] text-slate-500 transition-all hover:border-violet-200 hover:bg-violet-50/50 hover:text-violet-600"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : viewMode === 'preview' ? (
          <JSXPreviewRenderer jsx={currentJSX} />
        ) : viewMode === 'code' ? (
          <div className="h-full overflow-auto bg-slate-950 p-3">
            <pre className="font-mono text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap break-words">
              {currentJSX}
            </pre>
          </div>
        ) : (
          /* Split view */
          <div className="flex h-full">
            <div className="flex w-1/2 flex-col overflow-auto border-r border-slate-200 bg-slate-950 p-3">
              <pre className="font-mono text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap break-words">
                {currentJSX}
              </pre>
            </div>
            <div className="w-1/2">
              <JSXPreviewRenderer jsx={currentJSX} />
            </div>
          </div>
        )}
      </div>

      {/* Chat / refinement history */}
      {chatHistory.length > 0 && (
        <div className="max-h-28 flex-shrink-0 overflow-y-auto border-t border-slate-100 bg-slate-50/60 px-3 py-2">
          <div className="space-y-1">
            {chatHistory.map((msg, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span
                  className={`mt-0.5 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full text-[8px] font-bold ${
                    msg.role === 'user'
                      ? 'bg-slate-200 text-slate-500'
                      : 'bg-gradient-to-br from-violet-500 to-indigo-600 text-white'
                  }`}
                >
                  {msg.role === 'user' ? 'Y' : 'A'}
                </span>
                <p className="text-[11px] leading-snug text-slate-500">{msg.content}</p>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="flex-shrink-0 border-t border-red-100 bg-red-50 px-3 py-2">
          <p className="text-[11px] text-red-600">{error}</p>
        </div>
      )}

      {/* Input area */}
      <div className="flex-shrink-0 border-t border-slate-200 p-2">
        <div className="flex items-end gap-1.5">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            placeholder={currentJSX ? 'Refine the preview…' : 'Describe a UI to generate…'}
            rows={1}
            className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs leading-relaxed text-slate-700 outline-none transition-colors placeholder:text-slate-400 focus:border-violet-300 focus:ring-1 focus:ring-violet-100 disabled:bg-slate-50 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isLoading || !prompt.trim()}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-violet-600 text-white shadow-sm transition-all hover:bg-violet-700 disabled:opacity-30 disabled:shadow-none"
            title={currentJSX ? 'Refine' : 'Generate'}
          >
            {isLoading ? (
              <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
