import type { EditorCommandId } from './markdownEdits';

/**
 * Keyboard shortcut table for the Markdown editor. `Cmd` (macOS) and `Ctrl`
 * (Windows/Linux) are treated as the same modifier so shortcuts work the same
 * everywhere. Digits/punctuation match on `code` because Shift/Alt change `key`.
 */
interface Shortcut {
  id: EditorCommandId;
  key?: string;
  code?: string;
  shift?: boolean;
  alt?: boolean;
  /** Human label parts after the modifier, e.g. ['Shift', 'X']. */
  label: string[];
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'bold', key: 'b', label: ['B'] },
  { id: 'italic', key: 'i', label: ['I'] },
  { id: 'strike', key: 'x', shift: true, label: ['Shift', 'X'] },
  { id: 'code', key: 'e', label: ['E'] },
  { id: 'code', key: '`', label: ['`'] },
  { id: 'codeBlock', code: 'KeyC', alt: true, label: ['Alt', 'C'] },
  { id: 'link', key: 'k', label: ['K'] },
  { id: 'h1', code: 'Digit1', alt: true, label: ['Alt', '1'] },
  { id: 'h2', code: 'Digit2', alt: true, label: ['Alt', '2'] },
  { id: 'h3', code: 'Digit3', alt: true, label: ['Alt', '3'] },
  { id: 'ol', code: 'Digit7', shift: true, label: ['Shift', '7'] },
  { id: 'ul', code: 'Digit8', shift: true, label: ['Shift', '8'] },
  { id: 'task', code: 'Digit9', shift: true, label: ['Shift', '9'] },
  { id: 'quote', code: 'Period', shift: true, label: ['Shift', '.'] },
  { id: 'undo', key: 'z', label: ['Z'] },
  { id: 'redo', key: 'z', shift: true, label: ['Shift', 'Z'] },
  { id: 'redo', key: 'y', label: ['Y'] },
];

export interface KeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Return the editor command bound to a key event, or `null`. */
export function matchShortcut(e: KeyLike): EditorCommandId | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  for (const sc of SHORTCUTS) {
    if (!!sc.shift !== e.shiftKey || !!sc.alt !== e.altKey) continue;
    if (sc.code ? sc.code === e.code : sc.key === key) return sc.id;
  }
  return null;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
}

/** Display string such as `Cmd+Shift+X` / `Ctrl+Shift+X`. */
export function formatShortcut(id: EditorCommandId, mac: boolean = isMacPlatform()): string | null {
  const sc = SHORTCUTS.find((s) => s.id === id);
  if (!sc) return null;
  const mod = mac ? 'Cmd' : 'Ctrl';
  const label = sc.label.map((p) => (p === 'Alt' && mac ? 'Option' : p));
  return [mod, ...label].join('+');
}
