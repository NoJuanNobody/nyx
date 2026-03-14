import { useState, useEffect } from 'react';
import { Modal } from './Modal';
import { formatFeedback, submitFeedback } from '../lib/api';
import type { FormattedFeedback } from '../lib/api';

interface FeedbackModalProps {
  open: boolean;
  onClose: () => void;
}

type Step = 'write' | 'formatting' | 'preview' | 'submitting' | 'success' | 'error';

export function FeedbackModal({ open, onClose }: FeedbackModalProps) {
  const [step, setStep] = useState<Step>('write');
  const [rawMessage, setRawMessage] = useState('');
  const [formatted, setFormatted] = useState<FormattedFeedback | null>(null);
  const [editedTitle, setEditedTitle] = useState('');
  const [editedBody, setEditedBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [githubUrl, setGithubUrl] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep('write');
      setRawMessage('');
      setFormatted(null);
      setEditedTitle('');
      setEditedBody('');
      setError(null);
      setGithubUrl(null);
    }
  }, [open]);

  const handleFormat = async () => {
    if (!rawMessage.trim()) return;
    setStep('formatting');
    setError(null);

    try {
      const result = await formatFeedback(rawMessage.trim());
      setFormatted(result);
      setEditedTitle(result.title);
      setEditedBody(result.body);
      setStep('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to format feedback');
      setStep('write');
    }
  };

  const handleSubmit = async () => {
    if (!formatted) return;
    setStep('submitting');
    setError(null);

    try {
      const result = await submitFeedback({
        rawMessage,
        title: editedTitle,
        body: editedBody,
        category: formatted.category,
      });
      setGithubUrl(result.githubIssueUrl);
      setStep('success');
      // Auto-close after showing success
      setTimeout(() => {
        onClose();
      }, 3000);
    } catch (err) {
      if (err instanceof Error && err.message.includes('429')) {
        setError('You\'ve reached the daily feedback limit (5/day). Please try again tomorrow.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to submit feedback');
      }
      setStep('preview');
    }
  };

  const handleBack = () => {
    setStep('write');
    setError(null);
  };

  return (
    <Modal open={open} onClose={onClose} title="Send Feedback">
      {step === 'write' && (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            Share your thoughts — bug reports, feature ideas, or anything else. AI will format it into a clean ticket for our team.
          </p>
          <textarea
            value={rawMessage}
            onChange={(e) => setRawMessage(e.target.value)}
            placeholder="e.g. The diff view is hard to read on mobile, or I'd love to be able to export to Notion..."
            rows={5}
            maxLength={5000}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
            data-testid="feedback-input"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">{rawMessage.length}/5000</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleFormat}
                disabled={!rawMessage.trim()}
                className="rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                data-testid="feedback-format-btn"
              >
                Format with AI
              </button>
            </div>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {step === 'formatting' && (
        <div className="flex flex-col items-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          <p className="mt-3 text-sm text-slate-500">Formatting your feedback...</p>
        </div>
      )}

      {step === 'preview' && formatted && (
        <div className="space-y-4">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <label className="block text-sm font-medium text-slate-700">Title</label>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                {formatted.category}
              </span>
            </div>
            <input
              type="text"
              value={editedTitle}
              onChange={(e) => setEditedTitle(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              data-testid="feedback-title"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
            <textarea
              value={editedBody}
              onChange={(e) => setEditedBody(e.target.value)}
              rows={8}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
              data-testid="feedback-body"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <p className="text-xs text-slate-400">
            This will be submitted as a GitHub issue visible to the Nyx team.
          </p>
          <div className="flex justify-between">
            <button
              type="button"
              onClick={handleBack}
              className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Back
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!editedTitle.trim() || !editedBody.trim()}
                className="rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                data-testid="feedback-submit-btn"
              >
                Submit Feedback
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'submitting' && (
        <div className="flex flex-col items-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          <p className="mt-3 text-sm text-slate-500">Submitting your feedback...</p>
        </div>
      )}

      {step === 'success' && (
        <div className="text-center py-6">
          <div className="mb-2 text-green-600">
            <svg className="mx-auto h-8 w-8" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-900 mb-1">Thank you for your feedback!</p>
          <p className="text-xs text-slate-500 mb-2">Your feedback has been submitted to the Nyx team.</p>
          {githubUrl && (
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:text-blue-700 underline"
              data-testid="feedback-github-link"
            >
              View on GitHub
            </a>
          )}
        </div>
      )}
    </Modal>
  );
}
