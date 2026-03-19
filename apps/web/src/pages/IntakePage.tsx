import { useState } from 'react';
import { useAuthStore } from '../stores/auth.store';
import {
  processIntake,
  clarifyIntake,
  createDocument,
  checkSprintCapacity,
  type IntakeSpec,
  type SprintCheckResult,
} from '../lib/api';

type Phase = 'input' | 'processing' | 'result' | 'clarifying' | 'saved' | 'sprint-warning';

export function IntakePage() {
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const [rawInput, setRawInput] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [spec, setSpec] = useState<IntakeSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [savedDocId, setSavedDocId] = useState<string | null>(null);
  const [sprintCheck, setSprintCheck] = useState<SprintCheckResult | null>(null);

  const handleProcess = async () => {
    if (!rawInput.trim() || !currentTeamId) return;

    setPhase('processing');
    setError(null);
    try {
      const result = await processIntake({ rawInput: rawInput.trim(), teamId: currentTeamId });
      setSpec(result.spec);
      if (result.spec.confidence === 'low' && result.spec.openQuestions.length > 0) {
        setAnswers(new Array(result.spec.openQuestions.length).fill(''));
        setPhase('clarifying');
      } else {
        setPhase('result');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Processing failed');
      setPhase('input');
    }
  };

  const handleClarify = async () => {
    if (!spec || !currentTeamId) return;

    setPhase('processing');
    setError(null);
    try {
      const result = await clarifyIntake({
        rawInput: rawInput.trim(),
        questions: spec.openQuestions,
        answers,
        teamId: currentTeamId,
      });
      setSpec(result.spec);
      setPhase('result');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clarification failed');
      setPhase('result');
    }
  };

  const handleSkipClarification = () => {
    setPhase('result');
  };

  const handleSaveAsDocument = async () => {
    if (!spec || !currentTeamId) return;

    setError(null);
    try {
      // Check sprint capacity before saving
      const check = await checkSprintCapacity({ teamId: currentTeamId, newTicketWeight: 15 });
      if (check.overThreshold) {
        setSprintCheck(check);
        setPhase('sprint-warning');
        return;
      }

      await saveDocument();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save document');
    }
  };

  const saveDocument = async () => {
    if (!spec || !currentTeamId) return;

    setError(null);
    try {
      const doc = await createDocument({
        title: spec.title,
        content: spec.markdown,
        teamId: currentTeamId,
      });
      setSavedDocId(doc.id);
      setSprintCheck(null);
      setPhase('saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save document');
    }
  };

  const handleReset = () => {
    setRawInput('');
    setSpec(null);
    setError(null);
    setAnswers([]);
    setSavedDocId(null);
    setPhase('input');
  };

  const confidenceBadge = (confidence: string) => {
    const colors: Record<string, string> = {
      high: 'bg-green-100 text-green-800',
      medium: 'bg-yellow-100 text-yellow-800',
      low: 'bg-red-100 text-red-800',
    };
    return (
      <span
        className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${colors[confidence] || colors.low}`}
        data-testid="confidence-badge"
      >
        {confidence}
      </span>
    );
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-8" data-testid="intake-page">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Chaos Ingestion</h1>
        <p className="mt-1 text-sm text-slate-500">
          Paste raw, unstructured input and get back a structured spec with user stories,
          acceptance criteria, and edge cases.
        </p>
      </div>

      {error && (
        <div
          className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
          data-testid="intake-error"
        >
          {error}
        </div>
      )}

      {/* Input Phase */}
      {(phase === 'input' || phase === 'processing') && (
        <div data-testid="intake-input-section">
          <label
            htmlFor="raw-input"
            className="mb-2 block text-sm font-medium text-slate-700"
          >
            Raw Input
          </label>
          <textarea
            id="raw-input"
            value={rawInput}
            onChange={(e) => setRawInput(e.target.value)}
            placeholder="Paste your Slack messages, meeting notes, feature requests, or any unstructured input here..."
            className="h-64 w-full rounded-lg border border-slate-300 bg-white p-4 text-sm text-slate-900 placeholder-slate-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            disabled={phase === 'processing'}
            data-testid="raw-input-textarea"
          />
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={handleProcess}
              disabled={!rawInput.trim() || phase === 'processing' || !currentTeamId}
              className="rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="process-button"
            >
              {phase === 'processing' ? 'Processing...' : 'Process'}
            </button>
          </div>
        </div>
      )}

      {/* Clarification Phase */}
      {phase === 'clarifying' && spec && (
        <div data-testid="intake-clarification-section">
          <div className="mb-4 rounded-lg border border-yellow-200 bg-yellow-50 p-4">
            <h2 className="text-sm font-semibold text-yellow-800">
              Clarification Needed
            </h2>
            <p className="mt-1 text-sm text-yellow-700">
              The input was too vague to generate a high-confidence spec. Please answer the
              following questions to improve the output.
            </p>
          </div>

          <div className="space-y-4">
            {spec.openQuestions.map((question, i) => (
              <div key={i}>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  {question}
                </label>
                <input
                  type="text"
                  value={answers[i] || ''}
                  onChange={(e) => {
                    const next = [...answers];
                    next[i] = e.target.value;
                    setAnswers(next);
                  }}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
                  placeholder="Your answer..."
                  data-testid={`clarification-input-${i}`}
                />
              </div>
            ))}
          </div>

          <div className="mt-6 flex gap-3 justify-end">
            <button
              type="button"
              onClick={handleSkipClarification}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              data-testid="skip-clarification-button"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={handleClarify}
              className="rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
              data-testid="clarify-button"
            >
              Re-process with Answers
            </button>
          </div>
        </div>
      )}

      {/* Result Phase */}
      {(phase === 'result' || phase === 'saved' || phase === 'sprint-warning') && spec && (
        <div data-testid="intake-result-section">
          <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2
                className="text-lg font-semibold text-slate-900"
                data-testid="spec-title"
              >
                {spec.title}
              </h2>
              {confidenceBadge(spec.confidence)}
            </div>

            <div className="space-y-6 px-6 py-5">
              {/* User Story */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">User Story</h3>
                <p
                  className="rounded-md bg-slate-50 p-3 text-sm text-slate-600 italic"
                  data-testid="user-story"
                >
                  {spec.userStory}
                </p>
              </div>

              {/* Acceptance Criteria */}
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-700">
                  Acceptance Criteria
                </h3>
                <ul
                  className="space-y-1.5"
                  data-testid="acceptance-criteria-list"
                >
                  {spec.acceptanceCriteria.map((criterion, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 rounded-md bg-slate-50 p-2.5 text-sm text-slate-600"
                    >
                      <svg
                        className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={2}
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4.5 12.75l6 6 9-13.5"
                        />
                      </svg>
                      {criterion}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Edge Cases */}
              {spec.edgeCases.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-700">
                    Edge Cases
                  </h3>
                  <ul
                    className="space-y-1.5"
                    data-testid="edge-cases-list"
                  >
                    {spec.edgeCases.map((edge, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 rounded-md bg-orange-50 p-2.5 text-sm text-slate-600"
                      >
                        <svg
                          className="mt-0.5 h-4 w-4 flex-shrink-0 text-orange-500"
                          fill="none"
                          viewBox="0 0 24 24"
                          strokeWidth={2}
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
                          />
                        </svg>
                        {edge}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Open Questions */}
              {spec.openQuestions.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-700">
                    Open Questions
                  </h3>
                  <ul
                    className="space-y-1.5"
                    data-testid="open-questions-list"
                  >
                    {spec.openQuestions.map((q, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 rounded-md bg-blue-50 p-2.5 text-sm text-slate-600"
                      >
                        <svg
                          className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-500"
                          fill="none"
                          viewBox="0 0 24 24"
                          strokeWidth={2}
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z"
                          />
                        </svg>
                        {q}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Sprint capacity warning */}
            {phase === 'sprint-warning' && sprintCheck && (
              <div className="border-t border-amber-200 bg-amber-50 px-6 py-4">
                <div className="flex items-start gap-3">
                  <svg className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-amber-800">
                      Sprint at {sprintCheck.capacity.capacityPercent}% capacity
                    </p>
                    <p className="mt-1 text-sm text-amber-700">
                      Adding this document may overload your team's review bandwidth.
                    </p>
                    {sprintCheck.suggestions.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {sprintCheck.suggestions.slice(0, 3).map((s, i) => (
                          <li key={i} className="text-xs text-amber-600">{s}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between border-t border-slate-200 px-6 py-4">
              <button
                type="button"
                onClick={handleReset}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                data-testid="new-intake-button"
              >
                New Intake
              </button>
              {phase === 'saved' ? (
                <a
                  href={`/documents/${savedDocId}`}
                  className="rounded-lg bg-green-600 px-6 py-2 text-sm font-medium text-white hover:bg-green-700"
                  data-testid="view-document-link"
                >
                  View Document
                </a>
              ) : phase === 'sprint-warning' ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPhase('result')}
                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Go Back
                  </button>
                  <button
                    type="button"
                    onClick={saveDocument}
                    className="rounded-lg bg-amber-600 px-6 py-2 text-sm font-medium text-white shadow-sm hover:bg-amber-700"
                  >
                    Save Anyway
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleSaveAsDocument}
                  className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
                  data-testid="save-as-document-button"
                >
                  Save as Document
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
