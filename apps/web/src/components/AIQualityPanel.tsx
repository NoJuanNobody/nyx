import { useState, useEffect, useRef } from 'react';
import { analyzeSpecQuality } from '../lib/api';

interface AIQualityPanelProps {
  content: string;
}

function ScoreBadge({ score }: { score: number }) {
  let color = 'bg-red-100 text-red-700';
  if (score >= 7) color = 'bg-green-100 text-green-700';
  else if (score >= 4) color = 'bg-amber-100 text-amber-700';

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${color}`}>
      {score}/10
    </span>
  );
}

export function AIQualityPanel({ content }: AIQualityPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ score: number; suggestions: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastContentRef = useRef('');

  useEffect(() => {
    if (!content || content.length < 20) return;
    if (content === lastContentRef.current) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      lastContentRef.current = content;
      setLoading(true);
      setError(null);
      try {
        const data = await analyzeSpecQuality(content);
        setResult(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Analysis failed');
      } finally {
        setLoading(false);
      }
    }, 3000);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [content]);

  return (
    <div className="border-t border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between px-4 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-900">AI Quality</span>
          {result && !loading && <ScoreBadge score={result.score} />}
          {loading && (
            <span className="text-xs text-slate-400">Analyzing...</span>
          )}
        </div>
        <svg
          className={`h-3 w-3 text-slate-400 transition-transform ${collapsed ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {!collapsed && (
        <div className="px-4 pb-3">
          {error && (
            <p className="text-xs text-red-500">{error}</p>
          )}
          {!result && !loading && !error && (
            <p className="text-xs text-slate-400">
              Start writing to see quality analysis.
            </p>
          )}
          {result && !loading && (
            <div className="space-y-2">
              {result.suggestions.length > 0 && (
                <ul className="space-y-1">
                  {result.suggestions.map((s, i) => (
                    <li key={i} className="flex gap-2 text-xs text-slate-600">
                      <span className="flex-shrink-0 text-slate-400">&bull;</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              )}
              {result.suggestions.length === 0 && (
                <p className="text-xs text-green-600">No suggestions — looking good!</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
