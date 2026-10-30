import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Portal } from './Portal';
import { formatShortcut } from '../lib/editorShortcuts';
import type { EditorCommandId } from '../lib/markdownEdits';

interface SelectionToolbarProps {
  anchorRect: DOMRect;
  selectedText: string;
  /** Local formatting (works offline). The group is hidden when omitted. */
  onFormat?: (id: EditorCommandId) => void;
  /** AI quick-edit via the configured provider. The AI group is hidden when omitted. */
  onAction?: (instruction: string) => void;
  onDismiss: () => void;
  isPending?: boolean;
  /** When set, AI actions are shown disabled with this explanation (e.g. offline). */
  aiDisabledReason?: string;
}

const FORMAT_ACTIONS: Array<{ id: EditorCommandId; text: string; label: string; className?: string }> = [
  { id: 'bold', text: 'B', label: 'Bold', className: 'font-bold' },
  { id: 'italic', text: 'I', label: 'Italic', className: 'italic' },
  { id: 'strike', text: 'S', label: 'Strikethrough', className: 'line-through' },
  { id: 'code', text: '</>', label: 'Inline code', className: 'font-mono' },
  { id: 'link', text: 'Link', label: 'Link' },
  { id: 'quote', text: 'Quote', label: 'Blockquote' },
  { id: 'ul', text: 'List', label: 'Bullet list' },
];

const AI_ACTIONS = [
  { label: 'Improve', instruction: 'Improve the writing of the selected section' },
  { label: 'Fix grammar', instruction: 'Fix grammar and spelling in the selected section' },
  { label: 'Make shorter', instruction: 'Make the selected section more concise' },
  { label: 'Make longer', instruction: 'Expand the selected section with more detail' },
  { label: 'Summarize', instruction: 'Summarize the selected section as a single paragraph' },
];

const btn =
  'whitespace-nowrap rounded px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white active:bg-white/30 disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Floating toolbar shown over a text selection. The formatting group is pure
 * local text editing; the AI group is optional and only shown when a handler is
 * supplied. Escape or an outside click dismisses it; arrow keys move between
 * buttons once focus is inside.
 */
export function SelectionToolbar({
  anchorRect,
  selectedText,
  onFormat,
  onAction,
  onDismiss,
  isPending = false,
  aiDisabledReason,
}: SelectionToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);

  const above = anchorRect.top - 44;
  const top = above >= 8 ? above : anchorRect.bottom + 8;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const center = anchorRect.left + anchorRect.width / 2;
  const left = vw > 340 ? Math.min(Math.max(center, 170), vw - 170) : center;

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) onDismiss();
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onDismiss]);

  const onToolbarKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    const list = Array.from(toolbarRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const cur = list.indexOf(document.activeElement as HTMLButtonElement);
    if (cur === -1) return;
    e.preventDefault();
    const next =
      e.key === 'ArrowRight' ? (cur + 1) % list.length
        : e.key === 'ArrowLeft' ? (cur - 1 + list.length) % list.length
          : e.key === 'Home' ? 0 : list.length - 1;
    list[next].focus();
  };

  return (
    <Portal>
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Selection actions"
        data-testid="selection-toolbar"
        className="fixed z-[60] flex max-w-[calc(100vw-16px)] items-center gap-0.5 overflow-x-auto rounded-lg bg-slate-900 px-1.5 py-1 shadow-xl ring-1 ring-black/10"
        style={{ top, left, transform: 'translateX(-50%)' }}
        onKeyDown={onToolbarKeyDown}
        onMouseDown={(e) => e.preventDefault()}
      >
        {onFormat &&
          FORMAT_ACTIONS.map((a) => {
            const sc = formatShortcut(a.id);
            return (
              <button
                key={a.id}
                type="button"
                aria-label={a.label}
                title={sc ? `${a.label} (${sc})` : a.label}
                data-testid={`selection-format-${a.id}`}
                onClick={() => onFormat(a.id)}
                className={btn}
              >
                <span className={a.className}>{a.text}</span>
              </button>
            );
          })}

        {onFormat && onAction && <div aria-hidden="true" className="mx-1 h-4 w-px bg-white/25" />}

        {onAction &&
          AI_ACTIONS.map((a) => (
            <button
              key={a.label}
              type="button"
              disabled={isPending || !!aiDisabledReason}
              title={aiDisabledReason ?? a.label}
              onClick={() => onAction(`${a.instruction}:\n\n${selectedText}`)}
              data-testid={`selection-action-${a.label.toLowerCase().replace(/\s+/g, '-')}`}
              className={btn}
            >
              {a.label}
            </button>
          ))}

        <span role="status" aria-live="polite" className="sr-only">
          {isPending ? 'Working on your edit' : ''}
        </span>
      </div>
    </Portal>
  );
}
