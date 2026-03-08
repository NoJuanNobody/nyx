import { useState, useCallback, useEffect } from 'react';

interface MarkdownToolbarProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
}

/**
 * Wraps the current selection in a textarea with the given prefix/suffix.
 * After inserting, restores focus and places the cursor appropriately.
 */
function wrapSelection(
  textarea: HTMLTextAreaElement,
  prefix: string,
  suffix: string,
  onChange: (value: string) => void,
) {
  const { selectionStart, selectionEnd, value } = textarea;
  const selected = value.slice(selectionStart, selectionEnd);

  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const newValue = before + prefix + selected + suffix + after;

  onChange(newValue);

  // Restore cursor position after React re-renders
  requestAnimationFrame(() => {
    textarea.focus();
    if (selected.length > 0) {
      // Keep the selection highlighted (inside the wrapping syntax)
      textarea.selectionStart = selectionStart + prefix.length;
      textarea.selectionEnd = selectionEnd + prefix.length;
    } else {
      // Place cursor between prefix and suffix
      const cursorPos = selectionStart + prefix.length;
      textarea.selectionStart = cursorPos;
      textarea.selectionEnd = cursorPos;
    }
  });
}

/**
 * Inserts a prefix at the start of the current line.
 * If the line already has a heading/list prefix, it replaces it.
 */
