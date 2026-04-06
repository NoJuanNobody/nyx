/**
 * Minimal YAML frontmatter parser/serializer for .md files.
 * No external deps — just splits on `---` delimiters.
 */

export interface Frontmatter {
  nyx_id?: string;
  title?: string;
  stage?: string | null;
  status?: string;
  path?: string;
  [key: string]: unknown;
}

/** Parse a .md file into frontmatter + body content. */
export function parseFrontmatter(raw: string): { meta: Frontmatter; content: string } {
  const trimmed = raw.replace(/^\uFEFF/, ''); // strip BOM
  if (!trimmed.startsWith('---')) {
    return { meta: {}, content: trimmed };
  }

  const end = trimmed.indexOf('\n---', 3);
  if (end === -1) {
    return { meta: {}, content: trimmed };
  }

  const yamlBlock = trimmed.slice(4, end); // after opening "---\n"
  const content = trimmed.slice(end + 4).replace(/^\n/, ''); // after closing "---\n"

  const meta: Frontmatter = {};
  for (const line of yamlBlock.split('\n')) {
    const match = line.match(/^(\w[\w_]*)\s*:\s*(.*)/);
    if (match) {
      const [, key, val] = match;
      meta[key] = val === 'null' ? null : val.replace(/^['"]|['"]$/g, '');
    }
  }

  return { meta, content };
}

/** Serialize frontmatter + content into a .md file string. */
export function serializeFrontmatter(meta: Frontmatter, content: string): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (value === null) {
      lines.push(`${key}: null`);
    } else {
      const str = String(value);
      // Quote if it contains special YAML chars
      const needsQuote = /[:#{}[\],&*?|>!%@`]/.test(str) || str === '';
      lines.push(`${key}: ${needsQuote ? `"${str.replace(/"/g, '\\"')}"` : str}`);
    }
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n') + content;
}
