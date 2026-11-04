import { useEffect, useMemo, useState } from 'react';
import type { DocumentTemplate } from '@nyx/shared';
import { fetchTemplates } from '../lib/api';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import {
  BUILTIN_SLASH_COMMANDS,
  filterSlashCommands,
  type SlashCommand,
} from '../lib/slashCommands';
import { EditorPopup } from './EditorPopup';

interface SlashCommandPaletteProps {
  position: { top: number; left: number };
  filter: string;
  teamId?: string;
  listId: string;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
  onActiveChange?: (optionId: string | null) => void;
}

function templateToCommand(t: DocumentTemplate): SlashCommand {
  return {
    id: `template:${t.id}`,
    label: t.name,
    description: t.description,
    group: 'Template',
    badge: t.stage,
    keywords: [t.stage],
    insert: t.content,
  };
}

/**
 * Slash-command picker. The built-in commands are local snippets and are
 * always available, including offline. Saved templates are an optional extra
 * fetched in the background; if the fetch fails or the app is offline the list
 * simply shows the built-ins.
 */
export function SlashCommandPalette({
  position,
  filter,
  teamId,
  listId,
  onSelect,
  onClose,
  onActiveChange,
}: SlashCommandPaletteProps) {
  const online = useOnlineStatus();
  const [templates, setTemplates] = useState<SlashCommand[]>([]);
  const [templatesFailed, setTemplatesFailed] = useState(false);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    setTemplatesFailed(false);
    fetchTemplates(undefined, teamId)
      .then((data) => {
        if (!cancelled) setTemplates(data.map(templateToCommand));
      })
      .catch(() => {
        if (!cancelled) setTemplatesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, online]);

  const items = useMemo(
    () => filterSlashCommands([...BUILTIN_SLASH_COMMANDS, ...templates], filter),
    [templates, filter],
  );

  if (items.length === 0) return null;

  const note =
    !online || templatesFailed ? 'Saved templates are unavailable offline. Built-in commands still work.' : undefined;

  return (
    <EditorPopup
      listId={listId}
      title="Insert"
      filter={filter}
      items={items}
      position={position}
      onSelect={onSelect}
      onClose={onClose}
      onActiveChange={onActiveChange}
      note={note}
      testId="slash-command-palette"
    />
  );
}
