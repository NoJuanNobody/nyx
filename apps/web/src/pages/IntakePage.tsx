import { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  uploadAudioForIntake,
  processTranscriptForIntake,
  createDocument,
  fetchTeams,
} from '../lib/api';
import type { IntakeResult } from '../lib/api';

type TabMode = 'upload' | 'paste';

const ACCEPTED_EXTENSIONS = '.mp3,.wav,.m4a,.webm';
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

export function IntakePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<TabMode>('upload');
  const [pasteText, setPasteText] = useState('');
  const [result, setResult] = useState<IntakeResult | null>(null);
  const [editedTranscript, setEditedTranscript] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const { data: teams } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
  });
  const teamId = teams?.[0]?.id;

  // Upload mutation
  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadAudioForIntake(file),
    onSuccess: (data) => {
      setResult(data);
      setEditedTranscript(data.transcript);
    },
  });

  // Paste transcript mutation
  const pasteMutation = useMutation({
    mutationFn: (transcript: string) => processTranscriptForIntake(transcript),
    onSuccess: (data) => {
      setResult(data);
      setEditedTranscript(data.transcript);
    },
  });

  // Re-process edited transcript
  const reprocessMutation = useMutation({
    mutationFn: (transcript: string) => processTranscriptForIntake(transcript),
    onSuccess: (data) => {
      setResult(data);
    },
  });

  // Create document from structured spec
  const createMutation = useMutation({
    mutationFn: () => {
      if (!result || !teamId) throw new Error('Missing result or team');
      return createDocument({
        title: result.structured.title,
        content: result.structured.content,
        teamId,
      });
    },
    onSuccess: (doc) => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      navigate(`/documents/${doc.id}`);
    },
  });

  const handleFileSelect = useCallback(
    (file: File) => {
      if (file.size > MAX_FILE_SIZE) {
        alert('File is too large. Maximum size is 25MB.');
        return;
      }
      setSelectedFile(file);
      setResult(null);
      uploadMutation.mutate(file);
    },
    [uploadMutation],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const isProcessing =
    uploadMutation.isPending || pasteMutation.isPending || reprocessMutation.isPending;

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Audio Intake</h1>
        <p className="mt-1 text-sm text-slate-500">
          Upload a voice memo or meeting recording, or paste a transcript. We will structure it
          into a spec document.
        </p>
      </div>

      {/* Tab selector */}
      <div className="mb-6 flex gap-1 rounded-lg bg-slate-100 p-1" data-testid="intake-tabs">
        <button
          type="button"
          onClick={() => setTab('upload')}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === 'upload'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
          data-testid="intake-tab-upload"
        >
          Upload Audio
        </button>
        <button
          type="button"
          onClick={() => setTab('paste')}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === 'paste'
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
          data-testid="intake-tab-paste"
        >
          Paste Transcript
        </button>
      </div>

      {/* Upload tab */}
      {tab === 'upload' && (
        <div className="space-y-4">
          <div
            data-testid="intake-dropzone"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 transition-colors ${
              dragOver
                ? 'border-blue-400 bg-blue-50'
                : 'border-slate-300 bg-slate-50 hover:border-slate-400'
            }`}
          >
            <svg
              className="mb-3 h-10 w-10 text-slate-400"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z"
              />
            </svg>
            <p className="text-sm font-medium text-slate-700">
              {selectedFile ? selectedFile.name : 'Drop audio file here or click to browse'}
            </p>
            <p className="mt-1 text-xs text-slate-500">MP3, WAV, M4A, or WebM (max 25MB)</p>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              className="hidden"
              data-testid="intake-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileSelect(file);
              }}
            />
          </div>

          {uploadMutation.isPending && (
            <div className="flex items-center gap-3 rounded-lg bg-blue-50 p-4" data-testid="intake-progress">
              <svg
                className="h-5 w-5 animate-spin text-blue-600"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              <span className="text-sm font-medium text-blue-700">
                Uploading and transcribing...
              </span>
            </div>
          )}

          {uploadMutation.isError && (
            <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700" data-testid="intake-error">
              {uploadMutation.error instanceof Error
                ? uploadMutation.error.message
                : 'Upload failed'}
            </div>
          )}
        </div>
      )}

      {/* Paste tab */}
      {tab === 'paste' && (
        <div className="space-y-4">
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste your transcript here..."
            rows={10}
            className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            data-testid="intake-paste-input"
          />
          <button
            type="button"
            onClick={() => pasteMutation.mutate(pasteText)}
            disabled={!pasteText.trim() || pasteMutation.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
            data-testid="intake-process-btn"
          >
            {pasteMutation.isPending ? 'Processing...' : 'Process Transcript'}
          </button>

          {pasteMutation.isError && (
            <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700" data-testid="intake-error">
              {pasteMutation.error instanceof Error
                ? pasteMutation.error.message
                : 'Processing failed'}
            </div>
          )}
        </div>
      )}

      {/* Results section */}
      {result && (
        <div className="mt-8 space-y-6" data-testid="intake-results">
          {/* Editable transcript */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">Transcript</h2>
              <button
                type="button"
                onClick={() => reprocessMutation.mutate(editedTranscript)}
                disabled={reprocessMutation.isPending || editedTranscript === result.transcript}
                className="text-sm font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
                data-testid="intake-reprocess-btn"
              >
                {reprocessMutation.isPending ? 'Reprocessing...' : 'Re-process'}
              </button>
            </div>
            <textarea
              value={editedTranscript}
              onChange={(e) => setEditedTranscript(e.target.value)}
              rows={8}
              className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              data-testid="intake-transcript-editor"
            />
          </div>

          {/* Structured spec preview */}
          <div>
            <h2 className="mb-2 text-lg font-semibold text-slate-900">Structured Spec</h2>
            <div className="rounded-lg border border-slate-200 bg-white p-6">
              <h3
                className="mb-4 text-xl font-bold text-slate-900"
                data-testid="intake-structured-title"
              >
                {result.structured.title}
              </h3>
              <div
                className="prose prose-slate max-w-none text-sm"
                data-testid="intake-structured-content"
              >
                <pre className="whitespace-pre-wrap font-sans">{result.structured.content}</pre>
              </div>
            </div>
          </div>

          {/* Create document button */}
          {teamId && (
            <button
              type="button"
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-6 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-green-700 disabled:opacity-50"
              data-testid="intake-create-doc-btn"
            >
              {createMutation.isPending ? 'Creating...' : 'Create Document from Spec'}
            </button>
          )}

          {createMutation.isError && (
            <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : 'Failed to create document'}
            </div>
          )}
        </div>
      )}
    </>
  );
}
