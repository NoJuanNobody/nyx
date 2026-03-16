import { useState, useCallback } from 'react';

interface MeetingAutoApplyProps {
  suggestions: string[];
  onApply: (selectedSuggestions: string[]) => void;
  isApplying: boolean;
}

export function MeetingAutoApply({ suggestions, onApply, isApplying }: MeetingAutoApplyProps) {
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(
    () => new Set(suggestions.map((_, i) => i)),
  );
  const [rejectedIndices, setRejectedIndices] = useState<Set<number>>(new Set());

  const toggleSelect = useCallback((index: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
    // Un-reject if selecting
    setRejectedIndices((prev) => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
  }, []);

  const acceptSuggestion = useCallback((index: number) => {
    setSelectedIndices((prev) => new Set(prev).add(index));
    setRejectedIndices((prev) => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
  }, []);

  const rejectSuggestion = useCallback((index: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
    setRejectedIndices((prev) => new Set(prev).add(index));
  }, []);

  const activeSuggestions = suggestions.filter((_, i) => !rejectedIndices.has(i));
  const allSelected =
    activeSuggestions.length > 0 &&
    suggestions.every((_, i) => rejectedIndices.has(i) || selectedIndices.has(i));

  const selectAll = useCallback(() => {
    setSelectedIndices(new Set(suggestions.map((_, i) => i).filter((i) => !rejectedIndices.has(i))));
  }, [suggestions, rejectedIndices]);

  const deselectAll = useCallback(() => {
    setSelectedIndices(new Set());
  }, []);

  const handleApply = useCallback(() => {
    const selected = suggestions.filter((_, i) => selectedIndices.has(i));
    if (selected.length > 0) {
      onApply(selected);
    }
  }, [suggestions, selectedIndices, onApply]);

  return (
    <div className="space-y-2">
      {/* Select All / Deselect All toggle */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={allSelected ? deselectAll : selectAll}
          className="text-xs font-medium text-blue-600 hover:text-blue-700"
        >
          {allSelected ? 'Deselect All' : 'Select All'}
        </button>
        <span className="text-[10px] text-slate-400">
          {selectedIndices.size} of {suggestions.length} selected
        </span>
      </div>

      {/* Suggestion list */}
      <ul className="space-y-1.5">
        {suggestions.map((suggestion, index) => {
          const isSelected = selectedIndices.has(index);
          const isRejected = rejectedIndices.has(index);

          return (
            <li
              key={index}
              className={`flex items-start gap-2 rounded-md border p-2 transition-colors ${
                isRejected
                  ? 'border-slate-100 bg-slate-50 opacity-50'
                  : isSelected
                    ? 'border-blue-200 bg-blue-50/50'
                    : 'border-slate-200 bg-white'
              }`}
            >
              {/* Checkbox */}
              <input
                type="checkbox"
                checked={isSelected}
                disabled={isRejected}
                onChange={() => toggleSelect(index)}
                className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 rounded border-slate-300 text-blue-600
                  focus:ring-blue-500 disabled:opacity-40"
              />

              {/* Suggestion text */}
              <span
                className={`flex-1 text-xs ${
                  isRejected ? 'text-slate-400 line-through' : 'text-slate-600'
                }`}
              >
                {suggestion}
              </span>

              {/* Accept / Reject buttons */}
              <div className="flex flex-shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => acceptSuggestion(index)}
                  title="Accept suggestion"
                  className={`rounded p-0.5 transition-colors ${
                    isSelected && !isRejected
                      ? 'text-green-600 bg-green-50'
                      : 'text-slate-400 hover:text-green-600 hover:bg-green-50'
                  }`}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => rejectSuggestion(index)}
                  title="Reject suggestion"
                  className={`rounded p-0.5 transition-colors ${
                    isRejected
                      ? 'text-red-600 bg-red-50'
                      : 'text-slate-400 hover:text-red-600 hover:bg-red-50'
                  }`}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Apply Selected button */}
      <button
        type="button"
        onClick={handleApply}
        disabled={selectedIndices.size === 0 || isApplying}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2
          text-xs font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
      >
        {isApplying && (
          <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {isApplying
          ? 'Applying...'
          : `Apply ${selectedIndices.size} Suggestion${selectedIndices.size !== 1 ? 's' : ''}`}
      </button>
    </div>
  );
}
