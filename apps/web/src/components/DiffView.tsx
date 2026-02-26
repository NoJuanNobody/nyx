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

export function DiffView({ oldText, newText, oldLabel, newLabel }: DiffViewProps) {
  const diff = useMemo(() => computeDiff(oldText, newText), [oldText, newText]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-slate-200 text-xs font-medium text-slate-500">
        <div className="flex-1 px-4 py-2 bg-red-50">{oldLabel ?? 'Old'}</div>
        <div className="flex-1 px-4 py-2 bg-green-50">{newLabel ?? 'New'}</div>
      </div>
      <div className="flex-1 overflow-y-auto font-mono text-sm">
        {diff.map((line, idx) => {
          if (line.type === 'equal') {
            return (
              <div key={idx} className="flex">
                <div className="flex-1 px-4 py-0.5 text-slate-600">{line.content || '\u00A0'}</div>
                <div className="flex-1 px-4 py-0.5 text-slate-600">{line.content || '\u00A0'}</div>
              </div>
            );
          }
          if (line.type === 'remove') {
            return (
              <div key={idx} className="flex">
                <div className="flex-1 px-4 py-0.5 bg-red-100 text-red-800">{line.content || '\u00A0'}</div>
                <div className="flex-1 px-4 py-0.5" />
              </div>
            );
          }
          return (
            <div key={idx} className="flex">
              <div className="flex-1 px-4 py-0.5" />
              <div className="flex-1 px-4 py-0.5 bg-green-100 text-green-800">{line.content || '\u00A0'}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
