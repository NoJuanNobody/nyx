import { useState, useEffect, useRef, useCallback } from 'react';
import { analyzeMeetingQuality, applyMeetingSuggestions } from '../lib/api';
import type { MeetingQualityResult } from '../lib/api';
import { MeetingAutoApply } from './MeetingAutoApply';

interface MeetingNoteQualityProps {
  documentId: string;
  content: string;
  onApply: (newContent: string) => void;
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

export function MeetingNoteQuality({ documentId: _documentId, content, onApply }: MeetingNoteQualityProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<MeetingQualityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastContentRef = useRef('');

  const fetchQuality = useCallback(async (analysisContent: string) => {
    setError(null);
    setLoading(true);
    try {
      const data = await analyzeMeetingQuality(analysisContent);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!content || content.length < 20) return;
    if (content === lastContentRef.current) return;

    setLoading(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      lastContentRef.current = content;
      fetchQuality(content);
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [content, fetchQuality]);

  const handleApplySuggestions = useCallback(
    async (selectedSuggestions: string[]) => {
      setApplying(true);
      setApplySuccess(false);
      try {
        const { content: newContent } = await applyMeetingSuggestions(content, selectedSuggestions);
        onApply(newContent);
        setApplySuccess(true);
        // Re-fetch quality after apply
        lastContentRef.current = newContent;
        await fetchQuality(newContent);
        // Clear success after 3s
        setTimeout(() => setApplySuccess(false), 3000);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to apply suggestions');
      } finally {
        setApplying(false);
      }
    },
    [content, onApply, fetchQuality],
  );

  const handleFixAll = useCallback(() => {
    if (result?.suggestions && result.suggestions.length > 0) {
      handleApplySuggestions(result.suggestions);
    }
  }, [result, handleApplySuggestions]);

  return (
    <div className="border-t border-slate-200 bg-white" data-testid="meeting-note-quality">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between px-4 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-900">
            Meeting Quality
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
            <p className="text-xs text-red-500 mb-2">{error}</p>
          )}
          {applySuccess && (
            <div className="mb-2 rounded-md bg-green-50 border border-green-200 px-3 py-1.5">
              <p className="text-xs font-medium text-green-700">
                Suggestions applied successfully!
              </p>
            </div>
          )}
          {!result && !loading && !error && (
            <p className="text-xs text-slate-400">
              Start writing to see meeting quality analysis.
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

              {/* Meeting metrics */}
              <div className="grid grid-cols-2 gap-2 border-t border-slate-100 pt-2">
                <div className="flex items-center gap-1.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-blue-50 text-[10px] text-blue-600">
                    D
                  </span>
                  <span className="text-[11px] text-slate-600">
                    {result.meetingMetrics.decisions} decision{result.meetingMetrics.decisions !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-violet-50 text-[10px] text-violet-600">
                    A
                  </span>
                  <span className="text-[11px] text-slate-600">
                    {result.meetingMetrics.actionItems} action item{result.meetingMetrics.actionItems !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-amber-50 text-[10px] text-amber-600">
                    C
                  </span>
                  <span className="text-[11px] text-slate-600">
                    {result.meetingMetrics.codeReferences} code ref{result.meetingMetrics.codeReferences !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-red-50 text-[10px] text-red-600">
                    Q
                  </span>
                  <span className="text-[11px] text-slate-600">
                    {result.meetingMetrics.openQuestions} open question{result.meetingMetrics.openQuestions !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>

              {/* Suggestions with auto-apply */}
              {result.suggestions.length > 0 && (
                <div className="border-t border-slate-100 pt-2">
                  {/* Fix All shortcut */}
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                      Suggestions
                    </span>
                    <button
                      type="button"
                      onClick={handleFixAll}
                      disabled={applying}
                      className="rounded-md bg-green-600 px-2.5 py-1 text-[11px] font-medium text-white
                        hover:bg-green-700 disabled:opacity-50 transition-colors"
                    >
                      {applying ? 'Fixing...' : 'Fix All'}
                    </button>
                  </div>
                  <MeetingAutoApply
                    suggestions={result.suggestions}
                    onApply={handleApplySuggestions}
                    isApplying={applying}
                  />
                </div>
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
