import { useState, useRef, useEffect } from 'react';
import {
  downloadDocumentLatex,
  downloadDocumentMarkdown,
  downloadDocumentPdf,
  type LatexTheme,
} from '../lib/api';

const LATEX_THEMES: { id: LatexTheme; label: string; description: string }[] = [
  { id: 'plain', label: 'Plain Article', description: 'Standard LaTeX article' },
  { id: 'ieee', label: 'IEEE', description: 'IEEE two-column conference/journal' },
  { id: 'acm', label: 'ACM', description: 'ACM article format' },
  { id: 'apa', label: 'APA', description: 'APA 7th edition style' },
  { id: 'nature', label: 'Nature', description: 'Nature journal style' },
  { id: 'elsevier', label: 'Elsevier', description: 'Elsevier journal article' },
];

interface ExportMenuProps {
  documentId: string;
}

export function ExportMenu({ documentId }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [latexOpen, setLatexOpen] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setLatexOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function handleExport(action: () => Promise<void>, key: string) {
    setLoading(key);
    try {
      await action();
    } catch (err) {
      console.error('Export failed', err);
    } finally {
      setLoading(null);
      setOpen(false);
      setLatexOpen(false);
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setLatexOpen(false); }}
        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 flex items-center gap-1.5"
      >
        Export
        <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {/* Markdown */}
          <button
            type="button"
            disabled={loading === 'md'}
            onClick={() => handleExport(() => downloadDocumentMarkdown(documentId), 'md')}
            className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <span className="text-base">📝</span>
            {loading === 'md' ? 'Exporting…' : 'Markdown (.md)'}
          </button>

          {/* PDF */}
          <button
            type="button"
            disabled={loading === 'pdf'}
            onClick={() => handleExport(() => downloadDocumentPdf(documentId), 'pdf')}
            className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <span className="text-base">📄</span>
            {loading === 'pdf' ? 'Exporting…' : 'PDF (.pdf)'}
          </button>

          {/* Divider */}
          <div className="my-1 h-px bg-slate-100" />

          {/* LaTeX submenu trigger */}
          <button
            type="button"
            onClick={() => setLatexOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-2.5 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            <span className="flex items-center gap-2.5">
              <span className="text-base">🔬</span>
              LaTeX (.tex)
            </span>
            <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          </button>

          {/* LaTeX theme picker */}
          {latexOpen && (
            <div className="border-t border-slate-100 bg-slate-50 py-1">
              <p className="px-4 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Select theme
              </p>
              {LATEX_THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  disabled={loading === `latex-${theme.id}`}
                  onClick={() =>
                    handleExport(
                      () => downloadDocumentLatex(documentId, theme.id),
                      `latex-${theme.id}`,
                    )
                  }
                  className="flex w-full flex-col items-start px-4 py-1.5 hover:bg-slate-100 disabled:opacity-50"
                >
                  <span className="text-sm font-medium text-slate-700">
                    {loading === `latex-${theme.id}` ? 'Exporting…' : theme.label}
                  </span>
                  <span className="text-[11px] text-slate-400">{theme.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
