import { useMemo } from 'react';
import { filterMentions, type MentionCandidate } from '../lib/slashCommands';
import { EditorPopup } from './EditorPopup';

interface MentionPaletteProps {
  position: { top: number; left: number };
  query: string;
  candidates: MentionCandidate[];
  listId: string;
  onSelect: (candidate: MentionCandidate) => void;
  onClose: () => void;
  onActiveChange?: (optionId: string | null) => void;
}

/** `@` picker for linking to other documents. Candidates are local (already loaded), so it works offline. */
export function MentionPalette({
  position,
  query,
  candidates,
  listId,
  onSelect,
  onClose,
  onActiveChange,
}: MentionPaletteProps) {
  const items = useMemo(
    () =>
      filterMentions(candidates, query).map((c) => ({
        ...c,
        label: c.title || 'Untitled',
      })),
    [candidates, query],
  );
  if (items.length === 0) return null;
  return (
    <EditorPopup
      listId={listId}
      title="Link a document"
      filter={query}
      items={items}
      position={position}
      onSelect={(item) => onSelect({ id: item.id, title: item.title })}
      onClose={onClose}
      onActiveChange={onActiveChange}
      testId="mention-palette"
    />
  );
}
