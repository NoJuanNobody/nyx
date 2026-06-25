import { isValidElement, useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
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

  // Fallback: plain code block (no language or highlighting failed).
  //
  // The wrapping `.prose` container in MarkdownPreview sets
  // `prose-pre:bg-transparent` so the Shiki-rendered path above can supply
  // its own dark background via inline styles. That override made the
  // fallback's `<pre>` background transparent too, which normally doesn't
  // matter — except `prose-slate` also sets `--tw-prose-pre-code: #e2e8f0`
  // (near-white) on `.prose pre code`. In light mode that left the fallback
  // rendering near-white text on the near-white wrapper background,
  // producing unreadable code blocks for unlabeled fences (e.g. ASCII
  // diagrams). Opt out of prose cascade for this subtree via `not-prose`
  // and pin an explicit contrast-safe color on the `<pre>`.
  return (
    <div className="not-prose group relative my-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-600 dark:bg-slate-800">
      {lang && (
        <div className="flex items-center justify-between bg-slate-100 px-3 py-1.5 dark:bg-slate-700">
          <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-slate-400">
            {lang}
          </span>
          <CopyButton text={code} />
        </div>
      )}
      <pre className="overflow-x-auto px-4 py-3 text-[13px] leading-relaxed text-slate-800 dark:text-slate-100">
        <code className={className}>{code}</code>
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

// Extract the inner <code> element from a <pre>'s children. react-markdown v10
// always emits fenced blocks as <pre><code class="language-xxx?">...</code></pre>,
// but by the time the `pre` override is invoked, the inner <code> has already
// been wrapped in the custom `code` component. We can still recognize it by
// inspecting the hast `node` prop that react-markdown passes through, which
// retains the original tagName.
type RehypeCodeProps = {
  node?: { tagName?: string };
  className?: string;
  children?: ReactNode;
};

function extractCodeChild(
  children: ReactNode,
): { className?: string; children?: ReactNode } | null {
  let found: { className?: string; children?: ReactNode } | null = null;
  const visit = (node: ReactNode) => {
    if (found) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (isValidElement(node)) {
      const props = node.props as RehypeCodeProps;
      // The element is a <code> if either (a) the React type is the string
      // 'code' or (b) react-markdown's hast node identifies it as such.
      const isCode = node.type === 'code' || props?.node?.tagName === 'code';
      if (isCode) {
        found = { className: props.className, children: props.children };
        return;
      }
      // Could be a wrapping fragment or unknown wrapper — recurse into its children.
      if (props && 'children' in props) {
        visit(props.children);
      }
    }
  };
  visit(children);
  return found;
}

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  if (!content) {
    return (
      <p className="italic text-slate-300 text-sm">Nothing to preview yet.</p>
    );
  }

  return (
    <div className="prose prose-slate dark:prose-invert max-w-none text-sm leading-relaxed prose-p:my-3 prose-headings:mt-4 prose-headings:mb-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:p-0 prose-pre:bg-transparent prose-pre:border-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ children }) {
            // Block code is intercepted one level up by the pre() override, so
            // anything that reaches here is true inline code.
            return <InlineCode>{children}</InlineCode>;
          },
          pre({ children }) {
            // Fenced code blocks always arrive as <pre><code>...</code></pre>.
            // Extract the inner <code> child and route it through CodeBlock so
            // we don't depend on a language-* className being present.
            const codeChild = extractCodeChild(children);
            if (codeChild) {
              return (
                <CodeBlock className={codeChild.className}>{codeChild.children}</CodeBlock>
              );
            }
            // Defensive fallback — render whatever the child was.
            return <>{children}</>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
