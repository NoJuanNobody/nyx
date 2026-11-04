import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import type { EditorController } from '../hooks/useEditorController';
import { getCaretPoint, getSelectionRect } from '../lib/caretPosition';
import { insertSnippet, replaceRange } from '../lib/markdownEdits';
import {
  getMentionContext,
  getSlashContext,
  mentionMarkdown,
  resolveInsert,
  type MentionCandidate,
  type SlashCommand,
} from '../lib/slashCommands';
import { Highlighted } from './markdownHighlight';
import { MentionPalette } from './MentionPalette';
import { SlashCommandPalette } from './SlashCommandPalette';

/** Above this size the colour overlay is skipped so typing stays instant. */
export const HIGHLIGHT_MAX_CHARS = 200_000;

interface MarkdownEditorProps {
  value: string;
  controller: EditorController;
  placeholder?: string;
  teamId?: string;
  /** Documents that can be linked with `@`. Local data; no network needed. */
  mentionCandidates?: MentionCandidate[];
  onSelection?: (selectedText: string, anchorRect: DOMRect) => void;
  onSelectionClear?: () => void;
}

type Popup =
  | { kind: 'slash'; query: string; key: string; top: number; left: number }
  | { kind: 'mention'; query: string; key: string; top: number; left: number };

const POPUP_HEIGHT = 270;
const POPUP_WIDTH = 330;

/**
 * Markdown editor: a transparent textarea over a syntax-highlighted backdrop.
 * All text-editing behaviour (shortcuts, undo/redo, list continuation) lives in
 * the shared {@link EditorController}; this component renders the surface and
 * the `/` and `@` pickers.
 */
