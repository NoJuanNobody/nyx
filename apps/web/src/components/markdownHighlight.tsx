import { memo, type ReactNode } from 'react';

/**
 * Syntax-highlight backdrop for the Markdown editor.
 *
 * The document is classified line by line (cheap, O(n)) and every line is
 * rendered by a memoized component, so typing re-renders only the lines whose
 * text or code-fence state changed. This keeps large documents responsive.
 */

type TokenType =
  | 'heading'
  | 'bold'
  | 'italic'
  | 'code-inline'
  | 'code-fence'
  | 'code-fence-lang'
  | 'link-text'
  | 'link-url'
  | 'list-marker'
  | 'blockquote'
  | 'hr'
  | 'image-alt'
  | 'table-pipe'
  | 'hash'
  | 'text';


const TOKEN_STYLES: Record<TokenType, string> = {
  heading: 'text-blue-600 font-semibold',
  hash: 'text-blue-400/70',
  bold: 'text-slate-900 font-bold',
  italic: 'text-slate-600 italic',
  'code-inline': 'text-rose-600 bg-rose-50/60 rounded px-0.5',
  'code-fence': 'text-emerald-700',
  'code-fence-lang': 'text-emerald-500 font-medium',
  'link-text': 'text-blue-600 underline',
  'link-url': 'text-slate-400',
  'list-marker': 'text-amber-600 font-bold',
  blockquote: 'text-slate-400 italic',
  hr: 'text-slate-300',
  'image-alt': 'text-purple-600',
  'table-pipe': 'text-slate-400',
  text: 'text-slate-800',
};


export type LineMode = 'fence-open' | 'fence-close' | 'code' | 'normal';

export interface ClassifiedLine {
  text: string;
  mode: LineMode;
}

