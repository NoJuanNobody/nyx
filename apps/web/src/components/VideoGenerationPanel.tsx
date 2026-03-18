import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { generateVideo, listVideos, downloadVideosBatch, type GeneratedVideo } from '../lib/api';

interface VideoGenerationPanelProps {
  documentId: string;
}

export function VideoGenerationPanel({ documentId }: VideoGenerationPanelProps) {
  const queryClient = useQueryClient();

  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data: videos = [], isLoading } = useQuery<GeneratedVideo[]>({
    queryKey: ['videos', documentId],
    queryFn: () => listVideos(documentId),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.some((v) => v.status === 'generating') ? 5000 : false;
    },
  });

  const generateMutation = useMutation({
    mutationFn: () =>
      generateVideo({ prompt: prompt || 'Generate a video based on this document', documentId, aspectRatio }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['videos', documentId] });
      setPrompt('');
    },
    onError: (err: Error) => {
      console.error('Video generation failed:', err.message);
    },
  });

  const downloadMutation = useMutation({
    mutationFn: () => downloadVideosBatch(Array.from(selectedIds)),
    onSuccess: () => setSelectedIds(new Set()),
  });

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === videos.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(videos.map((v) => v.id)));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Generate form */}
      <div className="flex-shrink-0 space-y-3 border-b border-slate-200/80 p-4">
        <label className="block text-[11px] font-semibold uppercase tracking-widest text-slate-400">
          Generate Video
        </label>
        <p className="text-[10px] text-slate-400">
          Videos are generated using the current document as context. Add an optional prompt to guide the style.
        </p>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Optional: describe style, tone, or specific scenes (document content is used automatically)..."
          rows={3}
          className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        />
        <div className="flex items-center gap-2">
          <select
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value as '16:9' | '9:16' | '1:1')}
            className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          >
            <option value="16:9">16:9 Landscape</option>
            <option value="9:16">9:16 Portrait</option>
            <option value="1:1">1:1 Square</option>
          </select>
          <button
            type="button"
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            className="ml-auto rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {generateMutation.isPending ? 'Generating...' : 'Generate Video'}
          </button>
        </div>
        {generateMutation.isError && (
          <p className="text-xs text-red-500">
            {(generateMutation.error as Error).message || 'Generation failed'}
          </p>
        )}
      </div>

      {/* Video list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-xs text-slate-400">
            Loading videos...
          </div>
        ) : videos.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-xs text-slate-400">
            No videos generated yet.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {/* Select all header */}
            <div className="flex items-center gap-2 px-4 py-2 bg-slate-50/50">
              <input
                type="checkbox"
                checked={selectedIds.size === videos.length && videos.length > 0}
                onChange={toggleAll}
                className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all'}
              </span>
            </div>

            {videos.map((video) => (
              <div
                key={video.id}
                className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50/50 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(video.id)}
                  onChange={() => toggleSelected(video.id)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-700">
                    {video.prompt}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <span
                      className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                        video.status === 'completed'
                          ? 'bg-green-50 text-green-700'
                          : video.status === 'failed'
                            ? 'bg-red-50 text-red-700'
                            : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {video.status}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {new Date(video.createdAt).toLocaleDateString()}
                    </span>
                    {video.duration > 0 && (
                      <span className="text-[10px] text-slate-400">
                        {video.duration}s
                      </span>
                    )}
                  </div>
                  {video.videoUrl && video.status === 'completed' && (
                    <div className="mt-2">
                      <video
                        controls
                        className="w-full rounded-lg border border-slate-200"
                        src={video.videoUrl.startsWith('/') ? `http://localhost:3001${video.videoUrl}` : video.videoUrl}
                      >
                        Your browser does not support the video tag.
                      </video>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Batch download footer */}
      {selectedIds.size > 0 && (
        <div className="flex-shrink-0 border-t border-slate-200/80 bg-slate-50 px-4 py-3">
          <button
            type="button"
            onClick={() => downloadMutation.mutate()}
            disabled={downloadMutation.isPending}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {downloadMutation.isPending
              ? 'Downloading...'
              : `Download ${selectedIds.size} Video${selectedIds.size > 1 ? 's' : ''} as ZIP`}
          </button>
          {downloadMutation.isError && (
            <p className="mt-1 text-xs text-red-500">Download failed. Please try again.</p>
          )}
        </div>
      )}
    </div>
  );
}
