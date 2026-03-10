import type { Document, DocumentVersion, DocumentTemplate } from '@syncdocs/shared';
import type { DocumentStage } from './stages';

const BASE = '/api';

// ── Auth Token ──────────────────────────────────────────────────────
// Store either a static token or a getter function (for Clerk's getToken())
let authToken: string | null = null;
let authTokenGetter: (() => Promise<string | null>) | null = null;

export function setAuthToken(token: string | null) { authToken = token; authTokenGetter = null; }
export function setAuthTokenGetter(getter: () => Promise<string | null>) { authTokenGetter = getter; }
export function getAuthToken() { return authToken; }

export async function resolveToken(): Promise<string | null> {
  if (authTokenGetter) {
    const token = await authTokenGetter();
    authToken = token; // cache latest for getAuthToken() callers
    return token;
  }
  return authToken;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  const token = await resolveToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
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
  data: Pick<Document, 'title' | 'content' | 'teamId'> & {
    path?: string;
    stage?: DocumentStage | null;
    templateId?: string;
  },
): Promise<Document> {
  return request<Document>('/documents', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateDocument(
  id: string,
  data: Partial<Pick<Document, 'title' | 'content' | 'status' | 'path'>> & {
    stage?: DocumentStage | null;
  },
): Promise<Document> {
  return request<Document>(`/documents/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteDocument(id: string): Promise<void> {
  await request<void>(`/documents/${id}`, { method: 'DELETE' });
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

// ── Templates ──────────────────────────────────────────────────────

export function fetchTemplates(stage?: DocumentStage): Promise<DocumentTemplate[]> {
  const params = stage ? `?stage=${encodeURIComponent(stage)}` : '';
  return request<DocumentTemplate[]>(`/templates${params}`);
}

export function fetchTemplate(id: string): Promise<DocumentTemplate> {
  return request<DocumentTemplate>(`/templates/${id}`);
}

// ── AI ─────────────────────────────────────────────────────────────

export function analyzeSpecQuality(
  content: string,
  stage?: string | null,
): Promise<{ score: number; suggestions: string[] }> {
  return request<{ score: number; suggestions: string[] }>('/ai/analyze', {
    method: 'POST',
    body: JSON.stringify({ content, stage }),
  });
}

export function seedNextStage(
  content: string,
  fromStage: string,
  toStage: string,
): Promise<{ title: string; content: string }> {
  return request<{ title: string; content: string }>('/ai/seed-next-stage', {
    method: 'POST',
    body: JSON.stringify({ content, fromStage, toStage }),
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

export function generateJSXPreview(
  prompt: string,
  context?: string,
): Promise<{ jsx: string }> {
  return request<{ jsx: string }>('/ai/jsx-preview', {
    method: 'POST',
    body: JSON.stringify({ prompt, context }),
  });
}

export function refineJSXPreview(
  currentJSX: string,
  prompt: string,
): Promise<{ jsx: string }> {
  return request<{ jsx: string }>('/ai/jsx-preview/refine', {
    method: 'POST',
    body: JSON.stringify({ currentJSX, prompt }),
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

// ── Team Members ────────────────────────────────────────────────────

export function fetchTeamMembers(teamId: string): Promise<{ teamId: string; members: Array<{ id: string; userId: string; role: string; joinedAt: string; userName: string; userEmail: string }> }> {
  return request<{ teamId: string; members: Array<{ id: string; userId: string; role: string; joinedAt: string; userName: string; userEmail: string }> }>(
    `/teams/${teamId}/members`,
  );
}

export function updateTeamMemberRole(teamId: string, userId: string, role: string): Promise<{ id: string; role: string }> {
  return request<{ id: string; role: string }>(`/teams/${teamId}/members/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

export function removeTeamMember(teamId: string, userId: string): Promise<void> {
  return request<void>(`/teams/${teamId}/members/${userId}`, {
    method: 'DELETE',
  });
}

export function inviteTeamMember(teamId: string, email: string, role: string): Promise<{ id: string }> {
  return request<{ id: string }>(`/teams/${teamId}/members`, {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  });
}

// ── Team Invitations ────────────────────────────────────────────────

export interface TeamInvitation {
  id: string;
  teamId: string;
  email: string;
  role: string;
  invitedById: string;
  status: 'pending' | 'accepted' | 'expired';
  createdAt: string;
  expiresAt: string;
}

export function fetchTeamInvitations(teamId: string): Promise<{ teamId: string; invitations: TeamInvitation[] }> {
  return request<{ teamId: string; invitations: TeamInvitation[] }>(
    `/teams/${teamId}/invitations`,
  );
}

export function cancelInvitation(teamId: string, invitationId: string): Promise<void> {
  return request<void>(`/teams/${teamId}/invitations/${invitationId}`, {
    method: 'DELETE',
  });
}

// ── Tickets (Board) ─────────────────────────────────────────────────

export interface Ticket {
  id: string;
  documentId: string;
  provider: 'github' | 'jira';
  externalId: string;
  externalUrl: string;
  title: string;
  status: 'open' | 'in_progress' | 'closed';
  createdById: string;
  createdAt: string;
  updatedAt: string;
  documentTitle?: string;
}

export function fetchTickets(teamId: string, filters?: { status?: string; provider?: string }): Promise<Ticket[]> {
  const params = new URLSearchParams({ teamId });
  if (filters?.status) params.set('status', filters.status);
  if (filters?.provider) params.set('provider', filters.provider);
  return request<Ticket[]>(`/tickets?${params.toString()}`);
}

export function syncAllTickets(teamId: string): Promise<{ synced: number }> {
  return request<{ synced: number }>(`/tickets/sync-all?teamId=${encodeURIComponent(teamId)}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// ── Integrations (Settings) ─────────────────────────────────────────

export function fetchIntegrations(teamId: string): Promise<Array<{ id: string; teamId: string; type: string; config: Record<string, unknown>; createdAt: string }>> {
  return request<Array<{ id: string; teamId: string; type: string; config: Record<string, unknown>; createdAt: string }>>(
    `/integrations?teamId=${encodeURIComponent(teamId)}`,
  );
}

export function deleteIntegration(id: string): Promise<{ id: string }> {
  return request<{ id: string }>(`/integrations/${id}`, {
    method: 'DELETE',
  });
}

export function testIntegration(id: string): Promise<{ ok: boolean; message: string }> {
  return request<{ ok: boolean; message: string }>(`/integrations/${id}/test`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface GitHubRepoItem {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
}

export function fetchGitHubRepos(integrationId: string): Promise<{ repos: GitHubRepoItem[] }> {
  return request<{ repos: GitHubRepoItem[] }>(`/integrations/${integrationId}/github/repos`);
}

export function saveSelectedRepos(integrationId: string, repos: Array<{ owner: string; name: string; fullName: string }>): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/integrations/${integrationId}/github/repos`, {
    method: 'PUT',
    body: JSON.stringify({ repos }),
  });
}

// ── User Profile ────────────────────────────────────────────────────

export function updateProfile(data: { name?: string; email?: string }): Promise<{ id: string; name: string; email: string }> {
  return request<{ id: string; name: string; email: string }>('/users/me', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function deleteAccount(): Promise<void> {
  return request<void>('/users/me', {
    method: 'DELETE',
  });
}
