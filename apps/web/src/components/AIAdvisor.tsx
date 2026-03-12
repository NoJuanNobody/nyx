import { useState, useEffect, useRef, useCallback } from 'react';
import { analyzeSpecQuality, editDocumentAI } from '../lib/api';
import { STAGE_MAP, type DocumentStage } from '../lib/stages';

// ── Notification types ───────────────────────────────────────────────

type NotificationTier = 1 | 2 | 3;
type NotificationStatus = 'idle' | 'loading' | 'success';

export interface NotificationCTA {
  label: string;
  variant: 'primary' | 'secondary' | 'ghost';
  onClick: () => void | Promise<void>;
}

export interface AdvisorNotification {
  id: string;
  tier: NotificationTier;
  type: string;
  title: string;
  body: string;
  status: NotificationStatus;
  successMessage?: string;
  ctas: NotificationCTA[];
  /** Tailwind bg-* class for the left accent strip (e.g. "bg-amber-400") */
  accentColor: string;
  replyEnabled?: boolean;
}

export interface AIAdvisorProps {
  content: string;
  stage?: DocumentStage | null;
  documentId?: string;
  onApplyEdit?: (content: string) => void;
  onStageChange?: (stage: DocumentStage) => void;
  onOpenAIChat?: (context?: Record<string, unknown>) => void;
}

// ── ID generator ─────────────────────────────────────────────────────

let _idCounter = 0;
function genId() {
  return `notif-${Date.now()}-${++_idCounter}`;
}

