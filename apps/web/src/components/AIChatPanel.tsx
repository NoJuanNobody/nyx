import { useState, useRef, useEffect, useCallback } from 'react';
import { generateDocument, editDocumentAI } from '../lib/api';
import { STAGE_SUGGESTIONS, type DocumentStage } from '../lib/stages';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface AIChatPanelProps {
  content: string;
  onProposedEdit: (newContent: string) => void;
  isNewDocument: boolean;
  onGenerate: (result: { title: string; content: string }) => void;
  isReviewMode: boolean;
  stage?: string | null;
}

export function AIChatPanel({
  content,
  onProposedEdit,
  isNewDocument,
  onGenerate,
  isReviewMode,
  stage,
}: AIChatPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const handleSubmit = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || isLoading) return;

    setError(null);
    setIsLoading(true);

    const userMessage: ChatMessage = { role: 'user', content: trimmed, timestamp: new Date() };
    setChatHistory((prev) => [...prev, userMessage]);
    setPrompt('');

    try {
      if (isNewDocument && !content.trim()) {
        const result = await generateDocument(trimmed);
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: `Generated "${result.title}" — applied to the editor.`,
          timestamp: new Date(),
        };
        setChatHistory((prev) => [...prev, assistantMessage]);
        onGenerate(result);
      } else {
        const apiHistory = chatHistory.map((m) => ({ role: m.role, content: m.content }));
        const result = await editDocumentAI(content, trimmed, apiHistory);
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: 'Changes ready for review. Check the diff in the editor.',
          timestamp: new Date(),
        };
        setChatHistory((prev) => [...prev, assistantMessage]);
        onProposedEdit(result.content);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI request failed');
      const errorMessage: ChatMessage = {
        role: 'assistant',
        content: `Something went wrong. ${err instanceof Error ? err.message : 'Please try again.'}`,
        timestamp: new Date(),
      };
      setChatHistory((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  }, [prompt, isLoading, isNewDocument, content, chatHistory, onGenerate, onProposedEdit]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const clearHistory = useCallback(() => {
    setChatHistory([]);
    setError(null);
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto">
        {chatHistory.length === 0 ? (
          /* Empty state */
          <div className="flex h-full flex-col items-center justify-center px-4 py-8">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-md shadow-blue-200/50">
              <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2L9.19 8.63L2 9.24L7.46 13.97L5.82 21L12 17.27L18.18 21L16.54 13.97L22 9.24L14.81 8.63L12 2Z" />
              </svg>
            </div>
            <p className="text-center text-xs font-medium text-slate-500">
              {isNewDocument && !content.trim()
                ? 'Describe the document you want to create'
                : 'Ask AI to edit this document'}
            </p>
            <div className="mt-3 space-y-1.5">
              {(isNewDocument && !content.trim()
                ? [
                    'Write an API specification for a user auth service',
                    'Create a project architecture doc',
                    'Draft an onboarding guide for new developers',
                  ]
                : stage && STAGE_SUGGESTIONS[stage as DocumentStage]
                  ? STAGE_SUGGESTIONS[stage as DocumentStage]
                  : [
                      'Add a section about error handling',
                      'Rewrite the intro to be more concise',
                      'Add code examples for each endpoint',
                    ]
              ).map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setPrompt(suggestion)}
                  className="block w-full rounded-lg border border-slate-150 bg-slate-50/80 px-3 py-2 text-left text-[11px] text-slate-500 transition-all hover:border-blue-200 hover:bg-blue-50/50 hover:text-blue-600"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Chat messages */
          <div className="space-y-0.5 p-2">
            {chatHistory.map((msg, i) => (
              <div
                key={i}
                className={`rounded-lg px-3 py-2 ${
                  msg.role === 'user'
                    ? 'bg-blue-50/70'
                    : ''
                }`}
              >
                <div className="mb-0.5 flex items-center gap-1.5">
                  {msg.role === 'user' ? (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 text-[9px] font-bold text-slate-500">
                      Y
                    </span>
                  ) : (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600">
                      <svg className="h-2.5 w-2.5 text-white" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 2L9.19 8.63L2 9.24L7.46 13.97L5.82 21L12 17.27L18.18 21L16.54 13.97L22 9.24L14.81 8.63L12 2Z" />
                      </svg>
                    </span>
                  )}
                  <span className="text-[10px] font-semibold text-slate-400">
                    {msg.role === 'user' ? 'You' : 'AI'}
                  </span>
                  <span className="text-[9px] text-slate-300">
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p className="pl-[22px] text-xs leading-relaxed text-slate-600">
                  {msg.content}
                </p>
              </div>
            ))}

            {/* Loading indicator */}
            {isLoading && (
              <div className="rounded-lg px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600">
                    <svg className="h-2.5 w-2.5 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 2L9.19 8.63L2 9.24L7.46 13.97L5.82 21L12 17.27L18.18 21L16.54 13.97L22 9.24L14.81 8.63L12 2Z" />
                    </svg>
                  </span>
                  <span className="text-[10px] font-semibold text-slate-400">AI</span>
                </div>
                <div className="mt-1 pl-[22px]">
                  <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400 [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400 [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400 [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>
        )}
      </div>

      {/* Review mode banner */}
      {isReviewMode && (
        <div className="flex-shrink-0 border-t border-amber-200 bg-amber-50 px-3 py-2">
          <div className="flex items-center gap-2">
            <svg className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
            </svg>
            <span className="text-[11px] font-medium text-amber-700">
              Review changes in the editor
            </span>
          </div>
        </div>
      )}

      {/* Error display */}
      {error && !isLoading && (
        <div className="flex-shrink-0 border-t border-red-100 bg-red-50 px-3 py-2">
          <p className="text-[11px] text-red-600">{error}</p>
        </div>
      )}

      {/* Input area */}
      <div className="flex-shrink-0 border-t border-slate-200 p-2">
        <div className="flex items-end gap-1.5">
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isLoading || isReviewMode}
              placeholder={
                isReviewMode
                  ? 'Approve or reject changes first...'
                  : isNewDocument && !content.trim()
                    ? 'Describe your document...'
                    : 'Ask AI to edit...'
              }
              rows={1}
              className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 pr-8 text-xs leading-relaxed text-slate-700 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-300 focus:ring-1 focus:ring-blue-100 disabled:bg-slate-50 disabled:opacity-60"
            />
          </div>
          <div className="flex flex-shrink-0 gap-1">
            {chatHistory.length > 0 && (
              <button
                type="button"
                onClick={clearHistory}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                title="Clear chat"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isLoading || !prompt.trim() || isReviewMode}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm transition-all hover:bg-blue-700 disabled:opacity-30 disabled:shadow-none"
              title="Send"
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
    </div>
  );
}
