import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ContextMatch, ContextSignal } from '../lib/api';

interface ContextMatchesProps {
  matches: ContextMatch[];
  signals: ContextSignal[];
  isLoading?: boolean;
}

const SIGNAL_STYLES: Record<
  ContextSignal['type'],
  { label: string; bg: string; text: string; border: string }
> = {
  recurring_pattern: {
    label: 'Recurring Pattern',
    bg: 'bg-green-50',
    text: 'text-green-700',
    border: 'border-green-200',
  },
  contradiction: {
    label: 'Contradiction',
    bg: 'bg-red-50',
    text: 'text-red-700',
    border: 'border-red-200',
  },
  scope_creep: {
    label: 'Scope Creep',
    bg: 'bg-yellow-50',
    text: 'text-yellow-700',
    border: 'border-yellow-200',
  },
};

const RELEVANCE_STYLES: Record<ContextMatch['relevance'], string> = {
  high: 'bg-blue-100 text-blue-800',
  medium: 'bg-slate-100 text-slate-700',
  low: 'bg-slate-50 text-slate-500',
};

const RELATIONSHIP_LABELS: Record<ContextMatch['relationship'], string> = {
  confirms: 'Confirms',
  contradicts: 'Contradicts',
  expands: 'Expands',
};

const RELATIONSHIP_STYLES: Record<ContextMatch['relationship'], string> = {
  confirms: 'bg-green-100 text-green-700',
  contradicts: 'bg-red-100 text-red-700',
  expands: 'bg-yellow-100 text-yellow-700',
};

export function ContextMatches({ matches, signals, isLoading }: ContextMatchesProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (isLoading) {
    return (
      <div className="mt-6" data-testid="context-matches-loading">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">
          Context
        </h3>
        <div className="animate-pulse space-y-3">
          <div className="h-16 rounded-lg bg-slate-100" />
          <div className="h-16 rounded-lg bg-slate-100" />
        </div>
      </div>
    );
  }

  if (matches.length === 0 && signals.length === 0) {
    return null;
  }

  return (
    <div className="mt-6" data-testid="context-matches">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="mb-3 flex w-full items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-700"
        data-testid="context-matches-toggle"
      >
        <svg
          className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
        Context ({matches.length} matches, {signals.length} signals)
      </button>

      {isExpanded && (
        <div className="space-y-4">
          {/* Signals */}
          {signals.length > 0 && (
            <div className="space-y-2" data-testid="context-signals">
              {signals.map((signal, idx) => {
                const style = SIGNAL_STYLES[signal.type];
                return (
                  <div
                    key={idx}
                    className={`rounded-lg border p-3 ${style.bg} ${style.border}`}
                    data-testid={`context-signal-${signal.type}`}
                  >
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${style.text} ${style.bg}`}
                    >
                      {style.label}
                    </span>
                    <p className={`mt-1 text-sm ${style.text}`}>{signal.description}</p>
                  </div>
                );
              })}
            </div>
          )}

          {/* Matches */}
          {matches.length > 0 && (
            <div className="space-y-2" data-testid="context-match-list">
              {matches.map((match) => (
                <div
                  key={match.documentId}
                  className="rounded-lg border border-slate-200 bg-white p-3"
                  data-testid={`context-match-${match.documentId}`}
                >
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/documents/${match.documentId}`}
                      className="text-sm font-medium text-blue-600 hover:underline"
                    >
                      {match.title}
                    </Link>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${RELEVANCE_STYLES[match.relevance]}`}
                    >
                      {match.relevance}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${RELATIONSHIP_STYLES[match.relationship]}`}
                    >
                      {RELATIONSHIP_LABELS[match.relationship]}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{match.summary}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