// ── Score badge ──────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 7 ? 'bg-green-100 text-green-700' :
    score >= 4 ? 'bg-amber-100 text-amber-700' :
    'bg-red-100 text-red-700';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${color}`}
      data-testid="ai-advisor-score"
    >
      Score: {score}/10
    </span>
  );
}

// ── Notification card ─────────────────────────────────────────────────

interface NotificationCardProps {
  notification: AdvisorNotification;
  onDismiss: () => void;
  onReply?: () => void;
  isReplying?: boolean;
}

function NotificationCard({ notification, onDismiss, onReply, isReplying }: NotificationCardProps) {
  const { title, body, ctas, status, successMessage, accentColor } = notification;
  const bodyLines = body.split('\n').filter(Boolean);

  return (
    <div
      className="flex overflow-hidden rounded-lg border border-slate-200 bg-white"
      data-testid={`advisor-notification-${notification.type}`}
    >
      {/* Left accent strip */}
      <div className={`w-1 flex-shrink-0 ${accentColor}`} />

      {/* Card content */}
      <div className="flex-1 px-3 pt-2.5 pb-2">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <span className="text-xs font-semibold text-slate-700 leading-snug">{title}</span>
          <button
            type="button"
            onClick={onDismiss}
            className="flex-shrink-0 rounded p-0.5 text-slate-300 hover:text-slate-600 transition-colors"
            aria-label="Dismiss notification"
            data-testid="advisor-dismiss-x"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        {status === 'loading' && (
          <p className="mt-1 text-xs text-slate-400">Processing…</p>
        )}
        {status === 'success' && (
          <p className="mt-1 text-xs text-green-600">{successMessage}</p>
        )}
        {status === 'idle' && bodyLines.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {bodyLines.map((line, i) => (
              <li key={i} className="flex gap-1.5 text-xs text-slate-600">
                <span className="flex-shrink-0 text-slate-400">•</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}

        {/* CTAs */}
        {status === 'idle' && ctas.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {ctas.map((cta, i) => (
              <button
                key={i}
                type="button"
                onClick={cta.onClick}
                className={
                  cta.variant === 'primary'
                    ? 'rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-700 transition-colors'
                    : cta.variant === 'secondary'
                    ? 'rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 transition-colors'
                    : 'text-[11px] font-medium text-slate-400 hover:text-slate-600 transition-colors'
                }
              >
                {cta.label}
              </button>
            ))}
            {onReply && (
              <button
                type="button"
                onClick={onReply}
                className={`text-[11px] font-medium transition-colors ${
                  isReplying ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                Reply
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main AIAdvisor component ──────────────────────────────────────────

export function AIAdvisor({
  content,
  stage,
  onApplyEdit,
}: AIAdvisorProps) {
  const [notifications, setNotifications] = useState<AdvisorNotification[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [qualityScore, setQualityScore] = useState<number | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastContentRef = useRef('');
  const lastStageRef = useRef<string | null | undefined>(undefined);
  const lastCollapseTimeRef = useRef<number | null>(null);
  const collapseCountRef = useRef(0);
  const isTypingRef = useRef(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Track typing to suppress auto-expand mid-keystroke ────────────
  useEffect(() => {
    isTypingRef.current = true;
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      isTypingRef.current = false;
    }, 2000);
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [content]);

  // ── Notification management helpers ───────────────────────────────

  const setNotifStatus = useCallback(
    (id: string, status: NotificationStatus, successMessage?: string) => {
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, status, ...(successMessage ? { successMessage } : {}) } : n)),
      );
      if (status === 'success') {
        setTimeout(() => {
          setNotifications((prev) => prev.filter((n) => n.id !== id));
          setReplyToId((rt) => (rt === id ? null : rt));
        }, 3000);
      }
    },
    [],
  );

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    setReplyToId((rt) => (rt === id ? null : rt));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
    setReplyToId(null);
    setExpanded(false);
  }, []);

  // ── Panel expand / collapse ───────────────────────────────────────

  const handleExpand = () => setExpanded(true);

  const handleCollapse = () => {
    setExpanded(false);
    lastCollapseTimeRef.current = Date.now();
    collapseCountRef.current += 1;
  };

  const canAutoExpand = () => {
    if (isTypingRef.current) return false;
    if (collapseCountRef.current >= 3) return false;
    if (lastCollapseTimeRef.current && Date.now() - lastCollapseTimeRef.current < 30_000) return false;
    return true;
  };

  // ── Auto-expand for Tier 2+ notifications ─────────────────────────
  useEffect(() => {
    const hasTier2Plus = notifications.some((n) => n.tier >= 2);
    if (hasTier2Plus && !expanded && canAutoExpand()) {
      setExpanded(true);
    }
  }, [notifications]); // eslint-disable-line

  // ── Stage guide notification (Tier 1) — replaces top banner ───────
  useEffect(() => {
    setNotifications((prev) => prev.filter((n) => n.type !== 'stage_guide'));

    if (!stage || !STAGE_MAP[stage]) return;

    const stageInfo = STAGE_MAP[stage];
    const id = genId();

    const stageNotif: AdvisorNotification = {
      id,
      tier: 1,
      type: 'stage_guide',
      title: `${stageInfo.label} — ${stageInfo.subtitle}`,
      body: `${stageInfo.who} · ${stageInfo.description}`,
      status: 'idle',
      accentColor: stageInfo.dotColor, // e.g. "bg-amber-400"
      ctas: [
        {
          label: 'Dismiss',
          variant: 'ghost',
          onClick: () => dismissNotification(id),
        },
      ],
    };

    setNotifications((prev) => {
      const tier23 = prev.filter((n) => n.tier > 1);
      const tier1Others = prev.filter((n) => n.tier === 1);
      return [...tier23, ...tier1Others, stageNotif];
    });
  }, [stage, dismissNotification]);

  // ── Quality analysis (Tier 1) — debounced on content change ───────
  useEffect(() => {
    if (!content || content.length < 20) return;
    if (content === lastContentRef.current && stage === lastStageRef.current) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      lastContentRef.current = content;
      lastStageRef.current = stage;
      setQualityLoading(true);

      try {
        const data = await analyzeSpecQuality(content, stage);
        setQualityScore(data.score);

        // Always replace existing quality notification
        const id = genId();
        const suggestions = data.suggestions;

        const qualityNotif: AdvisorNotification = {
          id,
          tier: 1,
          type: 'quality',
          title: `Quality analysis — Score: ${data.score}/10`,
          body: suggestions.join('\n'),
          status: 'idle',
          accentColor: 'bg-amber-400',
          ctas:
            suggestions.length > 0
              ? [
                  {
                    label: 'Fix these',
                    variant: 'primary',
                    onClick: async () => {
                      setNotifStatus(id, 'loading');
                      try {
                        const instruction = `Fix the following quality issues in this document:\n${suggestions.join('\n')}`;
                        const result = await editDocumentAI(content, instruction);
                        onApplyEdit?.(result.content);
                        setNotifStatus(id, 'success', 'Fixes applied — review the proposed changes in the editor');
                      } catch {
                        setNotifStatus(id, 'idle');
                      }
                    },
                  },
                  {
                    label: 'Dismiss',
                    variant: 'ghost',
                    onClick: () => dismissNotification(id),
                  },
                ]
              : [
                  {
                    label: 'Dismiss',
                    variant: 'ghost',
                    onClick: () => dismissNotification(id),
                  },
                ],
        };

        setNotifications((prev) => {
          const tier23 = prev.filter((n) => n.tier > 1);
          const tier1Others = prev.filter((n) => n.tier === 1 && n.type !== 'quality');
          return [...tier23, ...tier1Others, qualityNotif];
        });
      } catch {
        // Silently ignore analysis failures
      } finally {
        setQualityLoading(false);
      }
    }, 3000);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [content, stage, dismissNotification, setNotifStatus, onApplyEdit]);

  // ── Render ─────────────────────────────────────────────────────────

  const notificationCount = notifications.length;
  const visibleNotifications = notifications.slice(0, 3);
  const hasOverflow = notifications.length > 3;

  return (
    <div className="border-t border-slate-200 bg-white" data-testid="ai-advisor">
      {/* Status bar — always visible (~28px) */}
      <button
        type="button"
        onClick={expanded ? handleCollapse : handleExpand}
        className="flex w-full items-center justify-between px-4 text-left hover:bg-slate-50 transition-colors"
        style={{ minHeight: '28px', paddingTop: '4px', paddingBottom: '4px' }}
        aria-label={expanded ? 'Collapse AI Advisor' : 'Expand AI Advisor'}
        data-testid="ai-advisor-status-bar"
      >
        <div className="flex items-center gap-2">
          <span className="text-slate-400 text-xs" aria-hidden="true">✦</span>
          <span className="text-xs font-medium text-slate-600">AI Advisor</span>
          {notificationCount > 0 && !expanded && (
            <span
              className="inline-flex items-center rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700"
              data-testid="ai-advisor-badge"
            >
              {notificationCount}
            </span>
          )}
          {qualityLoading && (
            <span className="text-[10px] text-slate-400">Analyzing…</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {qualityScore !== null && <ScoreBadge score={qualityScore} />}
          <span className="text-[10px] text-slate-400 select-none">
            {expanded ? '▾ Collapse' : '▸ Expand'}
          </span>
        </div>
      </button>

      {/* Expanded panel */}
      {expanded && (
        <div data-testid="ai-advisor-panel">
          {/* Panel header with optional Clear all */}
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {notificationCount > 0
                ? `${notificationCount} notification${notificationCount > 1 ? 's' : ''}`
                : 'No notifications'}
            </span>
            {notificationCount >= 2 && (
              <button
                type="button"
                onClick={clearAll}
                className="text-[10px] text-slate-400 hover:text-slate-700 transition-colors"
                data-testid="ai-advisor-clear-all"
              >
                Clear all
              </button>
            )}
          </div>

          {/* Notification cards */}
          <div className="max-h-[40vh] overflow-y-auto px-4 pb-3 space-y-2">
            {notifications.length === 0 && (
              <p className="py-2 text-xs text-slate-400">
                No notifications — you're all caught up.
              </p>
            )}

            {visibleNotifications.map((notif) => (
              <NotificationCard
                key={notif.id}
                notification={notif}
                onDismiss={() => dismissNotification(notif.id)}
                onReply={notif.replyEnabled ? () => setReplyToId(notif.id) : undefined}
                isReplying={replyToId === notif.id}
              />
            ))}

            {hasOverflow && (
              <p className="text-center text-[10px] text-slate-400 py-1">
                + {notifications.length - 3} more · scroll to see all
              </p>
            )}
          </div>

          {/* Inline text reply input */}
          {replyToId && (
            <div className="border-t border-slate-100 px-4 pb-3 pt-2">
              <div className="flex items-end gap-2">
                <textarea
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Explain your intent to the AI…"
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  style={{ maxHeight: '72px' }}
                  data-testid="ai-advisor-reply-input"
                />
                <button
                  type="button"
                  onClick={() => {
                    setReplyToId(null);
                    setReplyText('');
                  }}
                  className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                  data-testid="ai-advisor-reply-send"
                >
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
