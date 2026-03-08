import { useRef, useCallback, useEffect } from 'react';

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * Markdown editor with syntax highlighting.
 * Uses a transparent textarea overlaid on a highlighted pre element.
 * Both scroll in sync so the colors align with the typed text.
 */
export function MarkdownEditor({ value, onChange, placeholder }: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);

  // Sync scroll positions
  const handleScroll = useCallback(() => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  // Sync on content changes too
  useEffect(() => {
    handleScroll();
  }, [value, handleScroll]);

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Highlighted backdrop */}
      <pre
        ref={highlightRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words p-4 font-mono text-sm leading-relaxed text-transparent"
        style={{ wordBreak: 'break-word' }}
      >
        <code>
          {highlightMarkdown(value)}
          {/* Trailing newline so the pre matches the textarea's height */}
          {'\n'}
        </code>
      </pre>

      {/* Transparent textarea on top */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={handleScroll}
        placeholder={placeholder}
        spellCheck={false}
        className="absolute inset-0 w-full h-full resize-none bg-transparent p-4 font-mono text-sm leading-relaxed text-transparent outline-none placeholder:text-slate-400 selection:bg-blue-200/60 dark:selection:bg-blue-500/30"
        style={{ caretColor: 'var(--color-slate-800, #1e293b)', WebkitTextFillColor: 'transparent' }}
      />
    </div>
  );
}

// ── Markdown syntax highlighting ────────────────────────────

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

interface Token {
  type: TokenType;
  content: string;
}

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

function highlightMarkdown(source: string): React.ReactNode[] {
  const lines = source.split('\n');
  const result: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (i > 0) {
      result.push('\n');
    }

    // Code fence open/close
    if (line.match(/^```/)) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        const fence = '```';
        result.push(
          <span key={`fence-open-${i}`} className={TOKEN_STYLES['code-fence']}>
            {fence}
          </span>,
        );
        if (codeBlockLang) {
          result.push(
            <span key={`fence-lang-${i}`} className={TOKEN_STYLES['code-fence-lang']}>
              {codeBlockLang}
            </span>,
          );
        }
      } else {
        inCodeBlock = false;
        codeBlockLang = '';
        result.push(
          <span key={`fence-close-${i}`} className={TOKEN_STYLES['code-fence']}>
            {line}
          </span>,
        );
      }
      continue;
    }

    // Inside code block — all content is code-colored
    if (inCodeBlock) {
      result.push(
        <span key={`code-${i}`} className={TOKEN_STYLES['code-fence']}>
          {line}
        </span>,
      );
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s(.*)$/);
    if (headingMatch) {
      result.push(
        <span key={`hash-${i}`} className={TOKEN_STYLES['hash']}>
          {headingMatch[1]}{' '}
        </span>,
        <span key={`heading-${i}`} className={TOKEN_STYLES['heading']}>
          {highlightInline(headingMatch[2], i)}
        </span>,
      );
      continue;
    }

    // Horizontal rule
    if (line.match(/^[-*_]{3,}\s*$/)) {
      result.push(
        <span key={`hr-${i}`} className={TOKEN_STYLES.hr}>
          {line}
        </span>,
      );
      continue;
    }

    // Blockquote
    if (line.match(/^>\s?/)) {
      result.push(
        <span key={`bq-${i}`} className={TOKEN_STYLES.blockquote}>
          {line}
        </span>,
      );
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)([-*+])\s(.*)$/);
    if (ulMatch) {
      result.push(
        <span key={`ul-indent-${i}`} className={TOKEN_STYLES.text}>
          {ulMatch[1]}
        </span>,
        <span key={`ul-mark-${i}`} className={TOKEN_STYLES['list-marker']}>
          {ulMatch[2]}
        </span>,
        <span key={`ul-text-${i}`} className={TOKEN_STYLES.text}>
          {' '}{highlightInline(ulMatch[3], i)}
        </span>,
      );
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)(\d+\.)\s(.*)$/);
    if (olMatch) {
      result.push(
        <span key={`ol-indent-${i}`} className={TOKEN_STYLES.text}>
          {olMatch[1]}
        </span>,
        <span key={`ol-mark-${i}`} className={TOKEN_STYLES['list-marker']}>
          {olMatch[2]}
        </span>,
        <span key={`ol-text-${i}`} className={TOKEN_STYLES.text}>
          {' '}{highlightInline(olMatch[3], i)}
        </span>,
      );
      continue;
    }

    // Table row (contains pipes)
    if (line.includes('|') && line.trim().startsWith('|')) {
      const parts = line.split(/(\|)/);
      result.push(
        ...parts.map((part, j) =>
          part === '|' ? (
            <span key={`table-pipe-${i}-${j}`} className={TOKEN_STYLES['table-pipe']}>
              |
            </span>
          ) : (
            <span key={`table-cell-${i}-${j}`} className={TOKEN_STYLES.text}>
              {part}
            </span>
          ),
        ),
      );
      continue;
    }

    // Regular line — apply inline highlighting
    result.push(...highlightInline(line, i));
  }

  return result;
}

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
