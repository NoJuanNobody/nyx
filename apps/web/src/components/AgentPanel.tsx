import { useState, useRef, useEffect, useCallback } from 'react';
import { startAgentStream, type AgentStreamEvent } from '../lib/agent-stream';
import { fetchWorkflows } from '../lib/api';
import { useQuery } from '@tanstack/react-query';
import { MarkdownPreview } from './MarkdownPreview';

interface AgentPanelProps {
  documentId?: string;
  teamId: string;
}

interface ToolCallEntry {
  toolName: string;
  input: Record<string, unknown>;
  output?: unknown;
  durationMs?: number;
  error?: string;
  sequence: number;
  collapsed: boolean;
}

type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export function AgentPanel({ documentId, teamId }: AgentPanelProps) {
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [prompt, setPrompt] = useState('');
  const [selectedWorkflow, setSelectedWorkflow] = useState<string>('');
  const [streamText, setStreamText] = useState('');
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [tokenUsage, setTokenUsage] = useState<{ inputTokens: number; outputTokens: number } | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const textRef = useRef<HTMLDivElement>(null);

  const { data: workflows } = useQuery({
    queryKey: ['agent-workflows'],
    queryFn: fetchWorkflows,
  });

  // Auto-scroll text output
  useEffect(() => {
    if (textRef.current) {
      textRef.current.scrollTop = textRef.current.scrollHeight;
    }
  }, [streamText]);

  const handleEvent = useCallback((event: AgentStreamEvent) => {
    switch (event.type) {
      case 'status':
        setStatus(event.status as SessionStatus);
        break;
      case 'tool_call':
        setToolCalls((prev) => [
          ...prev,
          {
            toolName: event.toolName as string,
            input: event.input as Record<string, unknown>,
            sequence: event.sequence as number,
            collapsed: true,
          },
        ]);
        break;
      case 'tool_result':
        setToolCalls((prev) =>
          prev.map((tc) =>
            tc.sequence === (event.sequence as number)
              ? {
                  ...tc,
                  output: event.output,
                  durationMs: event.durationMs as number,
                  error: event.error as string | undefined,
                }
              : tc,
          ),
        );
        break;
      case 'text':
        setStreamText((prev) => prev + (event.text as string));
        break;
      case 'done':
        setStatus('completed');
        setTokenUsage(event.tokenUsage as { inputTokens: number; outputTokens: number });
        break;
    }
  }, []);

  const startSession = useCallback(() => {
    if (!prompt.trim() && !selectedWorkflow) return;

    const workflow = workflows?.find((w) => w.id === selectedWorkflow);
    const actualPrompt = prompt.trim() || workflow?.defaultPrompt || '';
    if (!actualPrompt) return;

    // Reset state
    setStatus('running');
    setStreamText('');
    setToolCalls([]);
    setTokenUsage(null);

    const { abort } = startAgentStream({
      teamId,
      prompt: actualPrompt,
      workflowId: selectedWorkflow || undefined,
      documentId,
      onEvent: handleEvent,
      onError: (err) => {
        setStatus('failed');
        setStreamText((prev) => prev + `\n\nError: ${err.message}`);
      },
      onComplete: () => {
        if (status === 'running') setStatus('completed');
      },
    });

    abortRef.current = abort;
  }, [prompt, selectedWorkflow, teamId, documentId, workflows, handleEvent, status]);

  const cancelSession = useCallback(() => {
    abortRef.current?.();
    setStatus('cancelled');
  }, []);

  const toggleToolCall = (sequence: number) => {
    setToolCalls((prev) =>
      prev.map((tc) =>
        tc.sequence === sequence ? { ...tc, collapsed: !tc.collapsed } : tc,
      ),
    );
  };

  const statusColors: Record<SessionStatus, string> = {
    idle: 'bg-slate-100 text-slate-600',
    running: 'bg-blue-100 text-blue-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    cancelled: 'bg-amber-100 text-amber-700',
  };

  return (
    <div className="flex h-full flex-col">
      {/* Workflow selector + prompt */}
      <div className="flex-shrink-0 border-b border-slate-200 p-3 space-y-2">
        {workflows && workflows.length > 0 && (
          <select
            value={selectedWorkflow}
            onChange={(e) => {
              setSelectedWorkflow(e.target.value);
              const wf = workflows.find((w) => w.id === e.target.value);
              if (wf?.defaultPrompt && !prompt) setPrompt(wf.defaultPrompt);
            }}
            className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-blue-400"
          >
            <option value="">Custom prompt...</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}

        <div className="flex gap-1.5">
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && status !== 'running' && startSession()}
            placeholder="What should the agent do?"
            className="flex-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-blue-400"
            disabled={status === 'running'}
          />
          {status === 'running' ? (
            <button
              type="button"
              onClick={cancelSession}
              className="rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 transition-colors"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={startSession}
              disabled={!prompt.trim() && !selectedWorkflow}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              Run
            </button>
          )}
        </div>

        {/* Status badge */}
        {status !== 'idle' && (
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColors[status]}`}>
              {status === 'running' && (
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              )}
              {status}
            </span>
            {tokenUsage && (
              <span className="text-[10px] text-slate-400">
                {tokenUsage.inputTokens + tokenUsage.outputTokens} tokens
              </span>
            )}
          </div>
        )}
      </div>

      {/* Tool calls log */}
      {toolCalls.length > 0 && (
        <div className="flex-shrink-0 max-h-48 overflow-y-auto border-b border-slate-200">
          {toolCalls.map((tc) => (
            <div key={tc.sequence} className="border-b border-slate-100 last:border-b-0">
              <button
                type="button"
                onClick={() => toggleToolCall(tc.sequence)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50 transition-colors"
              >
                <svg
                  className={`h-3 w-3 text-slate-400 transition-transform ${tc.collapsed ? '' : 'rotate-90'}`}
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
                <div className="bg-slate-50 px-3 py-2 text-[10px]">
                  <div className="mb-1 font-medium text-slate-500">Input:</div>
                  <pre className="mb-2 max-h-20 overflow-auto whitespace-pre-wrap text-slate-600">
                    {JSON.stringify(tc.input, null, 2)}
                  </pre>
                  {tc.output !== undefined && (
                    <>
                      <div className="mb-1 font-medium text-slate-500">
                        {tc.error ? 'Error:' : 'Output:'}
                      </div>
                      <pre className="max-h-20 overflow-auto whitespace-pre-wrap text-slate-600">
                        {typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output, null, 2)}
                      </pre>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Streaming text output — rendered as markdown */}
      <div ref={textRef} className="flex-1 overflow-y-auto p-3">
        {streamText ? (
          <div className="text-xs">
            <MarkdownPreview content={streamText} />
          </div>
        ) : status === 'idle' ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mb-2 text-slate-300">
                <svg className="mx-auto h-8 w-8" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" />
                </svg>
              </div>
              <p className="text-[11px] text-slate-400">
                Select a workflow or enter a custom prompt
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