export function classifyLines(source: string): ClassifiedLine[] {
  const lines = source.split('\n');
  let inCode = false;
  return lines.map((text) => {
    if (/^```/.test(text)) {
      const mode: LineMode = inCode ? 'fence-close' : 'fence-open';
      inCode = !inCode;
      return { text, mode };
    }
    return { text, mode: inCode ? 'code' : 'normal' };
  });
}

function renderLine(line: string, mode: LineMode, i: number): ReactNode[] {
  if (mode === 'fence-open') {
    const lang = line.slice(3).trim();
    const out: ReactNode[] = [
      <span key="fo" className={TOKEN_STYLES['code-fence']}>{'```'}</span>,
    ];
    if (lang) {
      out.push(<span key="fl" className={TOKEN_STYLES['code-fence-lang']}>{lang}</span>);
    }
    return out;
  }
  if (mode === 'fence-close' || mode === 'code') {
    return [<span key="c" className={TOKEN_STYLES['code-fence']}>{line}</span>];
  }

  const headingMatch = line.match(/^(#{1,6})\s(.*)$/);
  if (headingMatch) {
    return [
      <span key="h" className={TOKEN_STYLES['hash']}>{headingMatch[1]}{' '}</span>,
      <span key="ht" className={TOKEN_STYLES['heading']}>{highlightInline(headingMatch[2], i)}</span>,
    ];
  }
  if (line.match(/^[-*_]{3,}\s*$/)) {
    return [<span key="hr" className={TOKEN_STYLES.hr}>{line}</span>];
  }
  if (line.match(/^>\s?/)) {
    return [<span key="bq" className={TOKEN_STYLES.blockquote}>{line}</span>];
  }
  const ulMatch = line.match(/^(\s*)([-*+])\s(.*)$/);
  if (ulMatch) {
    return [
      <span key="i" className={TOKEN_STYLES.text}>{ulMatch[1]}</span>,
      <span key="m" className={TOKEN_STYLES['list-marker']}>{ulMatch[2]}</span>,
      <span key="t" className={TOKEN_STYLES.text}>{' '}{highlightInline(ulMatch[3], i)}</span>,
    ];
  }
  const olMatch = line.match(/^(\s*)(\d+\.)\s(.*)$/);
  if (olMatch) {
    return [
      <span key="i" className={TOKEN_STYLES.text}>{olMatch[1]}</span>,
      <span key="m" className={TOKEN_STYLES['list-marker']}>{olMatch[2]}</span>,
      <span key="t" className={TOKEN_STYLES.text}>{' '}{highlightInline(olMatch[3], i)}</span>,
    ];
  }
  if (line.includes('|') && line.trim().startsWith('|')) {
    return line.split(/(\|)/).map((part, j) =>
      part === '|' ? (
        <span key={`p${j}`} className={TOKEN_STYLES['table-pipe']}>|</span>
      ) : (
        <span key={`c${j}`} className={TOKEN_STYLES.text}>{part}</span>
      ),
    );
  }
  return highlightInline(line, i);
}

export const HighlightLine = memo(function HighlightLine({
  text,
  mode,
}: {
  text: string;
  mode: LineMode;
}) {
  // Line index only seeds React keys inside one line; it never needs to be globally unique.
  return <>{renderLine(text, mode, 0)}</>;
});

export const Highlighted = memo(function Highlighted({ source }: { source: string }) {
  const lines = classifyLines(source);
  return (
    <>
      {lines.map((l, i) => (
        <span key={i}>
          {i > 0 ? '\n' : ''}
          <HighlightLine text={l.text} mode={l.mode} />
        </span>
      ))}
    </>
  );
});

function highlightInline(text: string, lineIndex: number): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Regex for inline patterns: bold, italic, inline code, links, images
  const inlineRegex = /(\*\*\*.+?\*\*\*|\*\*.+?\*\*|\*.+?\*|___.+?___|__.+?__|_.+?_|`[^`]+`|!\[([^\]]*)\]\([^)]+\)|\[([^\]]+)\]\(([^)]+)\))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(text)) !== null) {
    // Text before the match
    if (match.index > lastIndex) {
      nodes.push(
        <span key={`t-${lineIndex}-${lastIndex}`} className={TOKEN_STYLES.text}>
          {text.slice(lastIndex, match.index)}
        </span>,
      );
    }

    const token = match[0];

    if (token.startsWith('![')) {
      // Image
      nodes.push(
        <span key={`img-${lineIndex}-${match.index}`} className={TOKEN_STYLES['image-alt']}>
          {token}
        </span>,
      );
    } else if (token.startsWith('[')) {
      // Link — [text](url)
      const linkText = match[3];
      const linkUrl = match[4];
      nodes.push(
        <span key={`link-${lineIndex}-${match.index}`}>
          <span className={TOKEN_STYLES.text}>[</span>
          <span className={TOKEN_STYLES['link-text']}>{linkText}</span>
          <span className={TOKEN_STYLES.text}>](</span>
          <span className={TOKEN_STYLES['link-url']}>{linkUrl}</span>
          <span className={TOKEN_STYLES.text}>)</span>
        </span>,
      );
    } else if (token.startsWith('`')) {
      // Inline code
      nodes.push(
        <span key={`ic-${lineIndex}-${match.index}`} className={TOKEN_STYLES['code-inline']}>
          {token}
        </span>,
      );
    } else if (token.startsWith('***') || token.startsWith('___')) {
      // Bold italic
      nodes.push(
        <span key={`bi-${lineIndex}-${match.index}`} className="text-slate-900 font-bold italic">
          {token}
        </span>,
      );
    } else if (token.startsWith('**') || token.startsWith('__')) {
      // Bold
      nodes.push(
        <span key={`b-${lineIndex}-${match.index}`} className={TOKEN_STYLES.bold}>
          {token}
        </span>,
      );
    } else if (token.startsWith('*') || token.startsWith('_')) {
      // Italic
      nodes.push(
        <span key={`i-${lineIndex}-${match.index}`} className={TOKEN_STYLES.italic}>
          {token}
        </span>,
      );
    }

    lastIndex = match.index + token.length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    nodes.push(
      <span key={`t-${lineIndex}-${lastIndex}`} className={TOKEN_STYLES.text}>
        {text.slice(lastIndex)}
      </span>,
    );
  }

  if (nodes.length === 0) {
    nodes.push(
      <span key={`empty-${lineIndex}`} className={TOKEN_STYLES.text}>
        {text}
      </span>,
    );
  }

  return nodes;
}
