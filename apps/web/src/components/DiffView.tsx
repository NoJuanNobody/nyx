import { useMemo } from 'react';

interface DiffViewProps {
  oldText: string;
  newText: string;
  oldLabel?: string;
  newLabel?: string;
}

type DiffLine = { type: 'equal' | 'add' | 'remove'; content: string };

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;

  // LCS DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: 'equal', content: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'add', content: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'remove', content: oldLines[i - 1] });
      i--;
    }
  }

  return result;
}

/**
 * Two-column side-by-side diff rows. Used at >= md (>=768px).
 */
function SideBySideRows({ diff }: { diff: DiffLine[] }) {
  return (
    <>
      {diff.map((line, idx) => {
        if (line.type === 'equal') {
          return (
            <div key={idx} className="flex" data-testid="diff-row-side">
              <div className="flex-1 px-4 py-0.5 text-slate-600 whitespace-pre-wrap break-words">
                {line.content || '\u00A0'}
              </div>
              <div className="flex-1 px-4 py-0.5 text-slate-600 whitespace-pre-wrap break-words">
                {line.content || '\u00A0'}
              </div>
            </div>
          );
        }
        if (line.type === 'remove') {
          return (
            <div key={idx} className="flex" data-testid="diff-row-side">
              <div className="flex-1 px-4 py-0.5 bg-red-100 text-red-800 whitespace-pre-wrap break-words">
                {line.content || '\u00A0'}
              </div>
              <div className="flex-1 px-4 py-0.5" />
            </div>
          );
        }
        return (
          <div key={idx} className="flex" data-testid="diff-row-side">
            <div className="flex-1 px-4 py-0.5" />
            <div className="flex-1 px-4 py-0.5 bg-green-100 text-green-800 whitespace-pre-wrap break-words">
              {line.content || '\u00A0'}
            </div>
          </div>
        );
      })}
    </>
  );
}

/**
 * Unified single-column diff rows. Used at < md (<768px).
 * Each line renders once with a leading +, -, or space marker, and a
 * background colour matching the desktop two-column view.
 */
function UnifiedRows({ diff }: { diff: DiffLine[] }) {
  return (
    <>
      {diff.map((line, idx) => {
        const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
        const rowClass =
          line.type === 'add'
            ? 'bg-green-100 text-green-800'
            : line.type === 'remove'
              ? 'bg-red-100 text-red-800'
              : 'text-slate-600';
        return (
          <div
            key={idx}
            data-testid="diff-row-unified"
            data-diff-type={line.type}
            className={`flex px-3 py-0.5 ${rowClass}`}
          >
            <span
              aria-hidden="true"
              className="mr-2 w-3 flex-shrink-0 select-none font-mono"
            >
              {marker}
            </span>
            <span className="flex-1 whitespace-pre-wrap break-words">
              {line.content || '\u00A0'}
            </span>
          </div>
        );
      })}
    </>
  );
}

export function DiffView({ oldText, newText, oldLabel, newLabel }: DiffViewProps) {
  const diff = useMemo(() => computeDiff(oldText, newText), [oldText, newText]);
  const removeLabel = oldLabel ?? 'Old';
  const addLabel = newLabel ?? 'New';

  return (
    <div className="flex h-full flex-col">
      {/* Header — adapts between mobile pill row and desktop two-column labels */}
      <div className="border-b border-slate-200 text-xs font-medium text-slate-500">
        {/* Mobile compact pill row */}
        <div
          className="flex flex-wrap items-center gap-2 px-3 py-2 md:hidden"
          data-testid="diff-header-unified"
        >
          <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-800">
            <span aria-hidden="true">-</span>
            <span>{removeLabel}</span>
          </span>
          <span className="text-slate-400">/</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-800">
            <span aria-hidden="true">+</span>
            <span>{addLabel}</span>
          </span>
        </div>
        {/* Desktop two-column labels */}
        <div className="hidden md:flex" data-testid="diff-header-side">
          <div className="flex-1 bg-red-50 px-4 py-2">{removeLabel}</div>
          <div className="flex-1 bg-green-50 px-4 py-2">{addLabel}</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto font-mono text-sm">
        {/* Mobile unified single-column view */}
        <div className="md:hidden" data-testid="diff-view-unified">
          <UnifiedRows diff={diff} />
        </div>
        {/* Desktop side-by-side view */}
        <div className="hidden md:block" data-testid="diff-view-side">
          <SideBySideRows diff={diff} />
        </div>
      </div>
    </div>
  );
}
