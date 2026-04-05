// Force chalk color support for marked-terminal before it initialises chalk.
// Without this, chalk detects level 0 in some environments (piped stdout,
// tsx -e, etc.) and strips all bold / italic / heading ANSI codes.
if (!process.env.FORCE_COLOR && process.stdout.isTTY) {
  process.env.FORCE_COLOR = '1';
}

import { Marked } from 'marked';
// @ts-expect-error no type declarations
import { markedTerminal } from 'marked-terminal';

const termWidth = Math.min(process.stdout.columns || 80, 100);

/**
 * Truncate markdown table cells so tables fit the terminal width.
 * Replaces each `| cell |` content with a truncated version.
 */
function truncateTableCells(md: string): string {
  const lines = md.split('\n');
  // Find table blocks (consecutive lines starting with |)
  const result: string[] = [];

  for (const line of lines) {
    if (!line.trimStart().startsWith('|')) {
      result.push(line);
      continue;
    }

    // Separator row (e.g. |---|---|) — pass through
    if (/^\|[\s:|-]+\|$/.test(line.trim())) {
      result.push(line);
      continue;
    }

    const cells = line.split('|');
    // First and last elements are empty (before first | and after last |)
    const colCount = cells.length - 2;
    if (colCount <= 0) {
      result.push(line);
      continue;
    }

    // Reserve ~3 chars per column for borders/padding, compute max cell width
    const maxCellWidth = Math.max(12, Math.floor((termWidth - colCount * 3 - 1) / colCount));

    const truncated = cells.map((cell, i) => {
      if (i === 0 || i === cells.length - 1) return cell; // empty boundary
      const trimmed = cell.trim();
      if (trimmed.length <= maxCellWidth) return ` ${trimmed} `;
      return ` ${trimmed.slice(0, maxCellWidth - 1)}… `;
    });

    result.push(truncated.join('|'));
  }

  return result.join('\n');
}

const marked = new Marked();
marked.use(markedTerminal({
  reflowText: true,
  width: termWidth,
  tab: 2,
}) as Record<string, unknown>);

export function renderMarkdown(text: string): string {
  return (marked.parse(truncateTableCells(text)) as string).trimEnd();
}
