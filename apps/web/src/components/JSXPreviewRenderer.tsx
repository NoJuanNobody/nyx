import { useEffect, useRef, useState } from 'react';

interface JSXPreviewRendererProps {
  jsx: string;
}

function buildIframeHTML(jsx: string): string {
  // Strip export default — Babel in non-module mode transforms it to CommonJS
  // which references `exports` (undefined in browser), causing a ReferenceError.
  const cleanedJsx = jsx.replace(/^\s*export\s+default\s+/m, '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script>
    // Register error handler early — before CDN scripts or Babel run —
    // so syntax errors and CDN failures are always caught.
    window.onerror = function(msg, src, line, col, err) {
      window.parent.postMessage({ type: 'jsx-preview-error', error: String(msg) }, '*');
    };
  </script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js" onerror="window.parent.postMessage({type:'jsx-preview-error',error:'Failed to load Babel'},'*')"></script>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js" onerror="window.parent.postMessage({type:'jsx-preview-error',error:'Failed to load React'},'*')"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" onerror="window.parent.postMessage({type:'jsx-preview-error',error:'Failed to load ReactDOM'},'*')"></script>
  <script src="https://cdn.tailwindcss.com" onerror="window.parent.postMessage({type:'jsx-preview-error',error:'Failed to load Tailwind CSS'},'*')"></script>
  <style>
    body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    try {
      ${cleanedJsx}
      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(App));
    } catch (err) {
      window.parent.postMessage({ type: 'jsx-preview-error', error: err && err.message ? err.message : String(err) }, '*');
    }
  </script>
</body>
</html>`;
}

export function JSXPreviewRenderer({ jsx }: JSXPreviewRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setError(null);
    setIsLoading(true);

    // Revoke previous blob URL
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    const html = buildIframeHTML(jsx);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    blobUrlRef.current = url;

    const iframe = iframeRef.current;
    if (iframe) {
      iframe.src = url;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'jsx-preview-error') {
        setError(event.data.error as string);
        setIsLoading(false);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [jsx]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      {isLoading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-50">
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="h-2 w-2 animate-bounce rounded-full bg-blue-400 [animation-delay:0ms]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-blue-400 [animation-delay:150ms]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-blue-400 [animation-delay:300ms]" />
            </div>
            <span className="text-xs text-slate-400">Rendering preview…</span>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-50 p-4">
          <div className="max-w-sm rounded-lg border border-red-200 bg-white p-4 shadow-sm">
            <div className="mb-1 flex items-center gap-2">
              <svg className="h-4 w-4 text-red-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
              </svg>
              <span className="text-xs font-semibold text-red-700">Transpilation error</span>
            </div>
            <p className="font-mono text-[11px] leading-relaxed text-red-600">{error}</p>
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        title="JSX Preview"
        className="h-full w-full border-0"
        onLoad={() => setIsLoading(false)}
      />
    </div>
  );
}
