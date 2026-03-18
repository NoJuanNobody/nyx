import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';

export type LatexTheme = 'ieee' | 'acm' | 'apa' | 'plain';

const THEME_PREAMBLES: Record<LatexTheme, string> = {
  ieee: `\\documentclass[conference]{IEEEtran}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{graphicx}
\\usepackage{textcomp}
\\usepackage{listings}
\\usepackage{hyperref}
\\lstset{basicstyle=\\ttfamily\\small,breaklines=true}`,

  acm: `\\documentclass[sigconf]{acmart}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{listings}
\\usepackage{hyperref}
\\lstset{basicstyle=\\ttfamily\\small,breaklines=true}`,

  apa: `\\documentclass[man,12pt]{apa7}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{listings}
\\usepackage{hyperref}
\\lstset{basicstyle=\\ttfamily\\small,breaklines=true}`,

  plain: `\\documentclass[12pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{listings}
\\usepackage{hyperref}
\\lstset{basicstyle=\\ttfamily\\small,breaklines=true}`,
};

const VALID_THEMES = new Set<string>(Object.keys(THEME_PREAMBLES));

/**
 * Converts markdown text to LaTeX body content.
 *
 * Handles: headings, bold, italic, inline code, fenced code blocks,
 * simple tables, unordered/ordered lists, and math pass-through.
 */
export function markdownToLatex(markdown: string, theme: LatexTheme = 'plain'): string {
  const preamble = THEME_PREAMBLES[theme];
  const body = convertBody(markdown);

  return `${preamble}

\\begin{document}

${body}

\\end{document}
`;
}

/**
 * Escape special LaTeX characters in plain text.
 * Does NOT escape `$` so inline math passes through.
 */
function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&#%_{}~^])/g, '\\$1');
}

function convertInline(line: string): string {
  // Inline code (before bold/italic so backticks aren't mangled)
  let result = line.replace(/`([^`]+)`/g, '\\texttt{$1}');

  // Bold + italic
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '\\textbf{\\textit{$1}}');

  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}');

  // Italic
  result = result.replace(/\*(.+?)\*/g, '\\textit{$1}');

  // Escape remaining special characters (skip already-converted commands)
  // We do a targeted escape: only & # % _ outside of commands
  result = result.replace(/(?<!\\)&/g, '\\&');

  return result;
}

function convertBody(markdown: string): string {
  const lines = markdown.split('\n');
  const output: string[] = [];
  let i = 0;
  let inList: 'ul' | 'ol' | null = null;

  function closeList() {
    if (inList === 'ul') {
      output.push('\\end{itemize}');
    } else if (inList === 'ol') {
      output.push('\\end{enumerate}');
    }
    inList = null;
  }

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const codeMatch = line.match(/^```(\w*)/);
    if (codeMatch) {
      closeList();
      const lang = codeMatch[1] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const langOption = lang ? `[language=${lang}]` : '';
      output.push(`\\begin{lstlisting}${langOption}`);
      output.push(codeLines.join('\n'));
      output.push('\\end{lstlisting}');
      continue;
    }

    // Math block ($$...$$)
    if (line.trim().startsWith('$$')) {
      closeList();
      if (line.trim().endsWith('$$') && line.trim().length > 2) {
        // Single-line display math
        const math = line.trim().slice(2, -2);
        output.push(`\\[${math}\\]`);
        i++;
        continue;
      }
      // Multi-line display math
      const mathLines: string[] = [];
      const firstLine = line.trim().slice(2);
      if (firstLine) mathLines.push(firstLine);
      i++;
      while (i < lines.length && !lines[i].trim().endsWith('$$')) {
        mathLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        const lastLine = lines[i].trim().slice(0, -2);
        if (lastLine) mathLines.push(lastLine);
        i++;
      }
      output.push(`\\[${mathLines.join('\n')}\\]`);
      continue;
    }

    // Table detection (line with pipes)
    if (line.includes('|') && line.trim().startsWith('|')) {
      closeList();
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      output.push(convertTable(tableLines));
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      const text = convertInline(headingMatch[2]);
      const sectionCommands = [
        '\\section',
        '\\subsection',
        '\\subsubsection',
        '\\paragraph',
        '\\subparagraph',
        '\\subparagraph',
      ];
      const cmd = sectionCommands[level - 1] || '\\subparagraph';
      output.push(`${cmd}{${text}}`);
      i++;
      continue;
    }

    // Unordered list item
    const ulMatch = line.match(/^[-*+]\s+(.+)/);
    if (ulMatch) {
      if (inList !== 'ul') {
        closeList();
        output.push('\\begin{itemize}');
        inList = 'ul';
      }
      output.push(`  \\item ${convertInline(ulMatch[1])}`);
      i++;
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      if (inList !== 'ol') {
        closeList();
        output.push('\\begin{enumerate}');
        inList = 'ol';
      }
      output.push(`  \\item ${convertInline(olMatch[1])}`);
      i++;
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      closeList();
      output.push('');
      i++;
      continue;
    }

    // Regular paragraph text
    closeList();
    output.push(convertInline(line));
    i++;
  }

  closeList();
  return output.join('\n');
}

function convertTable(lines: string[]): string {
  // Parse header row
  const headerCells = parsePipeLine(lines[0]);
  const colCount = headerCells.length;
  const colSpec = headerCells.map(() => 'l').join(' | ');

  const rows: string[] = [];
  rows.push(`\\begin{tabular}{| ${colSpec} |}`);
  rows.push('\\hline');
  rows.push(headerCells.map((c) => convertInline(c)).join(' & ') + ' \\\\');
  rows.push('\\hline');

  // Skip separator row (the --- | --- row), then process data rows
  for (let i = 1; i < lines.length; i++) {
    const cells = parsePipeLine(lines[i]);
    // Skip separator rows
    if (cells.every((c) => /^[-:]+$/.test(c.trim()))) continue;
    const padded = cells.slice(0, colCount);
    while (padded.length < colCount) padded.push('');
    rows.push(padded.map((c) => convertInline(c)).join(' & ') + ' \\\\');
    rows.push('\\hline');
  }

  rows.push('\\end{tabular}');
  return rows.join('\n');
}

function parsePipeLine(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((s) => s.trim());
}

export function isValidTheme(theme: string): theme is LatexTheme {
  return VALID_THEMES.has(theme);
}

export const exportLatexService = {
  async toLatex(
    documentId: string,
    theme: LatexTheme = 'plain',
  ): Promise<{ title: string; content: string } | null> {
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));

    if (!doc) return null;

    const latex = markdownToLatex(doc.content, theme);
    return { title: doc.title, content: latex };
  },
};
