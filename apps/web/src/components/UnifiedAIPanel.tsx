import { useState, useRef, useEffect, useCallback } from 'react';
import { generateDocument, editDocumentAI, fetchWorkflows } from '../lib/api';
import { startAgentStream, type AgentStreamEvent, type SessionStatus } from '../lib/agent-stream';
import { STAGE_SUGGESTIONS, type DocumentStage } from '../lib/stages';
import { useQuery } from '@tanstack/react-query';
import { MarkdownPreview } from './MarkdownPreview';

interface ToolCallEntry {
  toolName: string;
  input: Record<string, unknown>;
  output?: unknown;
  durationMs?: number;
  error?: string;
  sequence: number;
  collapsed: boolean;
}

type UnifiedMessage =
  | { id: number; kind: 'user'; content: string; timestamp: Date }
  | { id: number; kind: 'assistant'; content: string; timestamp: Date }
  | { id: number; kind: 'tool_call'; entry: ToolCallEntry }
  | { id: number; kind: 'proposed_edit'; proposed: string; resolved: boolean; accepted?: boolean };

const statusColors: Record<SessionStatus, string> = {
  idle: 'bg-slate-100 text-slate-600',
  running: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-amber-100 text-amber-700',
};

export interface UnifiedAIPanelProps {
  content: string;
  onProposedEdit: (newContent: string) => void;
  isNewDocument: boolean;
  onGenerate: (result: { title: string; content: string }) => void;
  isReviewMode: boolean;
  stage?: string | null;
  documentId?: string;
  teamId: string;
}

const QUICK_EDIT_VALUE = 'quick';

function AIIcon({ className }: { className: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 2L9.19 8.63L2 9.24L7.46 13.97L5.82 21L12 17.27L18.18 21L16.54 13.97L22 9.24L14.81 8.63L12 2Z" />
    </svg>
  );
}

