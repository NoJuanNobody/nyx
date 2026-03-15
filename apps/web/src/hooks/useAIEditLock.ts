import { useCallback, useEffect, useRef, useState } from 'react';

export interface AIEditLock {
  isLocked: boolean;
  /**
   * Attempt to acquire the AI edit lock. Returns true if acquired, false if
   * another AI edit is already in progress.
   *
   * When Yjs real-time collaboration is added (issue #43), this will use the
   * Yjs awareness protocol to coordinate across all connected clients, so that
   * "another AI edit in progress" can mean a *remote* user's AI edit, not just
   * the current browser session.
   */
  acquireLock: () => boolean;
  /**
   * Release the AI edit lock. Safe to call even if the lock is not held
   * (idempotent).
   */
  releaseLock: () => void;
}

/**
 * Serializes AI edits per document — at most one AI edit can be in-flight at
 * a time within a browser session. This prevents two AI panels (e.g. the AI
 * drawer and the AI Advisor) from simultaneously issuing conflicting edits to
 * the same document.
 *
 * Interface is designed for future Yjs awareness integration (issue #43):
 * replace the local ref with a Yjs awareness field keyed by `documentId` and
 * the returned `isLocked` will reflect all connected clients' AI edit state.
 */
export function useAIEditLock(documentId: string | undefined): AIEditLock {
  const [isLocked, setIsLocked] = useState(false);
  // Ref mirrors state so callbacks never capture a stale value
  const lockedRef = useRef(false);

  // Reset lock when navigating to a different document
  useEffect(() => {
    lockedRef.current = false;
    setIsLocked(false);
  }, [documentId]);

  const acquireLock = useCallback((): boolean => {
    if (lockedRef.current) return false;
    lockedRef.current = true;
    setIsLocked(true);
    return true;
  }, []);

  const releaseLock = useCallback(() => {
    lockedRef.current = false;
    setIsLocked(false);
  }, []);

  return { isLocked, acquireLock, releaseLock };
}
