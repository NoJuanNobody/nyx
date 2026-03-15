import { useState, useEffect, useRef, useCallback } from 'react';
import type { DocumentTemplate } from '@nyx/shared';
import type { DocumentStage } from '../lib/stages';
import { fetchTemplates } from '../lib/api';

interface SlashCommandPaletteProps {
  position: { top: number; left: number };
  filter: string;
  teamId?: string;
  onSelect: (template: DocumentTemplate) => void;
  onClose: () => void;
}

const STAGE_COLORS: Record<DocumentStage, { bg: string; text: string }> = {
  conception: { bg: 'bg-violet-100 dark:bg-violet-900/40', text: 'text-violet-700 dark:text-violet-300' },
  definition: { bg: 'bg-blue-100 dark:bg-blue-900/40', text: 'text-blue-700 dark:text-blue-300' },
  architecture: { bg: 'bg-amber-100 dark:bg-amber-900/40', text: 'text-amber-700 dark:text-amber-300' },
  implementation: { bg: 'bg-emerald-100 dark:bg-emerald-900/40', text: 'text-emerald-700 dark:text-emerald-300' },
  execution: { bg: 'bg-rose-100 dark:bg-rose-900/40', text: 'text-rose-700 dark:text-rose-300' },
};

export function SlashCommandPalette({
  position,
  filter,
  teamId,
  onSelect,
  onClose,
}: SlashCommandPaletteProps) {
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch templates on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchTemplates(undefined, teamId)
      .then((data) => {
        if (!cancelled) {
          setTemplates(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load templates');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [teamId]);

  // Filter templates based on typed text after "/"
  const filtered = templates.filter((t) => {
    if (!filter) return true;
    const lower = filter.toLowerCase();
    return (
      t.name.toLowerCase().includes(lower) ||
      t.description.toLowerCase().includes(lower) ||
      t.stage.toLowerCase().includes(lower)
    );
  });

  // Reset selected index when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const items = listRef.current.querySelectorAll('[data-palette-item]');
      const active = items[selectedIndex];
      if (active) {
        active.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
        return;
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        if (filtered.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          onSelect(filtered[selectedIndex]);
        }
        return;
      }
    },
    [filtered, selectedIndex, onSelect, onClose],
  );

  useEffect(() => {
    // Use capture phase so we intercept before the textarea handles the event
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [handleKeyDown]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  return (
    <div
      ref={containerRef}
      className="absolute z-50 w-80 max-h-64 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-800"
      style={{ top: position.top, left: position.left }}
      data-testid="slash-command-palette"
    >
      {/* Header */}
      <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-700">
        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Templates
          {filter && (
            <span className="ml-1 text-slate-400 dark:text-slate-500">
              — filtering by "{filter}"
            </span>
          )}
        </p>
      </div>

      {/* List */}
      <div ref={listRef} className="max-h-52 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-6">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600 dark:border-slate-600 dark:border-t-slate-300" />
            <span className="ml-2 text-sm text-slate-500 dark:text-slate-400">Loading templates...</span>
          </div>
        )}

        {error && (
          <div className="px-3 py-4 text-center text-sm text-red-500 dark:text-red-400">
            {error}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="px-3 py-4 text-center text-sm text-slate-400 dark:text-slate-500">
            No templates found{filter ? ` matching "${filter}"` : ''}
          </div>
        )}

        {!loading &&
          !error &&
          filtered.map((template, index) => {
            const stageColor = STAGE_COLORS[template.stage as DocumentStage] ?? {
              bg: 'bg-slate-100 dark:bg-slate-700',
              text: 'text-slate-600 dark:text-slate-300',
            };

            return (
              <button
                key={template.id}
                data-palette-item
                type="button"
                className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors ${
                  index === selectedIndex
                    ? 'bg-blue-50 dark:bg-blue-900/30'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                }`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => onSelect(template)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                      {template.name}
                    </span>
                    <span
                      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${stageColor.bg} ${stageColor.text}`}
                    >
                      {template.stage}
                    </span>
                  </div>
                  {template.description && (
                    <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                      {template.description}
                    </p>
                  )}
                </div>
              </button>
            );
          })}
      </div>

      {/* Footer hint */}
      {!loading && filtered.length > 0 && (
        <div className="border-t border-slate-100 px-3 py-1.5 dark:border-slate-700">
          <p className="text-[10px] text-slate-400 dark:text-slate-500">
            <kbd className="rounded border border-slate-200 px-1 py-0.5 font-mono text-[10px] dark:border-slate-600">↑↓</kbd>
            {' '}navigate{' '}
            <kbd className="rounded border border-slate-200 px-1 py-0.5 font-mono text-[10px] dark:border-slate-600">↵</kbd>
            {' '}select{' '}
            <kbd className="rounded border border-slate-200 px-1 py-0.5 font-mono text-[10px] dark:border-slate-600">esc</kbd>
            {' '}dismiss
          </p>
        </div>
      )}
    </div>
  );
}
