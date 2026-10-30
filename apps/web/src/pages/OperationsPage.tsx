import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { VoicePage } from './VoicePage';
import { ObservabilityPage } from './ObservabilityPage';

const TABS = [
  { id: 'voice', label: 'Voice' },
  { id: 'observability', label: 'Observability' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function OperationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramTab = searchParams.get('tab') as TabId | null;
  const [activeTab, setActiveTab] = useState<TabId>(
    paramTab && TABS.some((t) => t.id === paramTab) ? paramTab : 'voice',
  );

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
    setSearchParams({ tab });
  };

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="border-b border-slate-200 bg-white px-6 pt-4">
        <div className="flex gap-4">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabChange(tab.id)}
              data-testid={`operations-tab-${tab.id}`}
              className={`relative px-1 pb-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'text-blue-700'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {tab.label}
              {activeTab === tab.id && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-blue-600" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'voice' && <VoicePage />}
        {activeTab === 'observability' && <ObservabilityPage />}
      </div>
    </div>
  );
}
