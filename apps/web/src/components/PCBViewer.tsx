import { useState, useRef, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchPcbAttachments,
  uploadPcbFiles,
  deletePcbAttachment,
  getPcbRawUrl,
  type PcbAttachment,
} from '../lib/api';

// ── Constants ────────────────────────────────────────────────────────

const LAYER_TYPE_COLORS: Record<string, string> = {
  copper: 'bg-amber-400 text-amber-900',
  silkscreen: 'bg-slate-200 text-slate-800',
  soldermask: 'bg-green-600 text-white',
  drill: 'bg-slate-800 text-white',
  outline: 'bg-yellow-500 text-yellow-900',
  project: 'bg-blue-600 text-white',
};

const LAYER_TYPE_LABELS: Record<string, string> = {
  copper: 'Copper',
  silkscreen: 'Silkscreen',
  soldermask: 'Solder Mask',
  drill: 'Drill',
  outline: 'Outline',
  project: 'Project File',
};

const ACCEPTED_EXTENSIONS = '.gbr,.ger,.gtl,.gbl,.gts,.gbs,.gto,.gbo,.gko,.drl,.xln,.exc,.kicad_pcb,.brd,.PcbDoc';

// ── Helpers ──────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function LayerBadge({ type }: { type: string | null }) {
  const label = type ? (LAYER_TYPE_LABELS[type] ?? type) : 'Unknown';
  const cls = type ? (LAYER_TYPE_COLORS[type] ?? 'bg-slate-500 text-white') : 'bg-slate-500 text-white';
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>
      {label}
    </span>
  );
}

// ── Sub-components ───────────────────────────────────────────────────

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  return (
    <div
      className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
        dragging
          ? 'border-blue-500 bg-blue-500/10'
          : 'border-slate-600 hover:border-slate-400 hover:bg-slate-800/40'
      }`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
      aria-label="Upload PCB files"
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_EXTENSIONS}
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
          e.target.value = '';
        }}
      />
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-700 text-2xl">
        🔌
      </div>
      <p className="text-sm font-medium text-slate-300">Drop PCB files here or click to browse</p>
      <p className="mt-1 text-xs text-slate-500">
        Gerber (.gbr .gtl .gbl .gts .gbs .gto .gbo .gko .drl), KiCad (.kicad_pcb), Eagle (.brd), Altium (.PcbDoc)
      </p>
    </div>
  );
}

function BomTable({ bom }: { bom: PcbAttachment['metadata']['bom'] }) {
  if (bom.length === 0) return null;

  const totalQty = bom.reduce((s, r) => s + r.quantity, 0);

  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Bill of Materials ({bom.length} line items · {totalQty} components)
      </h4>
      <div className="overflow-auto rounded-lg border border-slate-700">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-800">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-slate-400">Reference</th>
              <th className="px-3 py-2 text-left font-medium text-slate-400">Value</th>
              <th className="px-3 py-2 text-left font-medium text-slate-400">Package</th>
              <th className="px-3 py-2 text-right font-medium text-slate-400">Qty</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {bom.map((item, i) => (
              <tr key={i} className="hover:bg-slate-800/50">
                <td className="px-3 py-1.5 font-mono text-slate-300">{item.reference}</td>
                <td className="px-3 py-1.5 text-slate-200">{item.value}</td>
                <td className="px-3 py-1.5 text-slate-400">{item.package}</td>
                <td className="px-3 py-1.5 text-right font-medium text-slate-300">{item.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AttachmentRow({
  attachment,
  visible,
  onToggle,
  onDelete,
}: {
  attachment: PcbAttachment;
  visible: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${visible ? 'border-slate-600 bg-slate-800/60' : 'border-slate-700/50 bg-slate-800/20 opacity-60'}`}>
      {/* Visibility toggle */}
      <button
        type="button"
        onClick={onToggle}
        title={visible ? 'Hide layer' : 'Show layer'}
        className="shrink-0 text-slate-400 hover:text-slate-200"
      >
        {visible ? '👁' : '🚫'}
      </button>

      {/* File info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 truncate">
          <span className="truncate text-sm font-medium text-slate-200">{attachment.filename}</span>
          {attachment.layerName && (
            <span className="shrink-0 font-mono text-[10px] text-slate-500">{attachment.layerName}</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <LayerBadge type={attachment.layerType} />
          <span className="text-[10px] text-slate-500">{formatBytes(attachment.fileSize)}</span>
        </div>
      </div>

      {/* Download */}
      <a
        href={getPcbRawUrl(attachment.id)}
        download={attachment.filename}
        title="Download file"
        className="shrink-0 text-slate-500 hover:text-slate-300 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        ⬇
      </a>

      {/* Delete */}
      <button
        type="button"
        onClick={onDelete}
        title="Remove attachment"
        className="shrink-0 text-slate-600 hover:text-red-400 text-sm transition-colors"
      >
        ✕
      </button>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────

interface PCBViewerProps {
  documentId: string;
  readOnly?: boolean;
}

