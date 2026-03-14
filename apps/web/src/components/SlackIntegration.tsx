import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getSlackInstallUrl,
  getSlackConnection,
  updateSlackConnection,
  disconnectSlack,
} from '../lib/api';
import { useAuthStore } from '../stores/auth.store';

function SlackIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
}

export function SlackIntegration() {
  const queryClient = useQueryClient();
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const [editingEmoji, setEditingEmoji] = useState(false);
  const [emojiValue, setEmojiValue] = useState('');
  const [channelInput, setChannelInput] = useState('');

  const { data: connectionData, isLoading } = useQuery({
    queryKey: ['slack-connection', currentTeamId],
    queryFn: () => getSlackConnection(currentTeamId!),
    enabled: !!currentTeamId,
  });

  const connection = connectionData?.connection;
  const isConnected = !!connection;

  const connectMutation = useMutation({
    mutationFn: () => getSlackInstallUrl(currentTeamId!),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => disconnectSlack(currentTeamId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['slack-connection', currentTeamId] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: { triggerEmoji?: string; monitoredChannels?: string[] }) =>
      updateSlackConnection(currentTeamId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['slack-connection', currentTeamId] });
      setEditingEmoji(false);
    },
  });

  const handleSaveEmoji = useCallback(() => {
    if (emojiValue.trim()) {
      updateMutation.mutate({ triggerEmoji: emojiValue.trim() });
    }
  }, [emojiValue, updateMutation]);

  const handleAddChannel = useCallback(() => {
    if (!channelInput.trim() || !connection) return;
    const channels = [...((connection.monitoredChannels as string[]) ?? []), channelInput.trim()];
    updateMutation.mutate({ monitoredChannels: channels });
    setChannelInput('');
  }, [channelInput, connection, updateMutation]);

  const handleRemoveChannel = useCallback(
    (channelId: string) => {
      if (!connection) return;
      const channels = ((connection.monitoredChannels as string[]) ?? []).filter(
        (c) => c !== channelId,
      );
      updateMutation.mutate({ monitoredChannels: channels });
    },
    [connection, updateMutation],
  );

  if (isLoading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="animate-pulse flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-slate-200" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-24 rounded bg-slate-200" />
            <div className="h-3 w-48 rounded bg-slate-100" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="slack-integration-card"
      className={`rounded-lg border overflow-hidden transition-all ${
        isConnected ? 'border-green-200 bg-green-50/30' : 'border-slate-200 bg-white'
      }`}
    >
      {/* Header */}
      <div className="flex items-start gap-4 p-4">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-[#4A154B] text-white">
          <SlackIcon className="h-5 w-5" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-800">Slack</span>
            {isConnected && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                Connected
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-500 leading-relaxed">
            Route team messages through SyncDocs intake via /nyx command, emoji reactions, or
            channel monitoring.
          </p>
          {isConnected && (
            <p className="mt-1.5 text-xs text-slate-400">
              Workspace: <span className="font-mono text-slate-600">{connection.slackTeamId}</span>
              {' '}&middot; Connected{' '}
              {new Date(connection.createdAt).toLocaleDateString()}
            </p>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {isConnected ? (
            <button
              type="button"
              data-testid="slack-disconnect-btn"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-red-200 hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-50"
            >
              {disconnectMutation.isPending ? 'Disconnecting...' : 'Disconnect'}
            </button>
          ) : (
            <button
              type="button"
              data-testid="slack-connect-btn"
              onClick={() => connectMutation.mutate()}
              disabled={connectMutation.isPending}
              className="rounded-md bg-[#4A154B] px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-[#3B1139] transition-colors disabled:opacity-60"
            >
              {connectMutation.isPending ? (
                <span className="flex items-center gap-1.5">
                  <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Connecting...
                </span>
              ) : (
                'Connect Slack'
              )}
            </button>
          )}
        </div>
      </div>

      {/* Settings (only visible when connected) */}
      {isConnected && (
        <div className="border-t border-green-100 bg-white/60 p-4 space-y-4">
          {/* Trigger Emoji */}
          <div>
            <h4 className="text-xs font-semibold text-slate-700">Trigger Emoji</h4>
            <p className="text-[11px] text-slate-400 mt-0.5">
              React with this emoji on any message to route it through SyncDocs intake.
            </p>
            <div className="mt-2 flex items-center gap-2">
              {editingEmoji ? (
                <>
                  <input
                    type="text"
                    value={emojiValue}
                    onChange={(e) => setEmojiValue(e.target.value)}
                    placeholder="e.g. nyx"
                    className="w-32 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveEmoji()}
                  />
                  <button
                    type="button"
                    onClick={handleSaveEmoji}
                    className="rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingEmoji(false)}
                    className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <code className="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700">
                    :{connection.triggerEmoji ?? 'nyx'}:
                  </code>
                  <button
                    type="button"
                    data-testid="slack-edit-emoji-btn"
                    onClick={() => {
                      setEmojiValue(connection.triggerEmoji ?? 'nyx');
                      setEditingEmoji(true);
                    }}
                    className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-50 transition-colors"
                  >
                    Edit
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Monitored Channels */}
          <div>
            <h4 className="text-xs font-semibold text-slate-700">Monitored Channels</h4>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Messages in these channels are automatically routed through intake.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {((connection.monitoredChannels as string[]) ?? []).map((ch) => (
                <span
                  key={ch}
                  className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
                >
                  #{ch}
                  <button
                    type="button"
                    onClick={() => handleRemoveChannel(ch)}
                    className="ml-0.5 text-slate-400 hover:text-red-500 transition-colors"
                    title="Remove channel"
                  >
                    <svg
                      className="h-3 w-3"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={2}
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={channelInput}
                onChange={(e) => setChannelInput(e.target.value)}
                placeholder="Channel ID (e.g. C0123456789)"
                className="flex-1 max-w-xs rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                onKeyDown={(e) => e.key === 'Enter' && handleAddChannel()}
              />
              <button
                type="button"
                data-testid="slack-add-channel-btn"
                onClick={handleAddChannel}
                disabled={!channelInput.trim()}
                className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-40"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