function insertLinePrefix(
  textarea: HTMLTextAreaElement,
  prefix: string,
  onChange: (value: string) => void,
) {
  const { selectionStart, value } = textarea;

  // Find the start of the current line
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const lineEnd = value.indexOf('\n', selectionStart);
  const actualLineEnd = lineEnd === -1 ? value.length : lineEnd;
  const currentLine = value.slice(lineStart, actualLineEnd);

  // Strip existing line-level prefixes (headings, lists, blockquote)
  const stripped = currentLine.replace(/^(#{1,6}\s|>\s?|- |\d+\.\s)/, '');
  const newLine = prefix + stripped;

  const before = value.slice(0, lineStart);
  const after = value.slice(actualLineEnd);
  const newValue = before + newLine + after;

  onChange(newValue);

  requestAnimationFrame(() => {
    textarea.focus();
    const cursorPos = lineStart + newLine.length;
    textarea.selectionStart = cursorPos;
    textarea.selectionEnd = cursorPos;
  });
}

export function MarkdownToolbar({ textareaRef, value, onChange }: MarkdownToolbarProps) {
  const [headingOpen, setHeadingOpen] = useState(false);

  const handleWrap = useCallback(
    (prefix: string, suffix: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      wrapSelection(ta, prefix, suffix, onChange);
    },
    [textareaRef, onChange],
  );

  const handleLinePrefix = useCallback(
    (prefix: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      insertLinePrefix(ta, prefix, onChange);
      setHeadingOpen(false);
    },
    [textareaRef, onChange],
  );

  // Close heading dropdown on outside click
  useEffect(() => {
    if (!headingOpen) return;
    const close = () => setHeadingOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [headingOpen]);

  // Keyboard shortcuts on the textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === 'b') {
        e.preventDefault();
        wrapSelection(ta, '**', '**', onChange);
      } else if (e.key === 'i') {
        e.preventDefault();
        wrapSelection(ta, '*', '*', onChange);
      } else if (e.key === 'k') {
        e.preventDefault();
        const { selectionStart, selectionEnd, value: val } = ta;
        const selected = val.slice(selectionStart, selectionEnd);
        const before = val.slice(0, selectionStart);
        const after = val.slice(selectionEnd);
        const linkText = selected || 'text';
        const newValue = before + '[' + linkText + '](url)' + after;
        onChange(newValue);
        requestAnimationFrame(() => {
          ta.focus();
          // Select "url" so user can type the URL
          const urlStart = selectionStart + 1 + linkText.length + 2;
          const urlEnd = urlStart + 3;
          ta.selectionStart = urlStart;
          ta.selectionEnd = urlEnd;
        });
      } else if (e.key === '`') {
        e.preventDefault();
        wrapSelection(ta, '`', '`', onChange);
      }
    };

    ta.addEventListener('keydown', handleKeyDown);
    return () => ta.removeEventListener('keydown', handleKeyDown);
  }, [textareaRef, onChange, value]);

  const btnClass =
    'px-2 py-1 text-xs font-medium rounded transition-colors text-slate-500 hover:text-slate-800 hover:bg-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-400';

  return (
    <div className="flex flex-shrink-0 items-center gap-0.5 border-b border-slate-200 bg-slate-50/80 px-2 py-1">
      {/* Bold */}
      <button
        type="button"
        title="Bold (Cmd+B)"
        onClick={() => handleWrap('**', '**')}
        className={btnClass}
      >
        <span className="font-bold">B</span>
      </button>

      {/* Italic */}
      <button
        type="button"
        title="Italic (Cmd+I)"
        onClick={() => handleWrap('*', '*')}
        className={btnClass}
      >
        <span className="italic">I</span>
      </button>

      {/* Divider */}
      <div className="mx-1 h-4 w-px bg-slate-200" />

      {/* Heading dropdown */}
      <div className="relative">
        <button
          type="button"
          title="Heading"
          onClick={(e) => {
            e.stopPropagation();
            setHeadingOpen((prev) => !prev);
          }}
          className={btnClass}
        >
          H
          <span className="ml-0.5 text-[9px]">&#9662;</span>
        </button>
        {headingOpen && (
          <div className="absolute left-0 top-full z-20 mt-1 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
            <button
              type="button"
              onClick={() => handleLinePrefix('# ')}
              className="block w-full px-4 py-1 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              <span className="font-semibold">H1</span>
              <span className="ml-2 text-xs text-slate-400">Heading 1</span>
            </button>
            <button
              type="button"
              onClick={() => handleLinePrefix('## ')}
              className="block w-full px-4 py-1 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              <span className="font-semibold">H2</span>
              <span className="ml-2 text-xs text-slate-400">Heading 2</span>
            </button>
            <button
              type="button"
              onClick={() => handleLinePrefix('### ')}
              className="block w-full px-4 py-1 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              <span className="font-semibold">H3</span>
              <span className="ml-2 text-xs text-slate-400">Heading 3</span>
            </button>
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="mx-1 h-4 w-px bg-slate-200" />

      {/* Code */}
      <button
        type="button"
        title="Inline Code (Cmd+`)"
        onClick={() => handleWrap('`', '`')}
        className={btnClass}
      >
        <span className="font-mono text-[10px]">&lt;/&gt;</span>
      </button>

      {/* Code Block */}
      <button
        type="button"
        title="Code Block"
        onClick={() => handleWrap('```\n', '\n```')}
        className={btnClass}
      >
        <span className="font-mono text-[10px]">&#123;&#125;</span>
      </button>

      {/* Divider */}
      <div className="mx-1 h-4 w-px bg-slate-200" />

      {/* Link */}
      <button
        type="button"
        title="Link (Cmd+K)"
        onClick={() => {
          const ta = textareaRef.current;
          if (!ta) return;
          const { selectionStart, selectionEnd, value: val } = ta;
          const selected = val.slice(selectionStart, selectionEnd);
          const before = val.slice(0, selectionStart);
          const after = val.slice(selectionEnd);
          const linkText = selected || 'text';
          const newValue = before + '[' + linkText + '](url)' + after;
          onChange(newValue);
          requestAnimationFrame(() => {
            ta.focus();
            const urlStart = selectionStart + 1 + linkText.length + 2;
            const urlEnd = urlStart + 3;
            ta.selectionStart = urlStart;
            ta.selectionEnd = urlEnd;
          });
        }}
        className={btnClass}
      >
        Link
      </button>

      {/* Divider */}
      <div className="mx-1 h-4 w-px bg-slate-200" />

      {/* Unordered List */}
      <button
        type="button"
        title="Bullet List"
        onClick={() => handleLinePrefix('- ')}
        className={btnClass}
      >
        UL
      </button>

      {/* Ordered List */}
      <button
        type="button"
        title="Numbered List"
        onClick={() => handleLinePrefix('1. ')}
        className={btnClass}
      >
        OL
      </button>

      {/* Blockquote */}
      <button
        type="button"
        title="Blockquote"
        onClick={() => handleLinePrefix('> ')}
        className={btnClass}
      >
        &ldquo;&rdquo;
      </button>

      {/* Shortcuts hint */}
      <div className="ml-auto text-[10px] text-slate-300">
        <span className="hidden sm:inline">Cmd+B Bold &middot; Cmd+I Italic &middot; Cmd+K Link</span>
      </div>
    </div>
  );
}