export function MarkdownEditor({
  value,
  controller,
  placeholder,
  teamId,
  mentionCandidates = [],
  onSelection,
  onSelectionClear,
}: MarkdownEditorProps) {
  const { textareaRef, handleChange, handleKeyDown, handlePaste, applyEdit, undo, redo } = controller;
  const highlightRef = useRef<HTMLPreElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [activeOption, setActiveOption] = useState<string | null>(null);
  const dismissedKey = useRef<string | null>(null);
  const baseId = useId().replace(/:/g, '');
  const listId = `${baseId}-list`;
  const hintId = `${baseId}-hint`;
  const plain = value.length > HIGHLIGHT_MAX_CHARS;

  const placePopup = useCallback(
    (ta: HTMLTextAreaElement, index: number) => {
      const wrap = wrapperRef.current?.getBoundingClientRect();
      const pt = getCaretPoint(ta, index);
      let top = wrap ? pt.top - wrap.top + pt.height : pt.height;
      let left = wrap ? pt.left - wrap.left : 0;
      if (wrap) {
        if (top + POPUP_HEIGHT > wrap.height && pt.top - wrap.top - POPUP_HEIGHT > 0) {
          top = pt.top - wrap.top - POPUP_HEIGHT;
        }
        left = Math.min(left, Math.max(wrap.width - POPUP_WIDTH, 0));
      }
      return { top: Math.max(top, 0), left: Math.max(left, 0) };
    },
    [],
  );

  /** Decide which picker (if any) the caret is in. */
  const refreshPopup = useCallback(
    (ta: HTMLTextAreaElement) => {
      if (ta.selectionStart !== ta.selectionEnd) {
        setPopup(null);
        return;
      }
      const caret = ta.selectionStart;
      const slash = getSlashContext(ta.value, caret);
      if (slash) {
        const key = `slash:${slash.lineStart}:${slash.query}`;
        if (dismissedKey.current === key) return;
        setPopup((prev) =>
          prev && prev.key === key ? prev : { kind: 'slash', query: slash.query, key, ...placePopup(ta, slash.lineStart) },
        );
        return;
      }
      if (mentionCandidates.length > 0) {
        const m = getMentionContext(ta.value, caret);
        if (m) {
          const key = `mention:${m.start}:${m.query}`;
          if (dismissedKey.current === key) return;
          setPopup((prev) =>
            prev && prev.key === key ? prev : { kind: 'mention', query: m.query, key, ...placePopup(ta, m.start) },
          );
          return;
        }
      }
      dismissedKey.current = null;
      setPopup(null);
    },
    [mentionCandidates.length, placePopup],
  );

  const closePopup = useCallback(() => {
    setPopup((p) => {
      if (p) dismissedKey.current = p.key;
      return null;
    });
    textareaRef.current?.focus();
  }, [textareaRef]);

  const onTextChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      handleChange(e);
      refreshPopup(e.target);
    },
    [handleChange, refreshPopup],
  );

  const emitSelection = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (ta.selectionStart === ta.selectionEnd) {
      onSelectionClear?.();
      return;
    }
    const text = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
    if (!text) {
      onSelectionClear?.();
      return;
    }
    onSelection?.(text, getSelectionRect(ta));
  }, [onSelection, onSelectionClear, textareaRef]);

  const onKeyUp = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      refreshPopup(e.currentTarget);
      if (e.shiftKey || e.key === 'Shift') emitSelection();
      else if (e.currentTarget.selectionStart === e.currentTarget.selectionEnd) onSelectionClear?.();
    },
    [emitSelection, onSelectionClear, refreshPopup],
  );

  const onSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      const snippet = resolveInsert(cmd);
      applyEdit((s) => {
        const ctx = getSlashContext(s.value, s.start);
        if (!ctx) return null;
        return insertSnippet(s, ctx.lineStart, ctx.lineEnd, snippet);
      });
      setPopup(null);
    },
    [applyEdit],
  );

  const onMentionSelect = useCallback(
    (c: MentionCandidate) => {
      applyEdit((s) => {
        const ctx = getMentionContext(s.value, s.start);
        if (!ctx) return null;
        return replaceRange(s, ctx.start, ctx.end, mentionMarkdown(c) + ' ');
      });
      setPopup(null);
    },
    [applyEdit],
  );

  // Menu-driven Undo/Redo (Edit menu, Touch Bar, context menu) arrive as beforeinput.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const onBeforeInput = (e: Event) => {
      const type = (e as InputEvent).inputType;
      if (type === 'historyUndo') {
        e.preventDefault();
        undo();
      } else if (type === 'historyRedo') {
        e.preventDefault();
        redo();
      }
    };
    ta.addEventListener('beforeinput', onBeforeInput);
    return () => ta.removeEventListener('beforeinput', onBeforeInput);
  }, [textareaRef, undo, redo]);

  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    const pre = highlightRef.current;
    if (ta && pre) {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    }
  }, [textareaRef]);

  useEffect(() => {
    syncScroll();
  }, [value, syncScroll]);

  const popupOpen = popup !== null;

  return (
    <div ref={wrapperRef} className="relative flex-1 overflow-hidden">
      {!plain && (
        <pre
          ref={highlightRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words p-4 font-mono text-sm leading-relaxed text-transparent"
          style={{ wordBreak: 'break-word' }}
        >
          <code>
            <Highlighted source={value} />
            {/* Trailing newline so the pre matches the textarea's height */}
            {'\n'}
          </code>
        </pre>
      )}

      <textarea
        ref={textareaRef}
        data-testid="markdown-textarea"
        value={value}
        onChange={onTextChange}
        onKeyDown={handleKeyDown}
        onKeyUp={onKeyUp}
        onPaste={handlePaste}
        onScroll={syncScroll}
        onClick={(e) => refreshPopup(e.currentTarget)}
        onMouseUp={emitSelection}
        placeholder={placeholder}
        spellCheck={false}
        aria-label="Markdown editor"
        aria-describedby={hintId}
        aria-controls={popupOpen ? listId : undefined}
        aria-haspopup="listbox"
        aria-activedescendant={popupOpen && activeOption ? activeOption : undefined}
        className={`absolute inset-0 h-full w-full resize-none bg-transparent p-4 font-mono text-sm leading-relaxed outline-none placeholder:text-slate-400 selection:bg-blue-200/60 dark:selection:bg-blue-500/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-300 ${
          plain ? 'text-slate-800' : 'text-transparent'
        }`}
        style={
          plain
            ? undefined
            : { caretColor: 'var(--color-slate-800, #1e293b)', WebkitTextFillColor: 'transparent' }
        }
      />
      <span id={hintId} className="sr-only">
        Type / for commands and @ to link a document. Tab moves focus out of the editor except inside lists.
      </span>

      {popup?.kind === 'slash' && (
        <SlashCommandPalette
          position={{ top: popup.top, left: popup.left }}
          filter={popup.query}
          teamId={teamId}
          listId={listId}
          onSelect={onSlashSelect}
          onClose={closePopup}
          onActiveChange={setActiveOption}
        />
      )}
      {popup?.kind === 'mention' && (
        <MentionPalette
          position={{ top: popup.top, left: popup.left }}
          query={popup.query}
          candidates={mentionCandidates}
          listId={listId}
          onSelect={onMentionSelect}
          onClose={closePopup}
          onActiveChange={setActiveOption}
        />
      )}
    </div>
  );
}
