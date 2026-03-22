import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchNotificationPreferences,
  updateNotificationPreference,
  type NotificationPreference,
} from '../lib/api';

// ── Event type metadata ──────────────────────────────────────────────

const EVENT_TYPES: { key: string; label: string; description: string }[] = [
  { key: 'drift.detected', label: 'Drift Detected', description: 'When code drifts from its linked spec.' },
  { key: 'ticket.created', label: 'Ticket Created', description: 'When a new ticket is created from a spec.' },
  { key: 'ticket.updated', label: 'Ticket Updated', description: 'When a linked ticket status changes.' },
  { key: 'change_proposal.submitted', label: 'Change Proposal Submitted', description: 'When a change proposal is submitted for review.' },
  { key: 'change_proposal.approved', label: 'Change Proposal Approved', description: 'When your change proposal is approved.' },
  { key: 'change_proposal.rejected', label: 'Change Proposal Rejected', description: 'When your change proposal is rejected.' },
  { key: 'approval.requested', label: 'Approval Requested', description: 'When a review is requested on a doc branch.' },
  { key: 'document.shared', label: 'Document Shared', description: 'When a document is shared with you.' },
  { key: 'team.invite', label: 'Team Invitation', description: 'When you are invited to a team.' },
  { key: 'snapshot.created', label: 'Snapshot Published', description: 'When a named product snapshot is published.' },
  { key: 'comment.mention', label: 'Comment Mention', description: 'When you are mentioned in a document comment.' },
];

const EMAIL_MODES: { value: NotificationPreference['emailMode']; label: string }[] = [
  { value: 'instant', label: 'Instant' },
  { value: 'daily', label: 'Daily digest' },
  { value: 'weekly', label: 'Weekly digest' },
  { value: 'off', label: 'Off' },
];

// ── Component ────────────────────────────────────────────────────────

export function NotificationPreferences() {
  const queryClient = useQueryClient();
  const [flash, setFlash] = useState<string | null>(null);

  const { data: preferences, isLoading } = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: fetchNotificationPreferences,
  });

  const mutation = useMutation({
    mutationFn: ({ eventType, data }: { eventType: string; data: Partial<NotificationPreference> }) =>
      updateNotificationPreference(eventType, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
      setFlash('Preference saved');
      setTimeout(() => setFlash(null), 2000);
    },
  });

  // Build a map for quick lookup; fall back to defaults for missing event types
  const prefMap = new Map<string, NotificationPreference>();
  for (const p of preferences ?? []) {
    prefMap.set(p.eventType, p);
  }

  function getPref(eventType: string): NotificationPreference {
    return prefMap.get(eventType) ?? { eventType, inApp: true, emailEnabled: false, emailMode: 'off' };
  }

  function handleToggle(eventType: string, field: 'inApp' | 'emailEnabled', current: boolean) {
    const update: Partial<NotificationPreference> = { [field]: !current };
    // When disabling email, also set mode to off
    if (field === 'emailEnabled' && current) {
      update.emailMode = 'off';
    }
    // When enabling email, default mode to instant
    if (field === 'emailEnabled' && !current) {
      update.emailMode = 'instant';
    }
    mutation.mutate({ eventType, data: update });
  }

  function handleEmailMode(eventType: string, mode: NotificationPreference['emailMode']) {
    mutation.mutate({ eventType, data: { emailMode: mode } });
  }

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div data-testid="notification-preferences" className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Notification Preferences</h2>
          <p className="text-sm text-slate-500">Choose how you want to be notified about activity.</p>
        </div>
        {flash && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
            {flash}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-400">Loading preferences...</div>
      ) : (
        <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">
          {/* Header row */}
          <div className="grid grid-cols-[1fr_80px_80px_160px] items-center gap-4 px-5 py-3 text-xs font-medium uppercase tracking-wide text-slate-400">
            <span>Event</span>
            <span className="text-center">In-app</span>
            <span className="text-center">Email</span>
            <span>Email mode</span>
          </div>

          {EVENT_TYPES.map((evt) => {
            const pref = getPref(evt.key);
            return (
              <div
                key={evt.key}
                className="grid grid-cols-[1fr_80px_80px_160px] items-center gap-4 px-5 py-3.5 hover:bg-slate-50/60 transition-colors"
              >
                {/* Label + description */}
                <div>
                  <p className="text-sm font-medium text-slate-800">{evt.label}</p>
                  <p className="text-xs text-slate-400">{evt.description}</p>
                </div>

                {/* In-app toggle */}
                <div className="flex justify-center">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={pref.inApp}
                    aria-label={`In-app notifications for ${evt.label}`}
                    onClick={() => handleToggle(evt.key, 'inApp', pref.inApp)}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
                      pref.inApp ? 'bg-blue-600' : 'bg-slate-200'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform ${
                        pref.inApp ? 'translate-x-4' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Email toggle */}
                <div className="flex justify-center">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={pref.emailEnabled}
                    aria-label={`Email notifications for ${evt.label}`}
                    onClick={() => handleToggle(evt.key, 'emailEnabled', pref.emailEnabled)}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
                      pref.emailEnabled ? 'bg-blue-600' : 'bg-slate-200'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform ${
                        pref.emailEnabled ? 'translate-x-4' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Email mode dropdown */}
                <select
                  value={pref.emailMode}
                  disabled={!pref.emailEnabled}
                  onChange={(e) => handleEmailMode(evt.key, e.target.value as NotificationPreference['emailMode'])}
                  className={`rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm transition-colors focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 ${
                    !pref.emailEnabled ? 'cursor-not-allowed opacity-40' : 'text-slate-700'
                  }`}
                >
                  {EMAIL_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}

      {mutation.isError && (
        <p className="text-sm text-red-600">
          Failed to save preference. Please try again.
        </p>
      )}
    </div>
  );
}
