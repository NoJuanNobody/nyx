import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { EditorController } from '../hooks/useEditorController';
import { formatShortcut } from '../lib/editorShortcuts';
import type { EditorCommandId } from '../lib/markdownEdits';

interface MarkdownToolbarProps {
  controller: EditorController;
}

interface ToolbarButton {
  id: EditorCommandId;
  /** Visible text. */
  text: string;
  /** Accessible name. */
  label: string;
  className?: string;
}

const GROUPS: ToolbarButton[][] = [
  [
    { id: 'bold', text: 'B', label: 'Bold', className: 'font-bold' },
    { id: 'italic', text: 'I', label: 'Italic', className: 'italic' },
    { id: 'strike', text: 'S', label: 'Strikethrough', className: 'line-through' },
  ],
  [
    { id: 'code', text: '</>', label: 'Inline code', className: 'font-mono text-[10px]' },
    { id: 'codeBlock', text: '{ }', label: 'Code block', className: 'font-mono text-[10px]' },
    { id: 'link', text: 'Link', label: 'Link' },
  ],
  [
    { id: 'ul', text: 'Bullets', label: 'Bullet list' },
    { id: 'ol', text: 'Numbers', label: 'Numbered list' },
    { id: 'task', text: 'Tasks', label: 'Task list' },
    { id: 'quote', text: 'Quote', label: 'Blockquote' },
  ],
];

const HEADINGS: Array<{ id: EditorCommandId; short: string; long: string }> = [
  { id: 'h1', short: 'H1', long: 'Heading 1' },
  { id: 'h2', short: 'H2', long: 'Heading 2' },
  { id: 'h3', short: 'H3', long: 'Heading 3' },
];

const btnClass =
  'rounded px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

function titleFor(label: string, id: EditorCommandId): string {
  const sc = formatShortcut(id);
  return sc ? `${label} (${sc})` : label;
}

/**
 * Formatting toolbar. Buttons never take focus from the textarea on mouse
 * down (so the selection survives) and are a single tab stop with arrow-key
 * navigation, per the ARIA toolbar pattern. Every action runs through the
 * shared controller, so it is undoable and works offline.
 */
export function MarkdownToolbar({ controller }: MarkdownToolbarProps) {
  const { exec, canUndo, canRedo } = controller;
  const [headingOpen, setHeadingOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [roving, setRoving] = useState(0);

  const items = useCallback(
    () => Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-tb-item]:not(:disabled)') ?? []),
    [],
  );

  useEffect(() => {
    if (!headingOpen) return;
    const close = (e: Event) => {
      if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) setHeadingOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [headingOpen]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && headingOpen) {
      e.preventDefault();
      setHeadingOpen(false);
      controller.textareaRef.current?.focus();
      return;
    }
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    const list = items().filter((b) => b.getAttribute('role') !== 'menuitem');
    const cur = list.indexOf(document.activeElement as HTMLButtonElement);
    if (cur === -1) return;
    e.preventDefault();
    let next = cur;
    if (e.key === 'ArrowRight') next = (cur + 1) % list.length;
    else if (e.key === 'ArrowLeft') next = (cur - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else next = list.length - 1;
    list[next].focus();
    setRoving(Number(list[next].dataset.tbIndex ?? 0));
  };

  let index = 0;
  // If the remembered tab stop is a disabled Undo/Redo, fall back to the first format button.
  const rov = (roving === 0 && !canUndo) || (roving === 1 && !canRedo) ? 2 : roving;
  const tab = (i: number) => (i === rov ? 0 : -1);
  const run = (id: EditorCommandId) => {
    setHeadingOpen(false);
    exec(id);
  };
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  const renderButton = (b: ToolbarButton) => {
    const i = index++;
    return (
      <button
        key={b.id}
        type="button"
        data-tb-item
        data-tb-index={i}
        data-testid={`toolbar-${b.id}`}
        tabIndex={tab(i)}
        aria-label={b.label}
        title={titleFor(b.label, b.id)}
        onMouseDown={keepFocus}
        onClick={() => run(b.id)}
        className={btnClass}
      >
        <span className={b.className}>{b.text}</span>
      </button>
    );
  };

  const undoIndex = index++;
  const redoIndex = index++;

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className="flex flex-shrink-0 items-center gap-0.5 overflow-x-auto border-b border-slate-200 bg-slate-50/80 px-2 py-1"
    >
      <button
        type="button"
        data-tb-item
        data-tb-index={undoIndex}
        data-testid="toolbar-undo"
        tabIndex={tab(undoIndex)}
        aria-label="Undo"
        title={titleFor('Undo', 'undo')}
        disabled={!canUndo}
        onMouseDown={keepFocus}
        onClick={() => run('undo')}
        className={btnClass}
      >
        Undo
      </button>
      <button
        type="button"
        data-tb-item
        data-tb-index={redoIndex}
        data-testid="toolbar-redo"
        tabIndex={tab(redoIndex)}
        aria-label="Redo"
        title={titleFor('Redo', 'redo')}
        disabled={!canRedo}
        onMouseDown={keepFocus}
        onClick={() => run('redo')}
        className={btnClass}
      >
        Redo
      </button>
      <Divider />

      {GROUPS[0].map(renderButton)}
      <Divider />

      <div className="relative">
        {(() => {
          const i = index++;
          return (
            <button
              type="button"
              data-tb-item
              data-tb-index={i}
              data-testid="toolbar-heading"
              tabIndex={tab(i)}
              aria-label="Heading"
              aria-haspopup="menu"
              aria-expanded={headingOpen}
              title="Heading"
              onMouseDown={keepFocus}
              onClick={() => setHeadingOpen((p) => !p)}
              className={btnClass}
            >
              Heading
              <span aria-hidden="true" className="ml-0.5 text-[9px]">&#9662;</span>
            </button>
          );
        })()}
        {headingOpen && (
          <div
            role="menu"
            aria-label="Heading level"
            className="absolute left-0 top-full z-20 mt-1 rounded-md border border-slate-200 bg-white py-1 shadow-lg"
          >
            {HEADINGS.map((h) => (
              <button
                key={h.id}
                type="button"
                role="menuitem"
                data-tb-item
                data-testid={`toolbar-${h.id}`}
                onMouseDown={keepFocus}
                onClick={() => run(h.id)}
                title={titleFor(h.long, h.id)}
                className="block w-full px-4 py-1 text-left text-sm text-slate-700 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
              >
                <span className="font-semibold">{h.short}</span>
                <span className="ml-2 text-xs text-slate-400">{h.long}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <Divider />

      {GROUPS[1].map(renderButton)}
      <Divider />
      {GROUPS[2].map(renderButton)}

      <div className="ml-auto hidden whitespace-nowrap pl-3 text-[10px] text-slate-400 lg:block" aria-hidden="true">
        {formatShortcut('bold')} Bold &middot; {formatShortcut('italic')} Italic &middot; {formatShortcut('link')} Link
        &middot; {formatShortcut('undo')} Undo
      </div>
    </div>
  );
}

function Divider() {
  return <div aria-hidden="true" className="mx-1 h-4 w-px flex-shrink-0 bg-slate-200" />;
}
