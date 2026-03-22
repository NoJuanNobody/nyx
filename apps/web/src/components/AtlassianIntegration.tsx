import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchAtlassianStatus,
  disconnectAtlassian,
  fetchJiraProjects,
  fetchConfluenceSpaces,
  updateAtlassianPreferences,
  type AtlassianConnectionStatus,
  type JiraProjectItem,
  type ConfluenceSpaceItem,
} from '../lib/api';
import { useAuthStore } from '../stores/auth.store';

// ── Status Indicator ─────────────────────────────────────────────

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  connected: { dot: 'bg-green-500', label: 'Connected' },
  token_expired: { dot: 'bg-yellow-500', label: 'Token Expired' },
  disconnected: { dot: 'bg-slate-400', label: 'Not Connected' },
  error: { dot: 'bg-red-500', label: 'Error' },
};

function StatusIndicator({ status, siteUrl }: { status: string; siteUrl?: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.disconnected;
  return (
    <div className="flex items-center gap-2">
      <span className={`h-2.5 w-2.5 rounded-full ${style.dot}`} />
      <span className="text-sm text-slate-600">{style.label}</span>
      {siteUrl && status === 'connected' && (
        <span className="text-xs text-slate-400">({siteUrl})</span>
      )}
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────

export function AtlassianIntegration() {
  const queryClient = useQueryClient();
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const { data: statusData, isLoading } = useQuery({
    queryKey: ['atlassian-status'],
    queryFn: fetchAtlassianStatus,
  });

  const status = statusData?.status ?? 'disconnected';
  const connection = statusData?.connection;
  const isConnected = status === 'connected';

  const { data: jiraProjectsData } = useQuery({
    queryKey: ['atlassian-jira-projects'],
    queryFn: fetchJiraProjects,
    enabled: isConnected,
  });

  const { data: confluenceSpacesData } = useQuery({
    queryKey: ['atlassian-confluence-spaces'],
    queryFn: fetchConfluenceSpaces,
    enabled: isConnected,
  });

  const disconnectMutation = useMutation({
    mutationFn: disconnectAtlassian,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['atlassian-status'] });
      setConfirmDisconnect(false);
    },
  });

  const prefsMutation = useMutation({
    mutationFn: updateAtlassianPreferences,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['atlassian-status'] }),
  });

  const preferences = (connection?.preferences ?? {}) as Record<string, unknown>;

  const handleConnect = useCallback(() => {
    if (!currentTeamId) return;
    window.location.href = `/api/integrations/atlassian/auth?teamId=${currentTeamId}`;
  }, [currentTeamId]);

  const handlePreferenceChange = useCallback(
    (key: string, value: unknown) => {
      prefsMutation.mutate({ ...preferences, [key]: value });
    },
    [preferences, prefsMutation],
  );

  if (isLoading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-blue-100 animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-32 rounded bg-slate-100 animate-pulse" />
            <div className="h-3 w-48 rounded bg-slate-100 animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-6 space-y-6" data-testid="atlassian-integration">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-600">
            <svg className="h-6 w-6 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005Zm5.723-5.756H5.723a5.215 5.215 0 0 0 5.215 5.215h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.762a1.005 1.005 0 0 0-1.005-1.005h.017ZM23.013 0H11.441a5.218 5.218 0 0 0 5.216 5.215h2.129v2.058A5.218 5.218 0 0 0 24 12.488V1.005A1.005 1.005 0 0 0 22.996 0h.017Z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Atlassian (Jira & Confluence)</h3>
            <p className="text-xs text-slate-500">
              Push specs to Jira, export docs to Confluence, and sync status changes.
            </p>
          </div>
        </div>
        <StatusIndicator status={status} siteUrl={connection?.siteUrl} />
      </div>

      {/* Connect / Disconnect Actions */}
      {!isConnected ? (
        <div>
          {status === 'token_expired' && (
            <p className="mb-3 text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-md p-3">
              Your Atlassian token has expired. Please re-authorize to continue using the integration.
            </p>
          )}
          <button
            type="button"
            onClick={handleConnect}
            disabled={!currentTeamId}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            data-testid="atlassian-connect-btn"
          >
            {status === 'token_expired' ? 'Re-authorize' : 'Connect Atlassian'}
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Jira Project Selection */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Default Jira Project
            </label>
            <select
              value={(preferences.defaultJiraProjectKey as string) ?? ''}
              onChange={(e) => handlePreferenceChange('defaultJiraProjectKey', e.target.value)}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              data-testid="atlassian-jira-project-select"
            >
              <option value="">Select a project...</option>
              {jiraProjectsData?.projects?.map((p: JiraProjectItem) => (
                <option key={p.key} value={p.key}>
                  {p.name} ({p.key})
                </option>
              ))}
            </select>
          </div>

          {/* Confluence Space Selection */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Default Confluence Space
            </label>
            <select
              value={(preferences.defaultConfluenceSpaceId as string) ?? ''}
              onChange={(e) => handlePreferenceChange('defaultConfluenceSpaceId', e.target.value)}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              data-testid="atlassian-confluence-space-select"
            >
              <option value="">Select a space...</option>
              {confluenceSpacesData?.spaces?.map((s: ConfluenceSpaceItem) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.key})
                </option>
              ))}
            </select>
          </div>

          {/* Sync Preferences */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-slate-700">Sync Preferences</h4>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={(preferences.autoExportOnPublish as boolean) ?? false}
                onChange={(e) => handlePreferenceChange('autoExportOnPublish', e.target.checked)}
                className="rounded border-slate-300"
              />
              <span className="text-sm text-slate-600">Auto-export to Confluence on publish</span>
            </label>

            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">
                Jira status sync method
              </label>
              <select
                value={(preferences.jiraStatusSync as string) ?? 'webhooks'}
                onChange={(e) => handlePreferenceChange('jiraStatusSync', e.target.value)}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none"
              >
                <option value="webhooks">Webhooks (real-time)</option>
                <option value="polling">Polling</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={(preferences.confluenceChangeDetection as boolean) ?? true}
                onChange={(e) =>
                  handlePreferenceChange('confluenceChangeDetection', e.target.checked)
                }
                className="rounded border-slate-300"
              />
              <span className="text-sm text-slate-600">Detect external Confluence changes</span>
            </label>
          </div>

          {/* Disconnect */}
          <div className="border-t border-slate-100 pt-4">
            {confirmDisconnect ? (
              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-600">Are you sure?</span>
                <button
                  type="button"
                  onClick={() => disconnectMutation.mutate()}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
                  data-testid="atlassian-disconnect-confirm"
                >
                  Yes, disconnect
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDisconnect(false)}
                  className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDisconnect(true)}
                className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
                data-testid="atlassian-disconnect-btn"
              >
                Disconnect Atlassian
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
