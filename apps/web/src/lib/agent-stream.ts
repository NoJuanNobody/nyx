import { resolveToken } from './api';

export type AgentEventType = 'status' | 'tool_call' | 'tool_result' | 'text' | 'done';

export interface AgentStreamEvent {
  type: AgentEventType;
  [key: string]: unknown;
}

export interface AgentStreamOptions {
  teamId: string;
  prompt: string;
  workflowId?: string;
  documentId?: string;
  onEvent: (event: AgentStreamEvent) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

/**
 * Start an agent session via SSE stream using fetch + ReadableStream.
 * Returns an abort function to cancel the session.
 */
export function startAgentStream(options: AgentStreamOptions): { abort: () => void; sessionId: Promise<string> } {
  const controller = new AbortController();
  let resolveSessionId: (id: string) => void;
  const sessionId = new Promise<string>((resolve) => {
    resolveSessionId = resolve;
  });

  (async () => {
    try {
      const token = await resolveToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/agent', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt: options.prompt,
          workflowId: options.workflowId,
          documentId: options.documentId,
          teamId: options.teamId,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Agent API error ${res.status}: ${text}`);
      }

      // Extract session ID from header
      const sid = res.headers.get('X-Session-Id');
      if (sid) resolveSessionId!(sid);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6)) as AgentStreamEvent;
              options.onEvent(event);
            } catch {
              // Skip malformed events
            }
          }
        }
      }

      options.onComplete();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        options.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return {
    abort: () => controller.abort(),
    sessionId,
  };
}
