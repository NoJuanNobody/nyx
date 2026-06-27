import { useEffect, useRef } from 'react';
import { Portal } from './Portal';

interface SelectionToolbarProps {
  anchorRect: DOMRect;
  selectedText: string;
  onAction: (instruction: string) => void;
  onDismiss: () => void;
  isPending?: boolean;
}

const ACTIONS = [
  { label: 'Improve', instruction: 'Improve the writing of the selected section' },
  { label: 'Fix grammar', instruction: 'Fix grammar and spelling in the selected section' },
  { label: 'Make shorter', instruction: 'Make the selected section more concise' },
  { label: 'Make longer', instruction: 'Expand the selected section with more detail' },
  { label: 'Summarize', instruction: 'Summarize the selected section as a single paragraph' },
];

export function SelectionToolbar({
  anchorRect,
  selectedText: _selectedText,
  onAction,
  onDismiss,
  isPending = false,
}: SelectionToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Compute toolbar position: centered above the anchor rect
  const toolbarTop = anchorRect.top + window.scrollY - 48;
  const toolbarLeft = anchorRect.left + anchorRect.width / 2;

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [onDismiss]);

  return (
    <Portal>
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="AI quick-edit actions"
        data-testid="selection-toolbar"
        className="fixed z-[60] flex items-center gap-0.5 rounded-lg bg-slate-900 px-1.5 py-1 shadow-xl ring-1 ring-black/10"
        style={{
          top: Math.max(toolbarTop, 8),
          left: toolbarLeft,
          transform: 'translateX(-50%)',
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        {ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={isPending}
            onClick={() => onAction(`${action.instruction}:\n\n${_selectedText}`)}
            data-testid={`selection-action-${action.label.toLowerCase().replace(/\s+/g, '-')}`}
            className="rounded px-2 py-1 text-[11px] font-medium text-white hover:bg-white/20 active:bg-white/30 disabled:cursor-not-allowed disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            {isPending ? '…' : action.label}
          </button>
        ))}
      </div>
    </Portal>
  );
}
