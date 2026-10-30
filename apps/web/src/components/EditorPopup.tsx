import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface PopupItem {
  id: string;
  label: string;
  description?: string;
  group?: string;
  badge?: string;
}

interface EditorPopupProps<T extends PopupItem> {
  /** Used to build option ids (`${listId}-opt-${index}`) for aria-activedescendant. */
  listId: string;
  title: string;
  /** Text typed after the trigger, shown in the header. */
  filter?: string;
  items: T[];
  position: { top: number; left: number };
  onSelect: (item: T) => void;
  onClose: () => void;
  onActiveChange?: (optionId: string | null) => void;
  /** Small status line under the list (e.g. "Templates unavailable offline"). */
  note?: ReactNode;
  testId?: string;
}

/**
 * Keyboard-driven listbox popup shared by the slash-command and mention
 * pickers. Focus stays in the textarea: the popup is operated through
 * `aria-activedescendant` on the editor, and arrow/Enter/Tab/Escape are
 * intercepted in the capture phase while the popup is open.
 */
export function EditorPopup<T extends PopupItem>({
  listId,
  title,
  filter,
  items,
  position,
  onSelect,
  onClose,
  onActiveChange,
  note,
  testId,
}: EditorPopupProps<T>) {
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemsKey = items.map((i) => i.id).join('|');

  useEffect(() => {
    setActive(0);
  }, [itemsKey]);

  const safeActive = Math.min(active, Math.max(items.length - 1, 0));

  useEffect(() => {
    onActiveChange?.(items.length > 0 ? `${listId}-opt-${safeActive}` : null);
    return () => onActiveChange?.(null);
  }, [safeActive, items.length, listId]);

  useEffect(() => {
    const el = listRef.current?.querySelectorAll('[data-popup-item]')[safeActive] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [safeActive]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setActive((p) => (p < items.length - 1 ? p + 1 : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActive((p) => (p > 0 ? p - 1 : items.length - 1));
      } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.metaKey && !e.ctrlKey && items.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        onSelect(items[safeActive]);
      }
    },
    [items, safeActive, onSelect, onClose],
  );

  useEffect(() => {
    if (items.length === 0) return;
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown, items.length]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  let lastGroup: string | undefined;

  return (
    <div
      ref={containerRef}
      className="absolute z-50 w-80 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-800"
      style={{ top: position.top, left: position.left }}
      data-testid={testId}
      // Keep focus (and the caret) in the textarea when clicking the popup.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-700">
        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
          {title}
          {filter ? (
            <span className="ml-1 text-slate-400 dark:text-slate-500">{`- filtering by "${filter}"`}</span>
          ) : null}
        </p>
      </div>

      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={title}
        className="max-h-56 overflow-y-auto"
      >
        {items.map((item, index) => {
          const header = item.group && item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <div key={item.id} role="presentation">
              {header && (
                <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  {header}
                </div>
              )}
              <div
                id={`${listId}-opt-${index}`}
                role="option"
                aria-selected={index === safeActive}
                data-popup-item
                className={`flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left transition-colors ${
                  index === safeActive
                    ? 'bg-blue-50 dark:bg-blue-900/30'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                }`}
                onMouseEnter={() => setActive(index)}
                onClick={() => onSelect(item)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">{item.label}</span>
                    {item.badge && (
                      <span className="inline-flex shrink-0 items-center rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                        {item.badge}
                      </span>
                    )}
                  </div>
                  {item.description && (
                    <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{item.description}</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-slate-100 px-3 py-1.5 dark:border-slate-700">
        {note && <p className="mb-0.5 text-[10px] text-amber-600 dark:text-amber-400">{note}</p>}
        <p className="text-[10px] text-slate-400 dark:text-slate-500">
          <kbd className="rounded border border-slate-200 px-1 py-0.5 font-mono text-[10px] dark:border-slate-600">Up/Down</kbd>
          {' '}navigate{' '}
          <kbd className="rounded border border-slate-200 px-1 py-0.5 font-mono text-[10px] dark:border-slate-600">Enter</kbd>
          {' '}select{' '}
          <kbd className="rounded border border-slate-200 px-1 py-0.5 font-mono text-[10px] dark:border-slate-600">Esc</kbd>
          {' '}dismiss
        </p>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {items.length === 1 ? '1 result' : `${items.length} results`}
      </div>
    </div>
  );
}
