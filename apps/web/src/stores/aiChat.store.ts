import { create } from 'zustand';
import type { SessionStatus } from '../lib/agent-stream';

export type { SessionStatus };

export interface ToolCallEntry {
  toolName: string;
  input: Record<string, unknown>;
  output?: unknown;
  durationMs?: number;
  error?: string;
  sequence: number;
  collapsed: boolean;
}

export type UnifiedMessageBase =
  | { kind: 'user'; content: string; timestamp: Date }
  | { kind: 'assistant'; content: string; timestamp: Date }
  | { kind: 'tool_call'; entry: ToolCallEntry }
  | { kind: 'proposed_edit'; proposed: string; resolved: boolean; accepted?: boolean };

export type UnifiedMessage = UnifiedMessageBase & { id: number };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AIChatSession {
  messages: UnifiedMessage[];
  prompt: string;
  selectedWorkflow: string;
  streamingContent: string;
  status: SessionStatus;
  tokenUsage: TokenUsage | null;
  /** Set when the agent loop terminates early (e.g. hit iteration ceiling — #349). */
  incomplete: boolean;
  /** Monotonic marker that bumps each time the session transitions to `completed`.
   *  Used by the AI panel as a useEffect key to fire post-session suggestion
   *  generation exactly once per completed run. */
  completionCounter: number;
}

export const QUICK_EDIT_VALUE = 'quick';

function createEmptySession(): AIChatSession {
  return {
    messages: [],
    prompt: '',
    selectedWorkflow: QUICK_EDIT_VALUE,
    streamingContent: '',
    status: 'idle',
    tokenUsage: null,
    incomplete: false,
    completionCounter: 0,
  };
}

interface AIChatState {
  sessions: Record<string, AIChatSession>;
  ensureSession: (documentId: string) => AIChatSession;
  getSession: (documentId: string) => AIChatSession;
  setMessages: (documentId: string, updater: (prev: UnifiedMessage[]) => UnifiedMessage[]) => void;
  appendMessage: (documentId: string, msg: UnifiedMessageBase, nextId: number) => void;
  updateMessage: (
    documentId: string,
    updater: (prev: UnifiedMessage[]) => UnifiedMessage[],
  ) => void;
  setPrompt: (documentId: string, prompt: string) => void;
  setSelectedWorkflow: (documentId: string, workflow: string) => void;
  setStreamingContent: (documentId: string, content: string) => void;
  setStatus: (documentId: string, status: SessionStatus) => void;
  setTokenUsage: (documentId: string, tokenUsage: TokenUsage | null) => void;
  /** Mark the session complete, optionally as incomplete (#349), and bump the
   *  completion counter so the UI can fire post-session effects exactly once. */
  markCompleted: (documentId: string, incomplete: boolean) => void;
  reset: (documentId: string) => void;
}

