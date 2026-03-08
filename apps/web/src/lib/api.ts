import type { Document, DocumentVersion } from '@syncdocs/shared';

const BASE = '/api';

// ── Auth Token ──────────────────────────────────────────────────────
let authToken: string | null = null;
export function setAuthToken(token: string | null) { authToken = token; }
export function getAuthToken() { return authToken; }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    headers,
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

export function fetchArchivedDocuments(teamId: string): Promise<Document[]> {
  return request<Document[]>(
    `/documents?teamId=${encodeURIComponent(teamId)}&includeArchived=true`,
  ).then((docs) => docs.filter((d) => d.status === 'archived'));
}

export function restoreDocument(id: string): Promise<Document> {
  return updateDocument(id, { status: 'draft' });
}

export function fetchDocument(id: string): Promise<Document> {
  return request<Document>(`/documents/${id}`);
}

export function createDocument(
  data: Pick<Document, 'title' | 'content' | 'teamId'> & { path?: string },
): Promise<Document> {
  return request<Document>('/documents', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateDocument(
  id: string,
  data: Partial<Pick<Document, 'title' | 'content' | 'status' | 'path'>>,
): Promise<Document> {
  return request<Document>(`/documents/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteDocument(id: string): Promise<void> {
  const res = await fetch(`${BASE}/documents/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }
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

// ── Branches ─────────────────────────────────────────────────────────

export interface DocumentBranch {
  id: string;
  documentId: string;
  name: string;
  baseVersionId: string;
  content: string;
  createdById: string;
  status: string;
  reviewedById: string | null;
  createdAt: string;
  mergedAt: string | null;
}

export function fetchBranches(documentId: string): Promise<DocumentBranch[]> {
  return request<DocumentBranch[]>(`/documents/${documentId}/branches`);
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
  return request<{ score: number; suggestions: string[] }>('/ai/analyze', {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export function generateDocument(
  prompt: string,
): Promise<{ title: string; content: string }> {
  return request<{ title: string; content: string }>('/ai/generate-document', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
}

export function editDocumentAI(
  content: string,
  instruction: string,
  history?: Array<{ role: string; content: string }>,
): Promise<{ content: string }> {
  return request<{ content: string }>('/ai/edit-document', {
    method: 'POST',
    body: JSON.stringify({ content, instruction, history }),
  });
}

// ── Agent ──────────────────────────────────────────────────────────

export interface AgentWorkflow {
  id: string;
  name: string;
  description: string;
  defaultPrompt?: string;
}

export function fetchWorkflows(): Promise<AgentWorkflow[]> {
  return request<AgentWorkflow[]>('/agent/workflows');
}

export interface AgentSession {
  id: string;
  teamId: string;
  userId: string;
  documentId: string | null;
  status: string;
  prompt: string;
  result: string | null;
  toolCallCount: number;
  tokenUsage: Record<string, number>;
  createdAt: string;
}

export function getAgentSession(sessionId: string): Promise<{ session: AgentSession; toolCalls: unknown[] }> {
  return request<{ session: AgentSession; toolCalls: unknown[] }>(`/agent/${sessionId}`);
}

export function cancelAgentSession(sessionId: string): Promise<{ cancelled: boolean }> {
  return request<{ cancelled: boolean }>(`/agent/${sessionId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// ── API Keys ─────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
}

export function fetchApiKeys(teamId: string): Promise<ApiKey[]> {
  return request<ApiKey[]>(`/api-keys?teamId=${encodeURIComponent(teamId)}`);
}

export function createApiKey(data: {
  teamId: string;
  name: string;
  scopes?: string[];
  expiresInDays?: number;
}): Promise<ApiKey & { key: string }> {
  return request<ApiKey & { key: string }>('/api-keys', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function revokeApiKey(keyId: string): Promise<{ revoked: boolean }> {
  return request<{ revoked: boolean }>(`/api-keys/${keyId}`, {
    method: 'DELETE',
  });
}

// ── Change Proposals ─────────────────────────────────────────────────

export interface ChangeProposal {
  id: string;
  documentId: string;
  teamId: string;
  createdById: string;
  title: string;
  description: string;
  status: 'pending' | 'approved' | 'rejected' | 'pushed';
  suggestedTickets: Array<{ title: string; description: string; priority: string; labels: string[] }>;
  sourceVersions: string[];
  createdAt: string;
  updatedAt: string;
}

export function generateChangeProposal(documentId: string): Promise<ChangeProposal> {
  return request<ChangeProposal>(`/documents/${documentId}/change-proposals/generate`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function fetchChangeProposals(documentId: string): Promise<ChangeProposal[]> {
  return request<ChangeProposal[]>(`/documents/${documentId}/change-proposals`);
}

export function approveChangeProposal(
  proposalId: string,
  suggestedTickets?: ChangeProposal['suggestedTickets'],
): Promise<ChangeProposal> {
  return request<ChangeProposal>(`/change-proposals/${proposalId}/approve`, {
    method: 'PATCH',
    body: JSON.stringify(suggestedTickets ? { suggestedTickets } : {}),
  });
}

export function rejectChangeProposal(proposalId: string): Promise<ChangeProposal> {
  return request<ChangeProposal>(`/change-proposals/${proposalId}/reject`, {
    method: 'PATCH',
  });
}

export function pushChangeProposal(proposalId: string): Promise<{ proposal: ChangeProposal; createdTickets: unknown[] }> {
  return request<{ proposal: ChangeProposal; createdTickets: unknown[] }>(`/change-proposals/${proposalId}/push`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// ── Audit Trail ──────────────────────────────────────────────────────

export interface AuditEvent {
  id: string;
  teamId: string;
  eventType: string;
  actorId: string | null;
  actorName: string | null;
  documentId: string | null;
  snapshotId: string | null;
  ticketId: string | null;
  commitSha: string | null;
  parentEventId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export function fetchAuditTrail(documentId: string): Promise<{ documentId: string; events: AuditEvent[] }> {
  return request<{ documentId: string; events: AuditEvent[] }>(
    `/documents/${documentId}/audit-trail`,
  );
}

export function fetchAuditTrace(eventId: string): Promise<{ eventId: string; chain: AuditEvent[] }> {
  return request<{ eventId: string; chain: AuditEvent[] }>(
    `/audit-trail/${eventId}/trace`,
  );
}