export function PCBViewer({ documentId, readOnly = false }: PCBViewerProps) {
  const queryClient = useQueryClient();
  const [visibleLayers, setVisibleLayers] = useState<Set<string>>(new Set());
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [selectedAttachment, setSelectedAttachment] = useState<PcbAttachment | null>(null);

  const { data: attachments = [], isLoading } = useQuery({
    queryKey: ['pcb-attachments', documentId],
    queryFn: () => fetchPcbAttachments(documentId),
  });

  // Sync visible layers and auto-select project file when attachments load
  useEffect(() => {
    if (attachments.length === 0) return;
    setVisibleLayers(new Set(attachments.map((a) => a.id)));
    const project = attachments.find((a) => a.layerType === 'project');
    if (project) setSelectedAttachment((prev) => prev ?? project);
  }, [attachments]);

  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => uploadPcbFiles(documentId, files),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['pcb-attachments', documentId] });
      setUploadErrors(result.errors ?? []);
    },
    onError: (err: Error) => {
      setUploadErrors([err.message]);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deletePcbAttachment,
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['pcb-attachments', documentId] });
      if (selectedAttachment?.id === id) setSelectedAttachment(null);
      setVisibleLayers((prev) => { const next = new Set(prev); next.delete(id); return next; });
    },
  });

  const toggleLayer = useCallback((id: string) => {
    setVisibleLayers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const projectFile = selectedAttachment ?? attachments.find((a) => a.layerType === 'project') ?? null;
  const bom = projectFile?.metadata.bom ?? [];
  const hasBom = bom.length > 0;
  const boardDims = projectFile?.metadata;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-xl">🔌</span>
        <h3 className="text-base font-semibold text-slate-100">PCB Design Files</h3>
        {attachments.length > 0 && (
          <span className="ml-1 rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
            {attachments.length} file{attachments.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Board metadata */}
      {projectFile && (boardDims?.boardWidthMm || boardDims?.componentCount) && (
        <div className="flex flex-wrap gap-4 rounded-lg border border-slate-700 bg-slate-800/40 px-4 py-3 text-sm">
          {boardDims?.boardWidthMm && boardDims?.boardHeightMm && (
            <div>
              <span className="text-slate-400">Board size</span>
              <span className="ml-2 font-medium text-slate-200">
                {boardDims.boardWidthMm.toFixed(1)} × {boardDims.boardHeightMm.toFixed(1)} mm
              </span>
            </div>
          )}
          {boardDims?.componentCount != null && boardDims.componentCount > 0 && (
            <div>
              <span className="text-slate-400">Components</span>
              <span className="ml-2 font-medium text-slate-200">{boardDims.componentCount}</span>
            </div>
          )}
          <div>
            <span className="text-slate-400">Format</span>
            <span className="ml-2 font-medium text-slate-200 uppercase">{projectFile.fileType}</span>
          </div>
        </div>
      )}

      {/* Visual preview placeholder */}
      {attachments.length > 0 && (
        <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-slate-600 bg-slate-900/60">
          <div className="text-center">
            <div className="mb-2 text-3xl">🖥️</div>
            <p className="text-sm font-medium text-slate-300">PCB layer rendering</p>
            <p className="mt-1 text-xs text-slate-500">
              Visual rendering requires{' '}
              <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-[10px] text-slate-400">
                @tracespace/pcb-stackup
              </code>{' '}
              — download files to view in KiCad or Gerber viewers
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {attachments
                .filter((a) => visibleLayers.has(a.id))
                .map((a) => (
                  <span
                    key={a.id}
                    className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium ${
                      a.layerType ? (LAYER_TYPE_COLORS[a.layerType] ?? 'bg-slate-600 text-white') : 'bg-slate-600 text-white'
                    }`}
                  >
                    {a.layerName ?? a.filename}
                  </span>
                ))}
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: Layer list */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Layers / Files
          </h4>

          {isLoading && (
            <p className="text-sm text-slate-500">Loading attachments…</p>
          )}

          {!isLoading && attachments.length === 0 && (
            <p className="text-sm text-slate-500 italic">No PCB files uploaded yet.</p>
          )}

          <div className="space-y-2">
            {attachments.map((attachment) => (
              <button
                key={attachment.id}
                type="button"
                className="block w-full text-left"
                onClick={() => setSelectedAttachment(attachment)}
              >
                <AttachmentRow
                  attachment={attachment}
                  visible={visibleLayers.has(attachment.id)}
                  onToggle={() => toggleLayer(attachment.id)}
                  onDelete={() => deleteMutation.mutate(attachment.id)}
                />
              </button>
            ))}
          </div>

          {/* Upload */}
          {!readOnly && (
            <div className="pt-2">
              <DropZone onFiles={(files) => uploadMutation.mutate(files)} />
              {uploadMutation.isPending && (
                <p className="mt-2 text-xs text-slate-400">Uploading…</p>
              )}
              {uploadErrors.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {uploadErrors.map((e, i) => (
                    <li key={i} className="text-xs text-red-400">{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Right: BOM table */}
        {hasBom && (
          <div className="space-y-3">
            <BomTable bom={bom} />
          </div>
        )}
      </div>
    </div>
  );
}
