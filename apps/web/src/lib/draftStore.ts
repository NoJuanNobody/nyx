/**
 * Local draft persistence so edits survive being offline, a failed save or an
 * app restart. Drafts are keyed by document id and only restored when the
 * server copy they were based on has not changed since (`baseUpdatedAt`).
 * All access is guarded: storage can be unavailable or full.
 */
export interface Draft {
  title: string;
  content: string;
  baseUpdatedAt: string;
  savedAt: number;
}

const PREFIX = 'nyx:draft:';

export function saveDraft(docId: string, draft: Omit<Draft, 'savedAt'>): void {
  try {
    localStorage.setItem(PREFIX + docId, JSON.stringify({ ...draft, savedAt: Date.now() }));
  } catch {
    // Storage full or unavailable: autosave to the server still applies.
  }
}

export function loadDraft(docId: string): Draft | null {
  try {
    const raw = localStorage.getItem(PREFIX + docId);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    if (typeof d.title !== 'string' || typeof d.content !== 'string' || typeof d.baseUpdatedAt !== 'string') {
      return null;
    }
    return { title: d.title, content: d.content, baseUpdatedAt: d.baseUpdatedAt, savedAt: d.savedAt ?? 0 };
  } catch {
    return null;
  }
}

export function clearDraft(docId: string): void {
  try {
    localStorage.removeItem(PREFIX + docId);
  } catch {
    // ignore
  }
}
