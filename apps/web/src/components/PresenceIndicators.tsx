/**
 * PresenceIndicators — shows avatars of users currently editing the document.
 * Renders a cluster of coloured circles with initials and a tooltip on hover.
 * Also shows a connection-status dot (green = connected, amber = connecting).
 */
import type { Collaborator } from '../hooks/useCollaboration';

interface PresenceIndicatorsProps {
  collaborators: Collaborator[];
  connected: boolean;
  /** Max avatars shown before a "+N" overflow badge appears. */
  max?: number;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export function PresenceIndicators({
  collaborators,
  connected,
  max = 4,
}: PresenceIndicatorsProps) {
  const visible = collaborators.slice(0, max);
  const overflow = collaborators.length - visible.length;

  return (
    <div className="flex items-center gap-2">
      {/* Connection status dot */}
      <span
        title={connected ? 'Live — changes sync in real time' : 'Connecting…'}
        className={`inline-block h-2 w-2 rounded-full transition-colors ${
          connected ? 'bg-green-500' : 'bg-amber-400'
        }`}
      />

      {/* Collaborator avatars */}
      {collaborators.length > 0 && (
        <div className="flex -space-x-2">
          {visible.map((c) => (
            <div
              key={c.userId}
              title={c.name}
              className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-[9px] font-bold text-white shadow-sm"
              style={{ backgroundColor: c.color }}
            >
              {getInitials(c.name)}
            </div>
          ))}

          {overflow > 0 && (
            <div
              title={`${overflow} more collaborator${overflow === 1 ? '' : 's'}`}
              className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-slate-400 text-[9px] font-bold text-white shadow-sm"
            >
              +{overflow}
            </div>
          )}
        </div>
      )}

      {/* Label shown only when others are present */}
      {collaborators.length > 0 && (
        <span className="text-[10px] text-slate-400">
          {collaborators.length === 1
            ? `${collaborators[0].name} is here`
            : `${collaborators.length} others here`}
        </span>
      )}
    </div>
  );
}
