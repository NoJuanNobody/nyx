import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { joinCall, leaveCall, createMeetingDocument, type VoiceSession } from '../lib/api';
import { useAuthStore } from '../stores/auth.store';

type Platform = 'zoom' | 'google_meet' | 'teams';

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: 'zoom', label: 'Zoom' },
  { value: 'google_meet', label: 'Google Meet' },
  { value: 'teams', label: 'Microsoft Teams' },
];

function formatDuration(startedAt: string): string {
  const seconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const STATE_LABELS: Record<string, { label: string; color: string }> = {
  idle: { label: 'Idle', color: 'bg-slate-100 text-slate-600' },
  connecting: { label: 'Connecting...', color: 'bg-amber-100 text-amber-700' },
  in_call: { label: 'In Call', color: 'bg-green-100 text-green-700' },
  disconnecting: { label: 'Disconnecting...', color: 'bg-amber-100 text-amber-700' },
  ended: { label: 'Ended', color: 'bg-slate-100 text-slate-600' },
  error: { label: 'Error', color: 'bg-red-100 text-red-700' },
};

export function VoicePage() {
  const navigate = useNavigate();
  const currentTeamId = useAuthStore((s) => s.currentTeamId);

  const [platform, setPlatform] = useState<Platform>('zoom');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [session, setSession] = useState<VoiceSession | null>(null);
  const [duration, setDuration] = useState('0:00');
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const eventSourceRef = useRef<EventSource>();

  // Duration timer
  useEffect(() => {
    if (session?.state === 'in_call') {
      timerRef.current = setInterval(() => {
        setDuration(formatDuration(session.startedAt));
      }, 1000);
    }
    return () => clearInterval(timerRef.current);
  }, [session?.state, session?.startedAt]);

  // SSE status stream
  useEffect(() => {
    if (!session?.id) return;
    const es = new EventSource(`/api/voice/status/${session.id}`);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === 'state_change' && event.to) {
          setSession((prev) => prev ? { ...prev, state: event.to } : prev);
        }
        if (event.type === 'error') {
          setError(event.error);
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      es.close();
    };

    return () => es.close();
  }, [session?.id]);

  const joinMutation = useMutation({
    mutationFn: () => joinCall(platform, meetingUrl),
    onSuccess: ({ session: s }) => {
      setSession(s);
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to join call');
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () => leaveCall(session!.id),
    onSuccess: ({ session: s }) => {
      setSession(s);
      clearInterval(timerRef.current);
      eventSourceRef.current?.close();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to leave call');
    },
  });

  const docMutation = useMutation({
    mutationFn: () => createMeetingDocument(session!.id, currentTeamId ?? ''),
    onSuccess: ({ documentId }) => {
      navigate(`/documents/${documentId}`);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to generate document');
    },
  });

  const isActive = session && ['connecting', 'in_call', 'disconnecting'].includes(session.state);
  const isEnded = session && ['ended', 'error'].includes(session.state);
  const stateInfo = session ? STATE_LABELS[session.state] ?? STATE_LABELS.idle : null;

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-900">Voice</h1>
        <p className="mt-1 text-sm text-slate-500">
          Join a meeting to capture decisions, action items, and context automatically.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 font-medium underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Join form — shown when no active session */}
      {!isActive && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold text-slate-700">Join a Meeting</h2>

          <div className="space-y-4">
            {/* Platform select */}
            <div>
              <label htmlFor="platform" className="mb-1 block text-sm font-medium text-slate-600">
                Platform
              </label>
              <div className="flex gap-2">
                {PLATFORMS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setPlatform(p.value)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      platform === p.value
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                    }`}
                    data-testid={`platform-${p.value}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Meeting URL */}
            <div>
              <label htmlFor="meeting-url" className="mb-1 block text-sm font-medium text-slate-600">
                Meeting URL
              </label>
              <input
                id="meeting-url"
                type="url"
                value={meetingUrl}
                onChange={(e) => setMeetingUrl(e.target.value)}
                placeholder="https://zoom.us/j/123456789"
                className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
                disabled={joinMutation.isPending}
                data-testid="meeting-url-input"
              />
            </div>

            {/* Join button */}
            <button
              type="button"
              onClick={() => joinMutation.mutate()}
              disabled={!meetingUrl.trim() || joinMutation.isPending}
              className="w-full rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="join-call-button"
            >
              {joinMutation.isPending ? 'Joining...' : 'Join Meeting'}
            </button>
          </div>
        </div>
      )}

      {/* Active call view */}
      {isActive && session && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-700">Active Session</h2>
            {stateInfo && (
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${stateInfo.color}`}>
                {stateInfo.label}
              </span>
            )}
          </div>

          <div className="space-y-3 mb-6">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Platform</span>
              <span className="font-medium text-slate-900">
                {PLATFORMS.find((p) => p.value === session.platform)?.label}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Duration</span>
              <span className="font-mono font-medium text-slate-900">{duration}</span>
            </div>
            <div className="text-sm">
              <span className="text-slate-500">URL</span>
              <p className="mt-0.5 truncate font-medium text-slate-900">{session.meetingUrl}</p>
            </div>
          </div>

          {session.state === 'in_call' && (
            <div className="flex items-center gap-3 rounded-lg bg-green-50 border border-green-200 px-4 py-3 mb-6">
              <div className="h-2.5 w-2.5 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-medium text-green-700">
                Recording &mdash; capturing transcript
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={() => leaveMutation.mutate()}
            disabled={leaveMutation.isPending || session.state === 'disconnecting'}
            className="w-full rounded-lg bg-red-600 px-6 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="leave-call-button"
          >
            {leaveMutation.isPending ? 'Leaving...' : 'Leave Meeting'}
          </button>
        </div>
      )}

      {/* Post-call actions */}
      {isEnded && session && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-700">Meeting Ended</h2>
            {stateInfo && (
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${stateInfo.color}`}>
                {stateInfo.label}
              </span>
            )}
          </div>

          <p className="mb-4 text-sm text-slate-600">
            Generate a meeting document with extracted decisions, action items, and code references.
          </p>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => docMutation.mutate()}
              disabled={docMutation.isPending}
              className="flex-1 rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="generate-doc-button"
            >
              {docMutation.isPending ? 'Generating...' : 'Generate Meeting Notes'}
            </button>
            <button
              type="button"
              onClick={() => {
                setSession(null);
                setMeetingUrl('');
                setDuration('0:00');
              }}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              New Meeting
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
