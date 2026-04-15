import { useEffect, useRef, useState, useCallback } from 'react';
import type { DocumentVersion } from '@nyx/shared';
import { VersionHistory } from './VersionHistory';
import { Timeline } from './Timeline';
import { ChangeProposals } from './ChangeProposals';
import { AuditTrail } from './AuditTrail';
import { UnifiedAIPanel } from './UnifiedAIPanel';
import { ImpactMap } from './ImpactMap';
import { VideoGenerationPanel } from './VideoGenerationPanel';
import { ContextMatches } from './ContextMatches';
import { fetchRelatedSpecs } from '../lib/api';
import type { ContextMatch, ContextSignal } from '../lib/api';

export type DrawerPanel = 'history' | 'timeline' | 'proposals' | 'audit' | 'ai' | 'impact' | 'video' | 'related';

interface AIChatProps {
  content: string;
  onProposedEdit: (newContent: string) => void;
  isNewDocument: boolean;
  onGenerate: (result: { title: string; content: string }) => void;
  isReviewMode: boolean;
  stage?: string | null;
}

interface DocDrawerProps {
  documentId: string;
  teamId: string;
  activePanel: DrawerPanel | null;
  onClose: () => void;
  onSelectVersion?: (version: DocumentVersion | null) => void;
  activeVersionId?: string | null;
  onSwitchToHistory?: (versionId: string) => void;
  aiChat?: AIChatProps;
  stage?: string | null;
}

const PANELS: { key: DrawerPanel; label: string; icon: JSX.Element }[] = [
  {
    key: 'history',
    label: 'History',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
    ),
  },
  {
    key: 'timeline',
    label: 'Timeline',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
      </svg>
    ),
  },
  {
    key: 'proposals',
    label: 'Proposals',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776" />
      </svg>
    ),
  },
  {
    key: 'audit',
    label: 'Audit',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
      </svg>
    ),
  },
  {
    key: 'ai',
    label: 'AI',
    icon: (
      <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 2L9.19 8.63L2 9.24L7.46 13.97L5.82 21L12 17.27L18.18 21L16.54 13.97L22 9.24L14.81 8.63L12 2Z" />
      </svg>
    ),
  },
  {
    key: 'impact',
    label: 'Impact',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
      </svg>
    ),
  },
  {
    key: 'video',
    label: 'Video',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
      </svg>
    ),
  },
  {
    key: 'related',
    label: 'Related',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
      </svg>
    ),
  },
];

export function DocDrawer({ documentId, teamId, activePanel, onClose, onSelectVersion, activeVersionId, onSwitchToHistory, aiChat, stage }: DocDrawerProps) {
  const isOpen = activePanel !== null;
  const drawerRef = useRef<HTMLDivElement>(null);
  const [relatedMatches, setRelatedMatches] = useState<ContextMatch[]>([]);
  const [relatedSignals, setRelatedSignals] = useState<ContextSignal[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const relatedFetchedRef = useRef<string | null>(null);

  // Fetch related specs when panel opens or stage enters approval/review
  const loadRelatedSpecs = useCallback(async () => {
    if (relatedFetchedRef.current === documentId) return;
    setRelatedLoading(true);
    try {
      const result = await fetchRelatedSpecs(documentId);
      setRelatedMatches(
        result.related.map((r) => ({
          documentId: r.id,
          title: r.title,
          relevance: r.relevance,
          relationship: r.relationship,
          summary: r.snippet,
        })),
      );
      setRelatedSignals(result.signals);
      relatedFetchedRef.current = documentId;
    } catch {
      setRelatedMatches([]);
      setRelatedSignals([]);
    } finally {
      setRelatedLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    if (activePanel === 'related') {
      loadRelatedSpecs();
    }
  }, [activePanel, loadRelatedSpecs]);

  // Auto-trigger when document enters an approval/review stage
  useEffect(() => {
    if (stage && /review|approval/i.test(stage)) {
      loadRelatedSpecs();
    }
  }, [stage, loadRelatedSpecs]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // On mobile (<md), drawer overlays the full editor as a sheet.
  // On desktop (md+), it remains a side panel.
  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={onClose}
        />
      )}

      <div
        ref={drawerRef}
        className={`
          ${isOpen
            ? 'fixed inset-x-0 bottom-0 top-14 z-40 w-full md:static md:inset-auto md:z-auto md:w-80'
            : 'w-0'
          }
          flex flex-shrink-0 flex-col border-l border-slate-200/80 bg-white transition-all duration-200 ease-out
        `}
        style={{ overflow: isOpen ? undefined : 'hidden' }}
      >
        {isOpen && (
          <div className="flex h-full w-full flex-col md:w-80">
            {/* Drawer header */}
            <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-200/80 px-4 py-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                {PANELS.find((p) => p.key === activePanel)?.label}
              </span>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                aria-label="Close panel"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Panel content */}
            <div className="flex-1 overflow-hidden">
              {activePanel === 'history' && (
                <VersionHistory
                  documentId={documentId}
                  onSelectVersion={onSelectVersion}
                  activeVersionId={activeVersionId}
                />
              )}
              {activePanel === 'timeline' && <Timeline documentId={documentId} onSwitchToHistory={onSwitchToHistory} />}
              {activePanel === 'proposals' && <ChangeProposals documentId={documentId} />}
              {activePanel === 'audit' && <AuditTrail documentId={documentId} />}
              {activePanel === 'ai' && aiChat && (
                <UnifiedAIPanel
                  content={aiChat.content}
                  onProposedEdit={aiChat.onProposedEdit}
                  isNewDocument={aiChat.isNewDocument}
                  onGenerate={aiChat.onGenerate}
                  isReviewMode={aiChat.isReviewMode}
                  stage={aiChat.stage}
                  documentId={documentId}
                  teamId={teamId}
                />
              )}
              {activePanel === 'impact' && <ImpactMap documentId={documentId} />}
              {activePanel === 'video' && <VideoGenerationPanel documentId={documentId} />}
              {activePanel === 'related' && (
                <div className="p-4">
                  <ContextMatches
                    matches={relatedMatches}
                    signals={relatedSignals}
                    isLoading={relatedLoading}
                  />
                  {!relatedLoading && relatedMatches.length === 0 && relatedSignals.length === 0 && (
                    <p className="text-sm text-slate-400">No related specs found for this document.</p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/* Toolbar icons that toggle the drawer panels */
export function DocDrawerToggle({
  activePanel,
  onToggle,
}: {
  activePanel: DrawerPanel | null;
  onToggle: (panel: DrawerPanel) => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {PANELS.map(({ key, label, icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => onToggle(key)}
          title={label}
          className={`rounded-md p-1.5 transition-colors ${
            activePanel === key
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
          }`}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
