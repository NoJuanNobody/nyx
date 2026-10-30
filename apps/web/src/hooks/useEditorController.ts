import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  continueList,
  indentLines,
  replaceRange,
  runCommand,
  type EditState,
  type EditorCommandId,
} from '../lib/markdownEdits';
import { matchShortcut } from '../lib/editorShortcuts';

interface Snapshot {
  value: string;
  start: number;
  end: number;
}

/** Keystrokes closer together than this (and of the same kind) share one undo step. */
const COALESCE_MS = 1000;
/** Memory ceiling for undo history, measured in characters across all snapshots. */
const HISTORY_CHAR_BUDGET = 8_000_000;
const HISTORY_MAX_ENTRIES = 300;

export interface EditorController {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Run a formatting command or undo/redo against the textarea's current selection. */
  exec: (id: EditorCommandId) => void;
  /** Apply a custom edit (slash command, mention, ...) as one undo step. */
  applyEdit: (fn: (state: EditState) => EditState | null) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  handleChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  handlePaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * Owns text-editing behaviour for the Markdown textarea: formatting commands,
 * keyboard shortcuts (Cmd or Ctrl), list continuation, and a real undo/redo
 * stack. The browser's native undo is unreliable once React controls the value
 * and the toolbar rewrites it, so every change (typed or programmatic) goes
 * through this history.
 *
 * `resetKey` (the document id) clears history when the user switches documents.
 */
export function useEditorController(
  value: string,
  onChange: (value: string) => void,
  resetKey?: string,
): EditorController {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const history = useRef<{ stack: Snapshot[]; index: number; chars: number }>({
    stack: [{ value, start: 0, end: 0 }],
    index: 0,
    chars: value.length,
  });
  const lastTyping = useRef<{ at: number; kind: string } | null>(null);
  const pendingSel = useRef<{ start: number; end: number; focus: boolean } | null>(null);
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  // Reset when switching documents.
  const lastKey = useRef(resetKey);
  if (lastKey.current !== resetKey) {
    lastKey.current = resetKey;
    history.current = { stack: [{ value, start: 0, end: 0 }], index: 0, chars: value.length };
    lastTyping.current = null;
    pendingSel.current = null;
  }

  const trim = useCallback(() => {
    const h = history.current;
    while (h.stack.length > 1 && (h.chars > HISTORY_CHAR_BUDGET || h.stack.length > HISTORY_MAX_ENTRIES)) {
      const dropped = h.stack.shift()!;
      h.chars -= dropped.value.length;
      h.index--;
    }
  }, []);

  const push = useCallback(
    (snap: Snapshot, coalesce: boolean) => {
      const h = history.current;
      // Drop redo branch.
      for (const dropped of h.stack.splice(h.index + 1)) h.chars -= dropped.value.length;
      if (coalesce && h.index > 0) {
        const top = h.stack[h.index];
        h.chars += snap.value.length - top.value.length;
        h.stack[h.index] = snap;
      } else {
        h.stack.push(snap);
        h.chars += snap.value.length;
        h.index = h.stack.length - 1;
      }
      trim();
    },
    [trim],
  );

  // Pick up changes made outside the editor (AI edit approved, version restored,
  // initial document load) as their own undo step.
  const externalSync = useCallback(() => {
    const h = history.current;
    const top = h.stack[h.index];
    if (top.value === value) return;
    if (h.index === 0 && h.stack.length === 1 && top.value === '') {
      // Initial document load: it becomes the baseline, not an undoable edit.
      h.stack[0] = { value, start: 0, end: 0 };
      h.chars = value.length;
    } else {
      push({ value, start: 0, end: 0 }, false);
      lastTyping.current = null;
    }
  }, [value, push]);
  useLayoutEffect(externalSync);

  // Restore selection/focus after a programmatic change has rendered.
  useLayoutEffect(() => {
    const p = pendingSel.current;
    const ta = textareaRef.current;
    if (!p || !ta || ta.value !== value) return;
    pendingSel.current = null;
    if (p.focus) ta.focus();
    ta.setSelectionRange(p.start, p.end);
  });

  const commit = useCallback(
    (next: EditState, coalesce: boolean, before?: EditState) => {
      if (before) {
        // Remember where the selection was BEFORE this edit so undo restores it.
        const top = history.current.stack[history.current.index];
        if (top && top.value === before.value) {
          top.start = before.start;
          top.end = before.end;
        }
      }
      push({ value: next.value, start: next.start, end: next.end }, coalesce);
      pendingSel.current = { start: next.start, end: next.end, focus: true };
      onChangeRef.current(next.value);
      rerender();
    },
    [push, rerender],
  );

  const readState = useCallback((): EditState | null => {
    const ta = textareaRef.current;
    if (!ta) return null;
    return { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
  }, []);

  const jump = useCallback(
    (to: number) => {
      const h = history.current;
      if (to < 0 || to >= h.stack.length) return;
      h.index = to;
      const snap = h.stack[to];
      lastTyping.current = null;
      pendingSel.current = { start: snap.start, end: snap.end, focus: true };
      onChangeRef.current(snap.value);
      rerender();
    },
    [rerender],
  );

  const undo = useCallback(() => jump(history.current.index - 1), [jump]);
  const redo = useCallback(() => jump(history.current.index + 1), [jump]);

  const exec = useCallback(
    (id: EditorCommandId) => {
      if (id === 'undo') return undo();
      if (id === 'redo') return redo();
      const state = readState();
      if (!state) return;
      const next = runCommand(id, state);
      if (next) {
        lastTyping.current = null;
        commit(next, false, state);
      }
    },
    [commit, readState, redo, undo],
  );

  const applyEdit = useCallback(
    (fn: (state: EditState) => EditState | null) => {
      const state = readState();
      if (!state) return;
      const next = fn(state);
      if (next) {
        lastTyping.current = null;
        commit(next, false, state);
      }
    },
    [commit, readState],
  );

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const ta = e.target;
      const inputType = (e.nativeEvent as InputEvent | undefined)?.inputType ?? 'insertText';
      const kind = inputType.startsWith('delete') ? 'delete' : inputType === 'insertText' ? 'insert' : inputType;
      const typedData = (e.nativeEvent as InputEvent | undefined)?.data ?? '';
      const now = Date.now();
      const prev = lastTyping.current;
      const coalesce =
        !!prev && prev.kind === kind && now - prev.at < COALESCE_MS && (kind === 'insert' || kind === 'delete') && !/\s/.test(typedData);
      lastTyping.current = { at: now, kind };
      push({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd }, coalesce);
      onChangeRef.current(ta.value);
      rerender();
    },
    [push, rerender],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing || e.defaultPrevented) return;

