import { useState, useEffect, useRef, useCallback } from 'react';
import {
  analyzeSpecQuality,
  editDocumentAI,
  seedFromStage,
  analyzeMissingSections,
  replyToNotification,
} from '../lib/api';
import { STAGE_MAP, getNextStage, type DocumentStage } from '../lib/stages';

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
  documentId,
  onApplyEdit,
  onStageChange,
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

    // Clear stale score immediately so the badge shows loading state
    setQualityLoading(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      lastContentRef.current = content;
      lastStageRef.current = stage;

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
          title: `Quality: ${data.score}/10`,
          body: suggestions.join('\n'),
          status: 'idle',
          accentColor: data.score >= 7 ? 'bg-green-400' : data.score >= 4 ? 'bg-amber-400' : 'bg-red-400',
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

  // ── Pre-fill offer notification (Tier 2) — offer to seed next stage ─
  const lastPrefillStageRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!stage || !content || content.length < 50) return;
    if (stage === lastPrefillStageRef.current) return;

    lastPrefillStageRef.current = stage;
    const nextStage = getNextStage(stage);
    if (!nextStage) return;

    const nextStageInfo = STAGE_MAP[nextStage];
    const id = genId();

    const prefillNotif: AdvisorNotification = {
      id,
      tier: 2,
      type: 'prefill_offer',
      title: `Ready to move to ${nextStageInfo.label}?`,
      body: `Your ${STAGE_MAP[stage].label} document can seed a ${nextStageInfo.label} document.\n${nextStageInfo.description}`,
      status: 'idle',
      accentColor: nextStageInfo.dotColor,
      replyEnabled: true,
      ctas: [
        {
          label: 'Generate next stage',
          variant: 'primary',
          onClick: async () => {
            setNotifStatus(id, 'loading');
            try {
              const result = await seedFromStage({
                documentId: documentId || '',
                fromStage: stage,
                toStage: nextStage,
                content,
              });
              onApplyEdit?.(result.content);
              if (onStageChange) {
                onStageChange(nextStage);
              }
              setNotifStatus(id, 'success', `${nextStageInfo.label} content generated — review in the editor`);
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
      ],
    };

    setNotifications((prev) => {
      const filtered = prev.filter((n) => n.type !== 'prefill_offer');
      return [prefillNotif, ...filtered];
    });
  }, [stage, content, documentId, dismissNotification, setNotifStatus, onApplyEdit, onStageChange]);

  // ── Missing sections alert (Tier 2) — check after quality runs ─────
  const lastMissingSectionsContentRef = useRef('');

  useEffect(() => {
    if (!content || content.length < 50) return;
    if (qualityLoading) return;
    if (qualityScore === null) return;
    if (content === lastMissingSectionsContentRef.current) return;

    lastMissingSectionsContentRef.current = content;

    const timer = setTimeout(async () => {
      try {
        const result = await analyzeMissingSections({ content, stage: stage || undefined });
        const missing = result.missingSections;
        if (missing.length === 0) {
          // Clear any existing missing_sections notification
          setNotifications((prev) => prev.filter((n) => n.type !== 'missing_sections'));
          return;
        }

        const id = genId();
        const highPriority = missing.filter((s) => s.priority === 'high');
        const bodyLines = missing
          .slice(0, 5)
          .map((s) => `[${s.priority}] ${s.name}: ${s.description}`);

        const missingNotif: AdvisorNotification = {
          id,
          tier: 2,
          type: 'missing_sections',
          title: `${missing.length} missing section${missing.length > 1 ? 's' : ''} detected`,
          body: bodyLines.join('\n'),
          status: 'idle',
          accentColor: highPriority.length > 0 ? 'bg-red-400' : 'bg-amber-400',
          replyEnabled: true,
          ctas: [
            {
              label: 'Add missing sections',
              variant: 'primary',
              onClick: async () => {
                setNotifStatus(id, 'loading');
                try {
                  const instruction = `Add the following missing sections to this document:\n${missing.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`;
                  const result = await editDocumentAI(content, instruction);
                  onApplyEdit?.(result.content);
                  setNotifStatus(id, 'success', 'Missing sections added — review the proposed changes');
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
          ],
        };

        setNotifications((prev) => {
          const filtered = prev.filter((n) => n.type !== 'missing_sections');
          return [missingNotif, ...filtered];
        });
      } catch {
        // Silently ignore missing sections analysis failures
      }
    }, 5000); // slightly delayed after quality analysis

    return () => clearTimeout(timer);
  }, [content, stage, qualityScore, qualityLoading, dismissNotification, setNotifStatus, onApplyEdit]);

  // ── Reply handler — send reply to notification-reply endpoint ───────
  const handleSendReply = useCallback(async () => {
    if (!replyToId || !replyText.trim()) return;

    const notif = notifications.find((n) => n.id === replyToId);
    if (!notif) return;

    const currentReplyToId = replyToId;
    setReplyToId(null);
    setReplyText('');

    try {
      const result = await replyToNotification({
        notificationId: currentReplyToId,
        message: replyText,
        documentId: documentId || '',
        content: content.slice(0, 2000),
      });

      // Create a new notification with the AI reply
      const replyNotifId = genId();
      const replyNotif: AdvisorNotification = {
        id: replyNotifId,
        tier: 2,
        type: 'ai_reply',
        title: 'AI Advisor Reply',
        body: result.reply + (result.suggestedActions.length > 0
          ? '\n\nSuggested actions:\n' + result.suggestedActions.join('\n')
          : ''),
        status: 'idle',
        accentColor: 'bg-blue-400',
        replyEnabled: true,
        ctas: [
          {
            label: 'Dismiss',
            variant: 'ghost',
            onClick: () => dismissNotification(replyNotifId),
          },
        ],
      };

      setNotifications((prev) => [replyNotif, ...prev]);
    } catch {
      // Silently ignore reply failures
    }
  }, [replyToId, replyText, notifications, documentId, content, dismissNotification]);

  // ── Render ─────────────────────────────────────────────────────────

  const notificationCount = notifications.length;
  const visibleNotifications = notifications.slice(0, 3);
  const hasOverflow = notifications.length > 3;

  // Measure the expandable panel's natural height for smooth animation
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);

  useEffect(() => {
    if (expanded && panelRef.current) {
      const measure = () => setPanelHeight(panelRef.current?.scrollHeight ?? 0);
      measure();
      // Re-measure when notifications change
      const observer = new ResizeObserver(measure);
      observer.observe(panelRef.current);
      return () => observer.disconnect();
    } else {
      setPanelHeight(0);
    }
  }, [expanded, notifications.length, replyToId]);

  return (
    <div className="flex-shrink-0 border-t border-slate-200 bg-white" data-testid="ai-advisor">
      {/* Status bar — always visible */}
      <button
        type="button"
        onClick={expanded ? handleCollapse : handleExpand}
        className="flex w-full items-center justify-between px-4 text-left transition-colors hover:bg-slate-50"
        style={{ minHeight: '28px', paddingTop: '4px', paddingBottom: '4px' }}
        aria-label={expanded ? 'Collapse AI Advisor' : 'Expand AI Advisor'}
        data-testid="ai-advisor-status-bar"
      >
        <div className="flex items-center gap-2">
          <span
            className="text-xs text-slate-400 transition-transform duration-300 ease-out"
            aria-hidden="true"
            style={{ display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          >
            ✦
          </span>
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
          <svg
            className="h-3 w-3 text-slate-400 transition-transform duration-300 ease-out"
            style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5" />
          </svg>
        </div>
      </button>

      {/* Expandable panel — animated height */}
      <div
        className="overflow-hidden transition-[max-height] duration-300 ease-out"
        style={{ maxHeight: expanded ? `${Math.min(panelHeight, window.innerHeight * 0.4)}px` : '0px', visibility: expanded ? 'visible' : 'hidden' }}
      >
        <div ref={panelRef} data-testid="ai-advisor-panel">
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
                className="text-[10px] text-slate-400 transition-colors hover:text-slate-700"
                data-testid="ai-advisor-clear-all"
              >
                Clear all
              </button>
            )}
          </div>

          {/* Notification cards */}
          <div className="max-h-[35vh] space-y-2 overflow-y-auto px-4 pb-3">
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
              <p className="py-1 text-center text-[10px] text-slate-400">
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
                  onClick={handleSendReply}
                  className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-700"
                  data-testid="ai-advisor-reply-send"
                >
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
