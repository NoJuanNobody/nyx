import { useState, useRef, useCallback } from 'react';
import { uploadDocumentFile } from '../lib/api';

interface FileUploadZoneProps {
  documentId: string;
  onImport: (content: string, mode: 'append' | 'replace') => void;
  onClose: () => void;
}

const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.csv', '.docx', '.pdf', '.xlsx'];

export function FileUploadZone({ documentId, onImport, onClose }: FileUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [parsedContent, setParsedContent] = useState<string | null>(null);
  const [parsedTitle, setParsedTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setIsUploading(true);
      setFilename(file.name);

      try {
        const result = await uploadDocumentFile(documentId, file);
        setParsedContent(result.content);
        setParsedTitle(result.title);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed.');
        setFilename(null);
      } finally {
        setIsUploading(false);
      }
    },
    [documentId],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleImport = (mode: 'append' | 'replace') => {
    if (parsedContent !== null) {
      onImport(parsedContent, mode);
    }
  };

  const reset = () => {
    setParsedContent(null);
    setParsedTitle(null);
    setError(null);
    setFilename(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-800">Import File</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5">
          {parsedContent === null ? (
            <>
              {/* Drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
                  isDragging
                    ? 'border-blue-400 bg-blue-50'
                    : 'border-slate-200 bg-slate-50 hover:border-slate-300'
                }`}
                onClick={() => inputRef.current?.click()}
              >
                {isUploading ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                    <p className="text-sm text-slate-500">Parsing {filename}…</p>
                  </div>
                ) : (
                  <>
                    <svg className="mb-3 h-8 w-8 text-slate-300" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                    </svg>
                    <p className="text-sm font-medium text-slate-600">
                      Drag & drop a file, or <span className="text-blue-600">click to browse</span>
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      {SUPPORTED_EXTENSIONS.join(', ')} &middot; max 10MB
                    </p>
                  </>
                )}
              </div>

              <input
                ref={inputRef}
                type="file"
                accept={SUPPORTED_EXTENSIONS.join(',')}
                className="hidden"
                onChange={handleInputChange}
              />

              {error && (
                <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
              )}
            </>
          ) : (
            <>
              {/* Preview */}
              <div className="mb-4 flex items-center gap-2 text-sm text-slate-600">
                <svg className="h-4 w-4 flex-shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
                <span>
                  Parsed <strong>{filename}</strong>
                  {parsedTitle && <span className="text-slate-400"> &middot; detected title: "{parsedTitle}"</span>}
                </span>
              </div>

              <div className="mb-4 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3">
                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-600">
                  {parsedContent.length > 800
                    ? parsedContent.slice(0, 800) + '\n\n…(truncated preview)'
                    : parsedContent}
                </pre>
              </div>

              <p className="mb-3 text-xs text-slate-500">How would you like to add this content?</p>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleImport('append')}
                  className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
                >
                  Append to document
                </button>
                <button
                  type="button"
                  onClick={() => handleImport('replace')}
                  className="flex-1 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  Replace document
                </button>
              </div>

              <button
                type="button"
                onClick={reset}
                className="mt-2 w-full rounded-lg px-4 py-1.5 text-xs text-slate-400 hover:text-slate-600"
              >
                Upload a different file
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