      const cmd = matchShortcut(e);
      if (cmd) {
        e.preventDefault();
        exec(cmd);
        return;
      }

      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (plain && e.key === 'Enter' && !e.shiftKey) {
        const state = readState();
        const next = state && continueList(state);
        if (next) {
          e.preventDefault();
          lastTyping.current = null;
          commit(next, false, state);
        }
        return;
      }
      if (plain && e.key === 'Tab') {
        const state = readState();
        const next = state && indentLines(state, e.shiftKey);
        if (next) {
          e.preventDefault();
          lastTyping.current = null;
          commit(next, false, state);
        }
      }
    },
    [commit, exec, readState],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const text = e.clipboardData?.getData('text/plain')?.trim() ?? '';
      const state = readState();
      if (!state || state.start === state.end || !/^https?:\/\/\S+$/.test(text)) return;
      // Pasting a URL over a selection turns the selection into a link.
      e.preventDefault();
      const selected = state.value.slice(state.start, state.end);
      const md = `[${selected}](${text})`;
      commit(replaceRange(state, state.start, state.end, md), false, state);
    },
    [commit, readState],
  );

  const h = history.current;
  return useMemo(
    () => ({
      textareaRef,
      exec,
      applyEdit,
      undo,
      redo,
      canUndo: h.index > 0,
      canRedo: h.index < h.stack.length - 1,
      handleChange,
      handleKeyDown,
      handlePaste,
    }),
    // history.current mutates in place; the rerender() bump re-evaluates these flags.
    [exec, applyEdit, undo, redo, handleChange, handleKeyDown, handlePaste, h.index, h.stack.length],
  );
}