export const useAIChatStore = create<AIChatState>((set, get) => ({
  sessions: {},

  ensureSession: (documentId) => {
    const existing = get().sessions[documentId];
    if (existing) return existing;
    const fresh = createEmptySession();
    set((state) => ({ sessions: { ...state.sessions, [documentId]: fresh } }));
    return fresh;
  },

  getSession: (documentId) => {
    return get().sessions[documentId] ?? createEmptySession();
  },

  setMessages: (documentId, updater) => {
    set((state) => {
      const current = state.sessions[documentId] ?? createEmptySession();
      return {
        sessions: {
          ...state.sessions,
          [documentId]: { ...current, messages: updater(current.messages) },
        },
      };
    });
  },

  appendMessage: (documentId, msg, nextId) => {
    set((state) => {
      const current = state.sessions[documentId] ?? createEmptySession();
      const message = { ...msg, id: nextId } as UnifiedMessage;
      return {
        sessions: {
          ...state.sessions,
          [documentId]: { ...current, messages: [...current.messages, message] },
        },
      };
    });
  },

  updateMessage: (documentId, updater) => {
    set((state) => {
      const current = state.sessions[documentId] ?? createEmptySession();
      return {
        sessions: {
          ...state.sessions,
          [documentId]: { ...current, messages: updater(current.messages) },
        },
      };
    });
  },

  setPrompt: (documentId, prompt) => {
    set((state) => {
      const current = state.sessions[documentId] ?? createEmptySession();
      return {
        sessions: { ...state.sessions, [documentId]: { ...current, prompt } },
      };
    });
  },

  setSelectedWorkflow: (documentId, selectedWorkflow) => {
    set((state) => {
      const current = state.sessions[documentId] ?? createEmptySession();
      return {
        sessions: { ...state.sessions, [documentId]: { ...current, selectedWorkflow } },
      };
    });
  },

  setStreamingContent: (documentId, streamingContent) => {
    set((state) => {
      const current = state.sessions[documentId] ?? createEmptySession();
      return {
        sessions: { ...state.sessions, [documentId]: { ...current, streamingContent } },
      };
    });
  },

  setStatus: (documentId, status) => {
    set((state) => {
      const current = state.sessions[documentId] ?? createEmptySession();
      return {
        sessions: { ...state.sessions, [documentId]: { ...current, status } },
      };
    });
  },

  setTokenUsage: (documentId, tokenUsage) => {
    set((state) => {
      const current = state.sessions[documentId] ?? createEmptySession();
      return {
        sessions: { ...state.sessions, [documentId]: { ...current, tokenUsage } },
      };
    });
  },

  markCompleted: (documentId, incomplete) => {
    set((state) => {
      const current = state.sessions[documentId] ?? createEmptySession();
      return {
        sessions: {
          ...state.sessions,
          [documentId]: {
            ...current,
            status: 'completed',
            incomplete,
            completionCounter: current.completionCounter + 1,
          },
        },
      };
    });
  },

  reset: (documentId) => {
    set((state) => ({
      sessions: { ...state.sessions, [documentId]: createEmptySession() },
    }));
  },
}));

// Stable empty-session sentinel returned when a session doesn't exist yet, so
// the selector below doesn't return a fresh object on every render (which
// would trip React 19's "getSnapshot should be cached" guard).
const EMPTY_SESSION_SENTINEL: AIChatSession = Object.freeze(createEmptySession());

/**
 * Hook that returns a stable view of an AI chat session for a given documentId,
 * along with bound action helpers. The session is lazily created on first access.
 */
export function useAIChatSession(documentId: string) {
  const session = useAIChatStore(
    (state) => state.sessions[documentId] ?? EMPTY_SESSION_SENTINEL,
  );

  const appendMessage = useAIChatStore((state) => state.appendMessage);
  const updateMessage = useAIChatStore((state) => state.updateMessage);
  const setMessages = useAIChatStore((state) => state.setMessages);
  const setPrompt = useAIChatStore((state) => state.setPrompt);
  const setSelectedWorkflow = useAIChatStore((state) => state.setSelectedWorkflow);
  const setStreamingContent = useAIChatStore((state) => state.setStreamingContent);
  const setStatus = useAIChatStore((state) => state.setStatus);
  const setTokenUsage = useAIChatStore((state) => state.setTokenUsage);
  const markCompleted = useAIChatStore((state) => state.markCompleted);
  const reset = useAIChatStore((state) => state.reset);

  return {
    messages: session.messages,
    prompt: session.prompt,
    selectedWorkflow: session.selectedWorkflow,
    streamingContent: session.streamingContent,
    status: session.status,
    tokenUsage: session.tokenUsage,
    incomplete: session.incomplete,
    completionCounter: session.completionCounter,
    appendMessage: (msg: UnifiedMessageBase, nextId: number) =>
      appendMessage(documentId, msg, nextId),
    updateMessage: (updater: (prev: UnifiedMessage[]) => UnifiedMessage[]) =>
      updateMessage(documentId, updater),
    setMessages: (updater: (prev: UnifiedMessage[]) => UnifiedMessage[]) =>
      setMessages(documentId, updater),
    setPrompt: (prompt: string) => setPrompt(documentId, prompt),
    setSelectedWorkflow: (workflow: string) => setSelectedWorkflow(documentId, workflow),
    setStreamingContent: (content: string) => setStreamingContent(documentId, content),
    setStatus: (status: SessionStatus) => setStatus(documentId, status),
    setTokenUsage: (tokenUsage: TokenUsage | null) => setTokenUsage(documentId, tokenUsage),
    markCompleted: (incomplete: boolean) => markCompleted(documentId, incomplete),
    reset: () => reset(documentId),
  };
}
