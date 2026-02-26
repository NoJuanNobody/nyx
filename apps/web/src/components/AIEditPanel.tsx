import { useState, useRef, useEffect } from 'react';
import { generateDocument, editDocumentAI } from '../lib/api';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AIEditPanelProps {
  content: string;
  onProposedEdit: (newContent: string) => void;
  isNewDocument: boolean;
  onGenerate: (result: { title: string; content: string }) => void;
  isReviewMode: boolean;
}

export function AIEditPanel({
  content,
  onProposedEdit,
  isNewDocument,
  onGenerate,
  isReviewMode,
}: AIEditPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory]);

  const handleSubmit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || isLoading) return;

    setError(null);
    setIsLoading(true);
    setExpanded(true);

    const userMessage: ChatMessage = { role: 'user', content: trimmed };
    setChatHistory((prev) => [...prev, userMessage]);
    setPrompt('');

    try {
      if (isNewDocument && !content.trim()) {
        const result = await generateDocument(trimmed);
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: `Generated document: "${result.title}"`,
        };
        setChatHistory((prev) => [...prev, assistantMessage]);
        onGenerate(result);
      } else {
        const result = await editDocumentAI(content, trimmed, chatHistory);
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: 'Suggested changes — review the diff above.',
        };
        setChatHistory((prev) => [...prev, assistantMessage]);
        onProposedEdit(result.content);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI request failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const hasHistory = chatHistory.length > 0;

  return (
    <div className="flex-shrink-0 border-t border-slate-200 bg-white/95 backdrop-blur-sm">
      {/* Expandable chat history */}
      {expanded && hasHistory && (
        <div className="border-b border-slate-100 px-5 pt-3 pb-2">
          <div className="max-h-36 space-y-1.5 overflow-y-auto">
            {chatHistory.map((msg, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 text-xs leading-relaxed ${
                  msg.role === 'user' ? 'text-slate-600' : 'text-blue-600'
                }`}
              >
                <span
                  className={`mt-px flex-shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    msg.role === 'user'
                      ? 'bg-slate-100 text-slate-500'
                      : 'bg-blue-50 text-blue-500'
                  }`}
                >
                  {msg.role === 'user' ? 'You' : 'AI'}
                </span>
                <span>{msg.content}</span>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
        </div>
      )}

      {/* Input tray */}
      <div className="flex items-center gap-3 px-5 py-3">
        {/* Collapse/expand toggle for history */}
        {hasHistory && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            title={expanded ? 'Hide chat history' : 'Show chat history'}
          >
            <svg
              className={`h-3.5 w-3.5 transition-transform ${expanded ? '' : 'rotate-180'}`}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
          </button>
        )}

        {/* AI sparkle icon */}
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 shadow-sm">
          <svg className="h-3.5 w-3.5 text-white" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2L9.19 8.63L2 9.24L7.46 13.97L5.82 21L12 17.27L18.18 21L16.54 13.97L22 9.24L14.81 8.63L12 2Z" />
          </svg>
        </div>

        {isReviewMode ? (
          <div className="flex flex-1 items-center rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <svg className="mr-2 h-3.5 w-3.5 flex-shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
            </svg>
            <span className="text-xs text-amber-700">
              Review the suggested changes above before continuing.
            </span>
          </div>
        ) : (
          <>
            <input
              ref={inputRef}
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isLoading}
              placeholder={
                isNewDocument && !content.trim()
                  ? 'Describe the document you want to generate...'
                  : 'Tell the AI what to change...'
              }
              className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isLoading || !prompt.trim()}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white shadow-sm transition-all hover:bg-blue-700 disabled:opacity-40 disabled:shadow-none"
            >
              {isLoading ? (
                <>
                  <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Working
                </>
              ) : (
                <>
                  Send
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
                  </svg>
                </>
              )}
            </button>
          </>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="border-t border-red-100 bg-red-50 px-5 py-2">
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}
    </div>
  );
}
