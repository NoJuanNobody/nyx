import PDFDocument from 'pdfkit';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';

export type LatexTheme = 'plain' | 'ieee' | 'acm' | 'apa' | 'nature' | 'elsevier';

const LATEX_THEMES: Record<LatexTheme, { preamble: string; description: string }> = {
  plain: {
    description: 'Standard LaTeX article',
    preamble: `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{geometry}
\\usepackage{hyperref}
\\usepackage{listings}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{amsmath}
\\usepackage{natbib}
\\geometry{margin=2.5cm}`,
  },
  ieee: {
    description: 'IEEE two-column conference/journal',
    preamble: `\\documentclass[conference]{IEEEtran}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{hyperref}
\\usepackage{listings}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{amsmath}
\\usepackage{cite}`,
  },
  acm: {
    description: 'ACM article format',
    preamble: `\\documentclass[manuscript,screen,review]{acmart}
\\usepackage[utf8]{inputenc}
\\usepackage{listings}
\\usepackage{booktabs}
\\usepackage{amsmath}`,
  },
  apa: {
    description: 'APA 7th edition style',
    preamble: `\\documentclass[man,12pt]{apa7}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{hyperref}
\\usepackage{listings}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{amsmath}`,
  },
  nature: {
    description: 'Nature journal style (article)',
    preamble: `\\documentclass[twocolumn]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{times}
\\usepackage{geometry}
\\usepackage{hyperref}
\\usepackage{listings}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{amsmath}
\\usepackage{natbib}
\\geometry{top=2cm,bottom=2cm,left=1.8cm,right=1.8cm,columnsep=0.6cm}`,
  },
  elsevier: {
    description: 'Elsevier journal article',
    preamble: `\\documentclass[preprint,12pt]{elsarticle}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{hyperref}
\\usepackage{listings}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{amsmath}
\\usepackage{natbib}
\\biboptions{authoryear}`,
  },
};

