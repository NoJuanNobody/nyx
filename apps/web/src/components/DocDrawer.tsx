import { useEffect, useRef } from 'react';
import type { DocumentVersion } from '@syncdocs/shared';
import { VersionHistory } from './VersionHistory';
import { Timeline } from './Timeline';
import { ChangeProposals } from './ChangeProposals';
import { AuditTrail } from './AuditTrail';
import { AgentPanel } from './AgentPanel';
import { AIChatPanel } from './AIChatPanel';
import { JSXPreviewPanel } from './JSXPreviewPanel';

export type DrawerPanel = 'history' | 'timeline' | 'proposals' | 'audit' | 'agent' | 'ai' | 'jsx-preview';

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
  jsxPreviewContext?: string;
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
    label: 'AI Edit',
    icon: (
      <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 2L9.19 8.63L2 9.24L7.46 13.97L5.82 21L12 17.27L18.18 21L16.54 13.97L22 9.24L14.81 8.63L12 2Z" />
      </svg>
    ),
  },
  {
    key: 'agent',
    label: 'Agent',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" />
      </svg>
    ),
  },
  {
    key: 'jsx-preview',
    label: 'Preview',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
      </svg>
    ),
  },
];

export function DocDrawer({ documentId, teamId, activePanel, onClose, onSelectVersion, activeVersionId, onSwitchToHistory, aiChat, jsxPreviewContext }: DocDrawerProps) {
  const isOpen = activePanel !== null;
  const drawerRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  return (
    <div
      ref={drawerRef}
      className={`flex flex-shrink-0 flex-col border-l border-slate-200/80 bg-white transition-all duration-200 ease-out ${
        isOpen ? 'w-80' : 'w-0'
      }`}
      style={{ overflow: isOpen ? undefined : 'hidden' }}
    >
      {isOpen && (
        <div className="flex h-full w-80 flex-col">
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
              <AIChatPanel
                content={aiChat.content}
                onProposedEdit={aiChat.onProposedEdit}
                isNewDocument={aiChat.isNewDocument}
                onGenerate={aiChat.onGenerate}
                isReviewMode={aiChat.isReviewMode}
                stage={aiChat.stage}
              />
            )}
            {activePanel === 'agent' && <AgentPanel documentId={documentId} teamId={teamId} />}
            {activePanel === 'jsx-preview' && <JSXPreviewPanel specContext={jsxPreviewContext} />}
          </div>
        </div>
      )}
    </div>
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
