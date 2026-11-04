import {
  isValidElement,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { codeToHtml, type BundledLanguage } from 'shiki';
import { safeUrl, sanitizeHighlightHtml, splitForRender } from '../lib/markdownSafety';
import { parseMentionHref } from '../lib/slashCommands';

interface MarkdownPreviewProps {
  content: string;
  /** Called when a `nyx://doc/<id>` mention is activated. Without it mentions render as plain chips. */
  onMentionClick?: (documentId: string) => void;
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
          dangerouslySetInnerHTML={{ __html: sanitizeHighlightHtml(html) }}
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
      {!lang && (
        <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100">
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

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard can be unavailable (permissions, insecure context): fail quietly.
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <button
      type="button"
      aria-label={copied ? 'Code copied' : 'Copy code'}
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

function PreviewImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const [failed, setFailed] = useState(false);
  if (typeof src !== 'string' || !src || failed) {
    // Remote images need a network; keep the alt text so offline previews stay readable.
    return (
      <span className="rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-xs text-slate-400">
        {alt ? `Image: ${alt}` : 'Image unavailable'}
      </span>
    );
  }
  return <img src={src} alt={alt ?? ''} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

/** One top-level chunk of the document. Memoized so unchanged chunks are not re-parsed while typing. */
const MarkdownChunk = memo(function MarkdownChunk({
  text,
  components,
}: {
  text: string;
  components: Components;
}) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={components}>
      {text}
    </ReactMarkdown>
  );
});

export const MarkdownPreview = memo(function MarkdownPreview({ content, onMentionClick }: MarkdownPreviewProps) {
  // Keep typing responsive on big documents: the preview trails the editor by a frame.
  const deferred = useDeferredValue(content);
  const mentionRef = useRef(onMentionClick);
  mentionRef.current = onMentionClick;

  const components = useMemo<Components>(
    () => ({
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
          return <CodeBlock className={codeChild.className}>{codeChild.children}</CodeBlock>;
        }
        // Defensive fallback — render whatever the child was.
        return <>{children}</>;
      },
      a({ href, children }: ComponentProps<'a'>) {
        const docId = parseMentionHref(href);
        if (docId) {
          return (
            <a
              href={`#doc-${docId}`}
              data-mention={docId}
              className="rounded bg-blue-50 px-1 py-0.5 font-medium text-blue-700 no-underline"
              onClick={(e) => {
                e.preventDefault();
                mentionRef.current?.(docId);
              }}
            >
              {children}
            </a>
          );
        }
        const external = !!href && /^(https?:)?\/\//i.test(href);
        return (
          <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
            {children}
          </a>
        );
      },
      img({ src, alt }: ComponentProps<'img'>) {
        return <PreviewImage src={src} alt={alt} />;
      },
    }),
    [],
  );

  const chunks = useMemo(() => splitForRender(deferred), [deferred]);

  if (!deferred) {
    return <p className="text-sm italic text-slate-300">Nothing to preview yet.</p>;
  }

  return (
    <div
      data-testid="markdown-preview-body"
      className="prose prose-slate dark:prose-invert max-w-none text-sm leading-relaxed prose-p:my-3 prose-headings:mt-4 prose-headings:mb-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:p-0 prose-pre:bg-transparent prose-pre:border-0"
    >
      {chunks.map((text, i) => (
        <MarkdownChunk key={i} text={text} components={components} />
      ))}
    </div>
  );
});
