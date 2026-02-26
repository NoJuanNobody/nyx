import type { Document, DocumentVersion } from '@syncdocs/shared';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }

  return res.json() as Promise<T>;
}

// ── Documents ───────────────────────────────────────────────────────

export function fetchDocuments(teamId: string): Promise<Document[]> {
  return request<Document[]>(`/documents?teamId=${encodeURIComponent(teamId)}`);
}

export function fetchDocument(id: string): Promise<Document> {
  return request<Document>(`/documents/${id}`);
}

export function createDocument(
  data: Pick<Document, 'title' | 'content' | 'teamId'>,
): Promise<Document> {
  return request<Document>('/documents', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateDocument(
  id: string,
  data: Partial<Pick<Document, 'title' | 'content' | 'status'>>,
): Promise<Document> {
  return request<Document>(`/documents/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteDocument(id: string): Promise<void> {
  return request<void>(`/documents/${id}`, { method: 'DELETE' });
}

// ── Teams ───────────────────────────────────────────────────────────

export function fetchTeams(): Promise<{ id: string; name: string; slug: string }[]> {
  return request<{ id: string; name: string; slug: string }[]>('/teams');
}

// ── Versions ────────────────────────────────────────────────────────

export function fetchVersions(documentId: string): Promise<DocumentVersion[]> {
  return request<DocumentVersion[]>(`/documents/${documentId}/versions`);
}

export function createVersion(
  documentId: string,
  data: { message?: string | null },
): Promise<DocumentVersion> {
  return request<DocumentVersion>(`/documents/${documentId}/versions`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── Diff ───────────────────────────────────────────────────────────

export function fetchDiff(
  versionIdA: string,
  versionIdB: string,
): Promise<{ a: DocumentVersion; b: DocumentVersion }> {
  return request<{ a: DocumentVersion; b: DocumentVersion }>(
    `/versions/${versionIdA}/diff/${versionIdB}`,
  );
}

// ── Timeline ───────────────────────────────────────────────────────

export interface TimelineEvent {
  id: string;
  documentId: string;
  type: string;
  payload: Record<string, unknown>;
  actorId: string | null;
  createdAt: string;
}

export function fetchTimeline(documentId: string): Promise<{ documentId: string; events: TimelineEvent[] }> {
  return request<{ documentId: string; events: TimelineEvent[] }>(
    `/documents/${documentId}/timeline`,
  );
}

// ── AI ─────────────────────────────────────────────────────────────

export function analyzeSpecQuality(
  content: string,
): Promise<{ score: number; suggestions: string[] }> {
  return request<{ score: number; suggestions: string[] }>('/ai/analyze-quality', {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}
