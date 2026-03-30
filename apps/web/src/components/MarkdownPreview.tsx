import { useEffect, useState, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { codeToHtml, type BundledLanguage } from 'shiki';
import DOMPurify from 'dompurify';

interface MarkdownPreviewProps {
  content: string;
}

// Cache highlighted HTML to avoid re-highlighting identical blocks
const highlightCache = new Map<string, string>();

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [html, setHtml] = useState<string | null>(null);
  const codeRef = useRef<string>('');

  const code = String(children).replace(/\n$/, '');
  const langMatch = className?.match(/language-(\w+)/);
  const lang = langMatch?.[1] ?? '';

  const highlight = useCallback(async () => {
    if (!lang || !code) return;

    const cacheKey = `${lang}:${code}`;
    const cached = highlightCache.get(cacheKey);
    if (cached) {
      setHtml(cached);
      return;
    }

    try {
      const result = await codeToHtml(code, {
        lang: lang as BundledLanguage,
        theme: 'github-dark-default',
      });
      highlightCache.set(cacheKey, result);
      // Only update if the code hasn't changed while we were highlighting
      if (codeRef.current === code) {
        setHtml(result);
      }
    } catch {
      // Language not supported — fall back to plain rendering
      setHtml(null);
    }
  }, [lang, code]);

  useEffect(() => {
    codeRef.current = code;
    if (lang) {
      highlight();
    }
  }, [lang, code, highlight]);

  if (html && lang) {
    return (
      <div className="group relative my-3 overflow-hidden rounded-lg border border-slate-700/50">
        {/* Language badge */}
        <div className="flex items-center justify-between bg-slate-800 px-3 py-1.5">
          <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-slate-400">
            {lang}
          </span>
          <CopyButton text={code} />
        </div>
        {/* Highlighted code */}
        <div
          className="overflow-x-auto text-[13px] leading-relaxed [&>pre]:!m-0 [&>pre]:!rounded-none [&>pre]:!border-0 [&>pre]:px-4 [&>pre]:py-3"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html, {
            ALLOWED_TAGS: ['pre', 'code', 'span', 'div', 'br'],
            ALLOWED_ATTR: ['class', 'style'],
          }) }}
        />
      </div>
    );
  }

  // Fallback: plain code block (no language or highlighting failed)
  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-600 dark:bg-slate-800">
      {lang && (
        <div className="flex items-center justify-between bg-slate-100 px-3 py-1.5 dark:bg-slate-700">
          <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-slate-400">
            {lang}
          </span>
          <CopyButton text={code} />
        </div>
      )}
      <pre className="overflow-x-auto px-4 py-3 text-[13px] leading-relaxed">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function InlineCode({ children }: { children?: React.ReactNode }) {
  return (
    <code className="rounded-[4px] border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[0.85em] text-rose-600 dark:text-rose-400 dark:border-slate-600 dark:bg-slate-700/50">
      {children}
    </code>
  );
}

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  if (!content) {
    return (
      <p className="italic text-slate-300 text-sm">Nothing to preview yet.</p>
    );
  }

  return (
    <div className="prose prose-slate dark:prose-invert max-w-none text-sm leading-relaxed prose-pre:p-0 prose-pre:bg-transparent prose-pre:border-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children }) {
            // Detect if this is a fenced code block (has language class) or is inside a <pre>
            const isBlock = className?.startsWith('language-');
            if (isBlock) {
              return <CodeBlock className={className}>{children}</CodeBlock>;
            }
            // Inline code
            return <InlineCode>{children}</InlineCode>;
          },
          pre({ children }) {
            // If the child is already a CodeBlock, render it directly without wrapping <pre>
            return <>{children}</>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
