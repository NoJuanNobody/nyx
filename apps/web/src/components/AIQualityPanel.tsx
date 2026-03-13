import { useState, useEffect, useRef } from 'react';
import { analyzeSpecQuality } from '../lib/api';

interface AIQualityPanelProps {
  content: string;
  stage?: string | null;
}

function ScoreRing({ score }: { score: number }) {
  const color =
    score >= 7 ? 'text-green-500' :
    score >= 4 ? 'text-amber-500' :
    'text-red-500';
  const bgColor =
    score >= 7 ? 'bg-green-50' :
    score >= 4 ? 'bg-amber-50' :
    'bg-red-50';
  const pct = (score / 10) * 100;

  return (
    <div className={`relative inline-flex items-center justify-center h-10 w-10 rounded-full ${bgColor}`}>
      <svg className="absolute inset-0 h-10 w-10 -rotate-90" viewBox="0 0 36 36">
        <circle
          cx="18" cy="18" r="15.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-slate-200"
        />
        <circle
          cx="18" cy="18" r="15.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeDasharray={`${pct} ${100 - pct}`}
          strokeLinecap="round"
          className={color}
        />
      </svg>
      <span className={`text-xs font-bold ${color}`}>{score}</span>
    </div>
  );
}

export function AIQualityPanel({ content, stage }: AIQualityPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ score: number; suggestions: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastContentRef = useRef('');
  const lastStageRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!content || content.length < 20) return;
    if (content === lastContentRef.current && stage === lastStageRef.current) return;

    // Show loading immediately when content changes
    setLoading(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      lastContentRef.current = content;
      lastStageRef.current = stage;
      setError(null);
      try {
        const data = await analyzeSpecQuality(content, stage);
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
  }, [content, stage]);

  const stageLabel = stage
    ? stage.charAt(0).toUpperCase() + stage.slice(1)
    : null;

  return (
    <div className="border-t border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between px-4 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-900">
            AI Quality{stageLabel ? ` (${stageLabel})` : ''}
          </span>
          {result && !loading && (
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                result.score >= 7 ? 'bg-green-100 text-green-700' :
                result.score >= 4 ? 'bg-amber-100 text-amber-700' :
                'bg-red-100 text-red-700'
              }`}
            >
              {result.score}/10
            </span>
          )}
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
            <div className="space-y-3">
              {/* Score display */}
              <div className="flex items-center gap-3">
                <ScoreRing score={result.score} />
                <div>
                  <p className="text-xs font-medium text-slate-700">
                    {result.score >= 7 ? 'Good quality' :
                     result.score >= 4 ? 'Needs improvement' :
                     'Significant issues'}
                  </p>
                  <p className="text-[10px] text-slate-400">
                    {result.suggestions.length} suggestion{result.suggestions.length !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>

              {/* Suggestions */}
              {result.suggestions.length > 0 && (
                <ul className="space-y-1.5 border-t border-slate-100 pt-2">
                  {result.suggestions.map((s, i) => (
                    <li key={i} className="flex gap-2 text-xs text-slate-600">
                      <span className="flex-shrink-0 mt-0.5 h-4 w-4 rounded-full bg-slate-100 text-[10px] font-medium text-slate-500 flex items-center justify-center">
                        {i + 1}
                      </span>
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