export function UnifiedAIPanel({
  content,
  onProposedEdit,
  isNewDocument,
  onGenerate,
  isReviewMode,
  stage,
  documentId,
  teamId,
}: UnifiedAIPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [selectedWorkflow, setSelectedWorkflow] = useState<string>(QUICK_EDIT_VALUE);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [tokenUsage, setTokenUsage] = useState<{ inputTokens: number; outputTokens: number } | null>(null);

  const abortRef = useRef<(() => void) | null>(null);
  const streamingContentRef = useRef('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const msgIdRef = useRef(0);

  const { data: workflows } = useQuery({
    queryKey: ['agent-workflows'],
    queryFn: fetchWorkflows,
  });

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  }, [prompt]);

  const appendMessage = useCallback((msg: Omit<UnifiedMessage, 'id'>) => {
    const id = ++msgIdRef.current;
    setMessages((prev) => [...prev, { ...msg, id } as UnifiedMessage]);
  }, []);

  const commitStreamingContent = useCallback(() => {
    if (streamingContentRef.current) {
      const text = streamingContentRef.current;
      streamingContentRef.current = '';
      setStreamingContent('');
      appendMessage({ kind: 'assistant', content: text, timestamp: new Date() });
    } else {
      setStreamingContent('');
    }
  }, [appendMessage]);

  const handleAgentEvent = useCallback((event: AgentStreamEvent) => {
    switch (event.type) {
      case 'status':
        setStatus(event.status);
        break;
      case 'text':
        streamingContentRef.current += event.text;
        setStreamingContent(streamingContentRef.current);
        break;
      case 'tool_call':
        if (event.toolName === 'update_document') {
          const proposed = (event.input as { content?: string })?.content ?? '';
          appendMessage({ kind: 'proposed_edit', proposed, resolved: false });
        } else {
          appendMessage({
            kind: 'tool_call',
            entry: {
              toolName: event.toolName,
              input: event.input,
              sequence: event.sequence,
              collapsed: true,
            },
          });
        }
        break;
      case 'tool_result':
        setMessages((prev) =>
          prev.map((msg) =>
            msg.kind === 'tool_call' && msg.entry.sequence === event.sequence
              ? {
                  ...msg,
                  entry: {
                    ...msg.entry,
                    output: event.output,
                    durationMs: event.durationMs,
                    error: event.error,
                  },
                }
              : msg,
          ),
        );
        break;
      case 'done':
        setStatus('completed');
        setTokenUsage(event.tokenUsage);
        commitStreamingContent();
        break;
    }
  }, [appendMessage, commitStreamingContent]);

  const handleSubmit = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || status === 'running') return;

    appendMessage({ kind: 'user', content: trimmed, timestamp: new Date() });
    setPrompt('');
    setStatus('running');
    setTokenUsage(null);

    // Generate new document (always fast path)
    if (isNewDocument && !content.trim()) {
      try {
        const result = await generateDocument(trimmed);
        appendMessage({
          kind: 'assistant',
          content: `Generated "${result.title}" — applied to the editor.`,
          timestamp: new Date(),
        });
        onGenerate(result);
        setStatus('completed');
      } catch (err) {
        appendMessage({
          kind: 'assistant',
          content: `Something went wrong. ${err instanceof Error ? err.message : 'Please try again.'}`,
          timestamp: new Date(),
        });
        setStatus('failed');
      }
      return;
    }

    // Quick edit — fast path
    if (selectedWorkflow === QUICK_EDIT_VALUE) {
      const controller = new AbortController();
      abortRef.current = () => controller.abort();
      try {
        const history = messages
          .filter((m): m is Extract<UnifiedMessage, { kind: 'user' | 'assistant' }> =>
            m.kind === 'user' || m.kind === 'assistant',
          )
          .map((m) => ({ role: m.kind === 'user' ? ('user' as const) : ('assistant' as const), content: m.content }));
        const result = await editDocumentAI(content, trimmed, history, controller.signal);
        appendMessage({
          kind: 'assistant',
          content: 'Changes ready for review. Check the diff in the editor.',
          timestamp: new Date(),
        });
        onProposedEdit(result.content);
        setStatus('completed');
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        appendMessage({
          kind: 'assistant',
          content: `Something went wrong. ${err instanceof Error ? err.message : 'Please try again.'}`,
          timestamp: new Date(),
        });
        setStatus('failed');
      } finally {
        abortRef.current = null;
      }
      return;
    }

    // Agent path — SSE stream
    const workflow = workflows?.find((w) => w.id === selectedWorkflow);
    const actualPrompt = trimmed || workflow?.defaultPrompt || '';
    if (!actualPrompt) {
      setStatus('idle');
      return;
    }

    streamingContentRef.current = '';
    setStreamingContent('');

    const { abort } = startAgentStream({
      teamId,
      prompt: actualPrompt,
      workflowId: selectedWorkflow,
      documentId,
      onEvent: handleAgentEvent,
      onError: (err) => {
        commitStreamingContent();
        appendMessage({
          kind: 'assistant',
          content: `Error: ${err.message}`,
          timestamp: new Date(),
        });
        setStatus('failed');
      },
    });

    abortRef.current = abort;
  }, [
    prompt,
    status,
    isNewDocument,
    content,
    selectedWorkflow,
    messages,
    workflows,
    teamId,
    documentId,
    appendMessage,
    handleAgentEvent,
    commitStreamingContent,
    onGenerate,
    onProposedEdit,
  ]);

  const cancelSession = useCallback(() => {
    abortRef.current?.();
    commitStreamingContent();
    setStatus('cancelled');
  }, [commitStreamingContent]);

  const toggleToolCall = (sequence: number) => {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.kind === 'tool_call' && msg.entry.sequence === sequence
          ? { ...msg, entry: { ...msg.entry, collapsed: !msg.entry.collapsed } }
          : msg,
      ),
    );
  };

  const handleAcceptEdit = (proposed: string, id: number) => {
    onProposedEdit(proposed);
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === id && msg.kind === 'proposed_edit' ? { ...msg, resolved: true, accepted: true } : msg,
      ),
    );
  };

  const handleRejectEdit = (id: number) => {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === id && msg.kind === 'proposed_edit' ? { ...msg, resolved: true, accepted: false } : msg,
      ),
    );
  };

  const clearHistory = useCallback(() => {
    setMessages([]);
    streamingContentRef.current = '';
    setStreamingContent('');
    setStatus('idle');
    setTokenUsage(null);
  }, []);

  const isRunning = status === 'running';
  const isEmpty = messages.length === 0 && !streamingContent;

  const suggestions =
    isNewDocument && !content.trim()
      ? [
          'Write an API specification for a user auth service',
          'Create a project architecture doc',
          'Draft an onboarding guide for new developers',
        ]
      : stage && STAGE_SUGGESTIONS[stage as DocumentStage]
        ? STAGE_SUGGESTIONS[stage as DocumentStage]
        : ['Add a section about error handling', 'Rewrite the intro to be more concise', 'Add code examples for each endpoint'];

  return (
    <div className="flex h-full flex-col">
      {/* Workflow selector */}
      <div className="flex-shrink-0 border-b border-slate-200 px-3 py-2">
        <select
          value={selectedWorkflow}
          onChange={(e) => {
            setSelectedWorkflow(e.target.value);
            const wf = workflows?.find((w) => w.id === e.target.value);
            if (wf?.defaultPrompt && !prompt) setPrompt(wf.defaultPrompt);
          }}
          disabled={isRunning}
          className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-blue-400 disabled:opacity-60"
        >
          <option value={QUICK_EDIT_VALUE}>Quick edit</option>
          {workflows?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto">
        {isEmpty ? (
          /* Empty state with suggestion prompts */
          <div className="flex h-full flex-col items-center justify-center px-4 py-8">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-md shadow-blue-200/50">
              <AIIcon className="h-5 w-5 text-white" />
            </div>
            <p className="text-center text-xs font-medium text-slate-500">
              {isNewDocument && !content.trim() ? 'Describe the document you want to create' : 'Ask AI to edit this document'}
            </p>
            <div className="mt-3 w-full space-y-1.5">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setPrompt(s)}
                  className="block w-full rounded-lg border border-slate-150 bg-slate-50/80 px-3 py-2 text-left text-[11px] text-slate-500 transition-all hover:border-blue-200 hover:bg-blue-50/50 hover:text-blue-600"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Chat messages */
          <div className="space-y-0.5 p-2">
            {messages.map((msg) => {
              if (msg.kind === 'user') {
                return (
                  <div key={msg.id} className="rounded-lg bg-blue-50/70 px-3 py-2">
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 text-[9px] font-bold text-slate-500">
                        Y
                      </span>
                      <span className="text-[10px] font-semibold text-slate-400">You</span>
                      <span className="text-[9px] text-slate-300">
                        {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="pl-[22px] text-xs leading-relaxed text-slate-600">{msg.content}</p>
                  </div>
                );
              }

              if (msg.kind === 'assistant') {
                return (
                  <div key={msg.id} className="rounded-lg px-3 py-2">
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600">
                        <AIIcon className="h-2.5 w-2.5 text-white" />
                      </span>
                      <span className="text-[10px] font-semibold text-slate-400">AI</span>
                      <span className="text-[9px] text-slate-300">
                        {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <div className="pl-[22px] text-xs">
                      <MarkdownPreview content={msg.content} />
                    </div>
                  </div>
                );
              }

              if (msg.kind === 'tool_call') {
                const tc = msg.entry;
                return (
                  <div key={msg.id} className="rounded-lg border border-slate-100 bg-slate-50">
                    <button
                      type="button"
                      onClick={() => toggleToolCall(tc.sequence)}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-slate-100"
                    >
                      <svg
                        className={`h-3 w-3 flex-shrink-0 text-slate-400 transition-transform ${tc.collapsed ? '' : 'rotate-90'}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={2}
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                      </svg>
                      <span className="flex-1 font-mono text-[11px] text-slate-700">{tc.toolName}</span>
                      {tc.error ? (
                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-[9px] font-medium text-red-600">error</span>
                      ) : tc.durationMs !== undefined ? (
                        <span className="text-[10px] text-slate-400">{tc.durationMs}ms</span>
                      ) : (
                        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
                      )}
                    </button>
                    {!tc.collapsed && (
                      <div className="border-t border-slate-100 px-3 py-2 text-[10px]">
                        <div className="mb-1 font-medium text-slate-500">Input:</div>
                        <pre className="mb-2 max-h-20 overflow-auto whitespace-pre-wrap text-slate-600">
                          {JSON.stringify(tc.input, null, 2)}
                        </pre>
                        {tc.output !== undefined && (
                          <>
                            <div className="mb-1 font-medium text-slate-500">{tc.error ? 'Error:' : 'Output:'}</div>
                            <pre className="max-h-20 overflow-auto whitespace-pre-wrap text-slate-600">
                              {typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output, null, 2)}
                            </pre>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              }

              if (msg.kind === 'proposed_edit') {
                return (
                  <div key={msg.id} className="rounded-lg border border-blue-200 bg-blue-50/40">
                    <div className="flex items-center gap-2 border-b border-blue-100 px-3 py-1.5">
                      <svg
                        className="h-3.5 w-3.5 text-blue-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={2}
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125"
                        />
                      </svg>
                      <span className="text-[11px] font-semibold text-blue-700">Proposed edit</span>
                      {msg.resolved && (
                        <span
                          className={`ml-auto rounded-full px-2 py-0.5 text-[9px] font-medium ${
                            msg.accepted ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                          }`}
                        >
                          {msg.accepted ? 'Accepted' : 'Rejected'}
                        </span>
                      )}
                    </div>
                    <div className="px-3 py-2">
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-blue-100 bg-white/80 p-2 text-[10px] text-slate-600">
                        {msg.proposed.length > 400 ? `${msg.proposed.slice(0, 400)}…` : msg.proposed}
                      </pre>
                    </div>
                    {!msg.resolved && (
                      <div className="flex gap-1.5 border-t border-blue-100 px-3 py-2">
                        <button
                          type="button"
                          onClick={() => handleAcceptEdit(msg.proposed, msg.id)}
                          className="rounded-md bg-blue-600 px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-700"
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRejectEdit(msg.id)}
                          className="rounded-md border border-slate-200 px-3 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-100"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                );
              }

              return null;
            })}

            {/* In-progress streaming text */}
            {streamingContent && (
              <div className="rounded-lg px-3 py-2">
                <div className="mb-0.5 flex items-center gap-1.5">
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600">
                    <AIIcon className="h-2.5 w-2.5 text-white" />
                  </span>
                  <span className="text-[10px] font-semibold text-slate-400">AI</span>
                  <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
                </div>
                <div className="pl-[22px] text-xs">
                  <MarkdownPreview content={streamingContent} />
                </div>
              </div>
            )}

            {/* Loading dots for fast path (no streaming text yet) */}
            {isRunning && !streamingContent && (
              <div className="rounded-lg px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600">
                    <AIIcon className="h-2.5 w-2.5 text-white" />
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
            <svg
              className="h-3.5 w-3.5 flex-shrink-0 text-amber-500"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
              />
            </svg>
            <span className="text-[11px] font-medium text-amber-700">Review changes in the editor</span>
          </div>
        </div>
      )}

      {/* Status bar (hidden when idle) */}
      {status !== 'idle' && (
        <div className="flex-shrink-0 border-t border-slate-200 px-3 py-1.5">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColors[status]}`}>
              {status === 'running' && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />}
              {status}
            </span>
            {tokenUsage && (
              <span className="text-[10px] text-slate-400">{tokenUsage.inputTokens + tokenUsage.outputTokens} tokens</span>
            )}
          </div>
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
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              disabled={isRunning || isReviewMode}
              placeholder={
                isReviewMode
                  ? 'Approve or reject changes first...'
                  : isNewDocument && !content.trim()
                    ? 'Describe your document...'
                    : 'Ask AI...'
              }
              rows={1}
              className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 pr-8 text-xs leading-relaxed text-slate-700 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-300 focus:ring-1 focus:ring-blue-100 disabled:bg-slate-50 disabled:opacity-60"
            />
          </div>
          <div className="flex flex-shrink-0 gap-1">
            {messages.length > 0 && !isRunning && (
              <button
                type="button"
                onClick={clearHistory}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                title="Clear chat"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
                  />
                </svg>
              </button>
            )}
            {isRunning ? (
              <button
                type="button"
                onClick={cancelSession}
                className="flex h-8 items-center gap-1 rounded-lg bg-red-500 px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-red-600"
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!prompt.trim() || isReviewMode}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm transition-all hover:bg-blue-700 disabled:opacity-30 disabled:shadow-none"
                title="Send"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