/** Convert markdown text to LaTeX. Returns { tex, bibtex } */
function markdownToLatex(markdown: string): { tex: string; bibtex: string } {
  const bibEntries: string[] = [];
  const citationKeys = new Set<string>();

  let tex = markdown;

  // --- Code blocks (before inline code) ---
  tex = tex.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const lang_ = lang ? `[language=${lang}]` : '';
    return `\\begin{lstlisting}${lang_}\n${code.trim()}\n\\end{lstlisting}`;
  });

  // --- Math blocks ---
  tex = tex.replace(/\$\$([\s\S]*?)\$\$/g, (_m, math: string) => `\\[\n${math.trim()}\n\\]`);

  // --- Images ---
  tex = tex.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => {
    return `\\begin{figure}[h]\n\\centering\n\\includegraphics[width=0.8\\linewidth]{${src}}\n\\caption{${escapeLatex(alt)}}\n\\end{figure}`;
  });

  // --- Links ---
  tex = tex.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
    return `\\href{${url}}{${escapeLatex(text)}}`;
  });

  // --- Citations [@key] ---
  tex = tex.replace(/\[@([\w:.-]+)\]/g, (_m, key: string) => {
    citationKeys.add(key);
    return `\\cite{${key}}`;
  });

  // --- Headings ---
  tex = tex.replace(/^#### (.+)$/gm, (_m, h: string) => `\\paragraph{${escapeLatex(h.trim())}}`);
  tex = tex.replace(/^### (.+)$/gm, (_m, h: string) => `\\subsubsection{${escapeLatex(h.trim())}}`);
  tex = tex.replace(/^## (.+)$/gm, (_m, h: string) => `\\subsection{${escapeLatex(h.trim())}}`);
  tex = tex.replace(/^# (.+)$/gm, (_m, h: string) => `\\section{${escapeLatex(h.trim())}}`);

  // --- Bold and italic ---
  tex = tex.replace(/\*\*\*(.+?)\*\*\*/g, (_m, t: string) => `\\textbf{\\textit{${escapeLatex(t)}}}`);
  tex = tex.replace(/\*\*(.+?)\*\*/g, (_m, t: string) => `\\textbf{${escapeLatex(t)}}`);
  tex = tex.replace(/\*(.+?)\*/g, (_m, t: string) => `\\textit{${escapeLatex(t)}}`);
  tex = tex.replace(/_(.+?)_/g, (_m, t: string) => `\\textit{${escapeLatex(t)}}`);

  // --- Inline code ---
  tex = tex.replace(/`([^`]+)`/g, (_m, code: string) => `\\texttt{${escapeLatex(code)}}`);

  // --- Blockquotes ---
  tex = tex.replace(/^> (.+)$/gm, (_m, t: string) => `\\begin{quote}\n${t}\n\\end{quote}`);

  // --- Unordered lists ---
  tex = tex.replace(/((?:^[ \t]*[-*+] .+\n?)+)/gm, (block: string) => {
    const items = block.trim().split('\n').map((l: string) => `  \\item ${l.replace(/^[ \t]*[-*+] /, '').trim()}`);
    return `\\begin{itemize}\n${items.join('\n')}\n\\end{itemize}`;
  });

  // --- Ordered lists ---
  tex = tex.replace(/((?:^[ \t]*\d+\. .+\n?)+)/gm, (block: string) => {
    const items = block.trim().split('\n').map((l: string) => `  \\item ${l.replace(/^[ \t]*\d+\. /, '').trim()}`);
    return `\\begin{enumerate}\n${items.join('\n')}\n\\end{enumerate}`;
  });

  // --- Tables (GFM pipe tables) ---
  tex = tex.replace(/((?:^\|.+\|\n)+)/gm, (block: string) => {
    const rows = block.trim().split('\n').filter((r: string) => !/^\|[-| :]+\|$/.test(r.trim()));
    if (rows.length === 0) return block;
    const cells = (r: string) => r.split('|').slice(1, -1).map((c: string) => escapeLatex(c.trim()));
    const header = cells(rows[0]);
    const cols = header.length;
    const colSpec = Array(cols).fill('l').join(' ');
    let table = `\\begin{table}[h]\n\\centering\n\\begin{tabular}{${colSpec}}\n\\toprule\n`;
    table += header.join(' & ') + ' \\\\\n\\midrule\n';
    for (const row of rows.slice(1)) {
      table += cells(row).join(' & ') + ' \\\\\n';
    }
    table += `\\bottomrule\n\\end{tabular}\n\\end{table}`;
    return table;
  });

  // --- Horizontal rules ---
  tex = tex.replace(/^---+$/gm, '\\hrulefill');

  // Generate BibTeX stubs for detected citation keys
  for (const key of citationKeys) {
    bibEntries.push(`@article{${key},\n  author = {Author, A.},\n  title = {${key}},\n  journal = {Journal},\n  year = {2024},\n}`);
  }

  return { tex, bibtex: bibEntries.join('\n\n') };
}

function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

export const AVAILABLE_LATEX_THEMES = Object.entries(LATEX_THEMES).map(([id, { description }]) => ({ id, description }));

export const exportService = {
  async toMarkdown(documentId: string): Promise<{ title: string; content: string } | null> {
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId));

    if (!doc) return null;

    return { title: doc.title, content: doc.content };
  },

  async toPdf(documentId: string): Promise<{ title: string; buffer: Buffer } | null> {
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId));

    if (!doc) return null;

    return new Promise((resolve, reject) => {
      const pdfDoc = new PDFDocument({ margin: 50 });
      const chunks: Uint8Array[] = [];

      pdfDoc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
      pdfDoc.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ title: doc.title, buffer });
      });
      pdfDoc.on('error', reject);

      // Title
      pdfDoc
        .fontSize(24)
        .font('Helvetica-Bold')
        .text(doc.title, { align: 'left' });

      pdfDoc.moveDown();

      // Content
      pdfDoc
        .fontSize(12)
        .font('Helvetica')
        .text(doc.content, { align: 'left' });

      pdfDoc.end();
    });
  },

  async toLatex(
    documentId: string,
    theme: LatexTheme = 'plain',
  ): Promise<{ title: string; tex: string; bibtex: string } | null> {
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId));

    if (!doc) return null;

    const themeConfig = LATEX_THEMES[theme] ?? LATEX_THEMES.plain;
    const { tex: body, bibtex } = markdownToLatex(doc.content);

    const sanitizedTitle = escapeLatex(doc.title);
    const hasBib = bibtex.length > 0;

    const tex = [
      themeConfig.preamble,
      '',
      `\\title{${sanitizedTitle}}`,
      '\\date{\\today}',
      '',
      '\\begin{document}',
      '',
      '\\maketitle',
      '',
      body,
      '',
      hasBib ? '\\bibliographystyle{plain}' : '',
      hasBib ? '\\bibliography{references}' : '',
      '',
      '\\end{document}',
    ].filter((l) => l !== undefined).join('\n');

    return { title: doc.title, tex, bibtex };
  },
};
