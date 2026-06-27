import type { SearchResponse } from './search/search.types.js';

type Obj = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

function fmt(toolName: string, result: unknown): string {
  const r = result as Obj;

  switch (toolName) {
    // ── Documents ──────────────────────────────────────────────────────

    case 'nyx_search_docs': {
      const docs = (Array.isArray(result) ? result : (r.documents ?? [])) as Obj[];
      if (docs.length === 0) return 'No documents found.';
      const lines = docs.map((d) => {
        const status = d.status ? ` [${d.status}]` : '';
        const path = d.path ? `  ${d.path}` : '';
        return `• ${str(d.title)}${status}${path}  (${str(d.id)})`;
      });
      return `${docs.length} document${docs.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
    }

    case 'nyx_read_doc': {
      const stage = r.status ? ` · ${r.status}` : '';
      const path = r.path ? ` · ${r.path}` : '';
      const header = `# ${str(r.title)}${stage}${path}\n\n`;
      return header + str(r.content ?? '(no content)');
    }

    case 'nyx_create_doc': {
      return `Document created: "${str(r.title)}"  (id: ${str(r.id)})${r.path ? `\nPath: ${r.path}` : ''}`;
    }

    case 'nyx_update_doc': {
      const id = str(r.id ?? r.documentId ?? '?');
      return `Document updated (id: ${id}).${r.title ? `\nTitle: ${r.title}` : ''}`;
    }

    case 'nyx_delete_doc': {
      return r.success ? 'Document deleted.' : `Delete result: ${JSON.stringify(result)}`;
    }

    case 'nyx_list_versions': {
      const versions = (Array.isArray(result) ? result : (r.versions ?? [])) as Obj[];
      if (versions.length === 0) return 'No versions found.';
      const lines = versions.map((v) => {
        const msg = v.message ? ` — ${v.message}` : '';
        const ts = v.createdAt ? ` (${str(v.createdAt).split('T')[0]})` : '';
        return `• v${v.version ?? v.versionNumber}${msg}${ts}`;
      });
      return `${versions.length} version${versions.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
    }

    case 'nyx_get_timeline': {
      const events = (Array.isArray(result) ? result : (r.events ?? [])) as Obj[];
      if (events.length === 0) return 'No timeline events.';
      const lines = events.map((e) => {
        const ts = e.createdAt ? str(e.createdAt).split('T')[0] : '';
        const actor = e.actor ? ` by ${e.actor}` : '';
        return `• [${ts}] ${str(e.type ?? e.eventType)}${actor}: ${str(e.description ?? '')}`;
      });
      return `${events.length} event${events.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
    }

    // ── Teams ──────────────────────────────────────────────────────────

    case 'nyx_list_teams': {
      const teams = (Array.isArray(result) ? result : (r.teams ?? [])) as Obj[];
      if (teams.length === 0) return 'No teams found.';
      const lines = teams.map((t) => {
        const role = t.role ? ` (${t.role})` : '';
        return `• ${str(t.name)}  /${str(t.slug)}${role}  (${str(t.id)})`;
      });
      return `${teams.length} team${teams.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
    }

    case 'nyx_get_team': {
      const members = Array.isArray(r.members) ? `\nMembers: ${r.members.length}` : '';
      return `Team: ${str(r.name)}  (/${str(r.slug)})  id: ${str(r.id)}${members}`;
    }

    case 'nyx_create_team': {
      return `Team created: "${str(r.name)}"  (/${str(r.slug)})  id: ${str(r.id)}`;
    }

    // ── Tickets ────────────────────────────────────────────────────────

    case 'nyx_create_ticket': {
      const url = r.url ? `\nURL: ${r.url}` : '';
      const num = r.number ? ` #${r.number}` : '';
      return `Ticket created${num}: "${str(r.title ?? '')}"${url}`;
    }

    // ── AI tools ───────────────────────────────────────────────────────

    case 'nyx_check_quality': {
      const score = r.score !== undefined ? `Quality score: ${r.score}/10` : 'Quality analysis:';
      const sug = (r.suggestions ?? r.improvements ?? []) as unknown[];
      if (sug.length === 0) return `${score}\nNo suggestions.`;
      const bullets = sug.map((s) => `• ${str(s)}`).join('\n');
      return `${score}\n\nSuggestions:\n${bullets}`;
    }

    case 'nyx_detect_drift': {
      const score = r.driftScore !== undefined
        ? `Drift score: ${r.driftScore}`
        : r.score !== undefined ? `Drift score: ${r.score}` : '';
      const hasDrift = r.hasDrift !== undefined ? `\nDrift detected: ${r.hasDrift}` : '';
      const details = (r.details ?? r.differences ?? []) as unknown[];
      const body = details.length > 0
        ? `\n\nDetails:\n${details.map((d) => `• ${str(d)}`).join('\n')}`
        : '';
      return `${score}${hasDrift}${body}`.trim() || JSON.stringify(result, null, 2);
    }

    // ── Podcast ────────────────────────────────────────────────────────

    case 'nyx_generate_podcast': {
      const title = r.title ? `# ${r.title}\n\n` : '';
      if (r.script) {
        const script = Array.isArray(r.script)
          ? r.script.map((line: unknown) => {
              const l = line as Obj;
              return l.speaker ? `**${l.speaker}:** ${str(l.text ?? l.line ?? '')}` : str(line);
            }).join('\n\n')
          : str(r.script);
        const qs = r.qualityScore !== undefined ? `\n\n_Quality score: ${r.qualityScore}/10_` : '';
        return `${title}${script}${qs}`;
      }
      return `${title}Podcast generated (id: ${str(r.id)})`;
    }

    // ── Web search ─────────────────────────────────────────────────────

    case 'nyx_web_search': {
      const res = result as SearchResponse;
      if (!res.results || res.results.length === 0) return `No results for: ${res.query ?? ''}`;
      const lines = res.results.map((r, i) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`,
      );
      return `Search: ${res.query}\n\n${lines.join('\n\n')}`;
    }

    // ── Meetings ───────────────────────────────────────────────────────

    case 'nyx_join_meeting': {
      return `Joined meeting. Session id: ${str(r.sessionId ?? r.session_id ?? '?')}  status: ${str(r.status ?? 'connecting')}`;
    }

    case 'nyx_leave_meeting': {
      return r.success ? 'Left meeting.' : `Leave result: ${JSON.stringify(result)}`;
    }

    case 'nyx_meeting_status': {
      const state = str(r.state ?? r.status ?? '?');
      const platform = r.platform ? `  platform: ${r.platform}` : '';
      const start = r.startedAt ? `\nStarted: ${str(r.startedAt).split('T')[0]}` : '';
      return `Status: ${state}${platform}${start}`;
    }

    case 'nyx_generate_meeting_doc': {
      const id = str(r.id ?? '?');
      const title = r.title ? `"${r.title}"` : id;
      return `Meeting document created: ${title}  (id: ${id})`;
    }

    // ── Filesystem ─────────────────────────────────────────────────────

    case 'nyx_read_file': {
      const header = `File: ${str(r.path)}  (${str(r.extension)})\n${'─'.repeat(40)}\n`;
      return header + str(r.content ?? '');
    }

    case 'nyx_list_files': {
      const entries = (Array.isArray(result) ? result : []) as Obj[];
      if (entries.length === 0) return '(empty directory)';
      const lines = entries.map((e) => {
        const icon = e.type === 'directory' ? '📁' : '📄';
        return `${icon} ${str(e.name)}`;
      });
      return lines.join('\n');
    }

    // ── Fallback ───────────────────────────────────────────────────────

    default:
      return JSON.stringify(result, null, 2);
  }
}

/**
 * Render an MCP tool result as clean, human-readable text.
 * Falls back to compact JSON if formatting throws.
 */
export function formatToolResult(toolName: string, result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === null || result === undefined) return '(no result)';

  try {
    return fmt(toolName, result);
  } catch {
    return JSON.stringify(result, null, 2);
  }
}
