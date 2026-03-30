import type { Document, DocumentVersion, DocumentTemplate, AdminDocumentsResponse } from '@nyx/shared';
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

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
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
    // Detect GitHub token expiration
    if (res.status === 401 && body.includes('github_token_expired')) {
      throw new GitHubTokenExpiredError('Your GitHub connection has expired. Please reconnect.');
    }
    // Detect expired/invalid auth session — redirect to sign-in instead of looping
    if (res.status === 401 || res.status === 403) {
      const isAuthError = body.includes('Unauthorized') || body.includes('session') || body.includes('token');
      if (isAuthError && typeof window !== 'undefined') {
        console.error('Auth session expired, redirecting to sign-in');
        window.location.href = '/sign-in';
        throw new Error('Session expired. Redirecting to sign-in...');
      }
    }
    let userMessage = `Request failed (${res.status})`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.error && typeof parsed.error === 'string') {
        userMessage = parsed.error;
      }
    } catch {}
    console.error(`API ${res.status}:`, body);
    throw new Error(userMessage);
  }

  return res.json() as Promise<T>;
}

export class GitHubTokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubTokenExpiredError';
  }
}

// ── Documents ───────────────────────────────────────────────────────

export function fetchDocuments(teamId: string): Promise<Document[]> {
  return request<Document[]>(`/documents?teamId=${encodeURIComponent(teamId)}`);
}

export function fetchAdminDocuments(): Promise<AdminDocumentsResponse> {
  return request<AdminDocumentsResponse>('/admin/documents');
}

export function fetchRecentDocuments(teamId: string, limit = 5): Promise<Document[]> {
  return request<Document[]>(
    `/documents?teamId=${encodeURIComponent(teamId)}&sort=recent&limit=${limit}`,
  );
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
  if (!data.teamId) {
    console.error(
      '[Nyx] createDocument called without teamId. The user may not belong to a team yet. ' +
      'Ensure GET /api/teams returns at least one team before attempting document creation.',
    );
    return Promise.reject(new Error('Cannot create document: no team selected. Please refresh or check your team membership.'));
  }
  return request<Document>('/documents', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function createDocumentFromTemplate(
  data: {
    listingId: string;
    teamId: string;
    path?: string;
  },
): Promise<Document> {
  if (!data.teamId) {
    return Promise.reject(
      new Error(
        'Cannot create document: no team selected. Please refresh or check your team membership.',
      ),
    );
  }
  return request<Document>('/documents/from-template', {
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

// ── Lifecycles ─────────────────────────────────────────────────────

export interface LifecycleResponse {
  id: string;
  slug: string;
  label: string;
  description: string;
  icon: string;
  isDefault: boolean;
  sortOrder: number;
  stages: {
    id: string;
    lifecycleId: string;
    slug: string;
    sortOrder: number;
    label: string;
    abbreviation: string;
    subtitle: string;
    color: string;
    textColor: string;
    dotColor: string;
    borderColor: string;
    hex: string;
    who: string;
    description: string;
    icon: string;
    ai: string;
    output: string;
    docs: string[];
  }[];
}

export function fetchLifecycles(): Promise<LifecycleResponse[]> {
  return request<LifecycleResponse[]>('/lifecycles');
}

export function fetchLifecycle(slug: string): Promise<LifecycleResponse> {
  return request<LifecycleResponse>(`/lifecycles/${slug}`);
}

// ── Templates ──────────────────────────────────────────────────────

export function fetchTemplates(stage?: DocumentStage, teamId?: string): Promise<DocumentTemplate[]> {
  const params = new URLSearchParams();
  if (stage) params.set('stage', stage);
  if (teamId) params.set('teamId', teamId);
  const qs = params.toString();
  return request<DocumentTemplate[]>(`/templates${qs ? `?${qs}` : ''}`);
}

export function fetchTemplate(id: string): Promise<DocumentTemplate> {
  return request<DocumentTemplate>(`/templates/${id}`);
}

export function createTemplate(data: {
  name: string;
  description: string;
  content: string;
  stage: DocumentStage;
  teamId: string;
}): Promise<DocumentTemplate> {
  return request<DocumentTemplate>('/templates', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateTemplate(
  id: string,
  data: { name?: string; description?: string; content?: string; stage?: DocumentStage },
): Promise<DocumentTemplate> {
  return request<DocumentTemplate>(`/templates/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteTemplate(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/templates/${id}`, {
    method: 'DELETE',
  });
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

export function seedFromStage(data: {
  documentId: string;
  fromStage: string;
  toStage: string;
  content: string;
}): Promise<{ title: string; content: string }> {
  return request<{ title: string; content: string }>('/ai/seed-from-stage', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function analyzeMissingSections(data: {
  content: string;
  stage?: string;
}): Promise<{
  missingSections: Array<{ name: string; description: string; priority: 'high' | 'medium' | 'low' }>;
}> {
  return request<{
    missingSections: Array<{ name: string; description: string; priority: 'high' | 'medium' | 'low' }>;
  }>('/ai/missing-sections', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── Decision Weight (capacity metric) ────────────────────────────────

export interface DecisionWeightBreakdown {
  ambiguity: number;
  integrationSurface: number;
  validationDifficulty: number;
  scopeSpread: number;
  novelty: number;
}

export interface DecisionWeightResult {
  weight: number;
  breakdown: DecisionWeightBreakdown;
  bottlenecks: string[];
  reviewCycles: number;
}

export function estimateDecisionWeight(data: {
  content: string;
  stage?: string;
}): Promise<DecisionWeightResult> {
  return request<DecisionWeightResult>('/ai/decision-weight', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function replyToNotification(data: {
  notificationId: string;
  message: string;
  documentId: string;
  content?: string;
}): Promise<{ reply: string; suggestedActions: string[] }> {
  return request<{ reply: string; suggestedActions: string[] }>('/ai/notification-reply', {
    method: 'POST',
    body: JSON.stringify(data),
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

export interface GenerateAllResult {
  documentId: string;
  title: string;
  status: 'success' | 'error';
  error?: string;
}

export interface GenerateAllResponse {
  results: GenerateAllResult[];
  total: number;
  succeeded: number;
  failed: number;
}

export function generateAllDocuments(
  teamId: string,
): Promise<GenerateAllResponse> {
  return request<GenerateAllResponse>('/ai/generate-all', {
    method: 'POST',
    body: JSON.stringify({ teamId }),
  });
}

export function editDocumentAI(
  content: string,
  instruction: string,
  history?: Array<{ role: string; content: string }>,
  signal?: AbortSignal,
): Promise<{ content: string }> {
  return request<{ content: string }>('/ai/edit-document', {
    method: 'POST',
    body: JSON.stringify({ content, instruction, history }),
    signal,
  });
}

export function generateJSXPreview(
  prompt: string,
  context?: string,
  allStates?: boolean,
): Promise<{ jsx: string }> {
  return request<{ jsx: string }>('/ai/jsx-preview', {
    method: 'POST',
    body: JSON.stringify({ prompt, context, allStates }),
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
  postSessionSuggestions?: string[];
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

// ── Impact Graph ─────────────────────────────────────────────────────

export interface ImpactNode {
  id: string;
  eventType: string;
  actorName: string | null;
  intent: string;
  driftFlag: boolean;
  commitSha: string | null;
  ticketId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ImpactEdge {
  source: string;
  target: string;
}

export interface ImpactGraphResult {
  documentId: string;
  nodes: ImpactNode[];
  edges: ImpactEdge[];
}

export function fetchImpactGraph(documentId: string): Promise<ImpactGraphResult> {
  return request<ImpactGraphResult>(`/documents/${documentId}/impact-graph`);
}

// ── Trace ───────────────────────────────────────────────────────────

export interface TraceNode {
  id: string;
  type: string;
  label: string;
  actorName: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface TraceEdge {
  from: string;
  to: string;
}

export interface TraceResult {
  documentId: string;
  nodes: TraceNode[];
  edges: TraceEdge[];
  summary: string;
}

export function fetchDocumentTrace(documentId: string): Promise<TraceResult> {
  return request<TraceResult>(`/documents/${documentId}/trace`);
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

export function inviteTeamMember(teamId: string, email: string, role: string): Promise<{ id: string; type?: string }> {
  return request<{ id: string; type?: string }>(`/teams/${teamId}/members`, {
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

export async function getInvitation(token: string): Promise<{
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  teamName: string;
  error?: string;
}> {
  const res = await fetch(`${BASE}/invitations/${token}`);
  if (!res.ok) throw new Error('Invitation not found');
  return res.json();
}

export async function acceptInvitation(token: string): Promise<{ teamId: string; role: string; alreadyMember?: boolean }> {
  return request<{ teamId: string; role: string; alreadyMember?: boolean }>(`/invitations/${token}/accept`, {
    method: 'POST',
    body: JSON.stringify({}),
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
  repoName?: string;
  repoUrl?: string;
  claudeInsights?: ClaudeInsight | null;
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

export function createTicket(
  documentId: string,
  data: { provider: 'github' | 'jira'; title: string; body: string; repo?: { owner: string; name: string } },
): Promise<Ticket> {
  return request<Ticket>(`/documents/${encodeURIComponent(documentId)}/tickets`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateTicketStatus(ticketId: string, status: 'open' | 'in_progress' | 'closed'): Promise<Ticket> {
  return request<Ticket>(`/tickets/${encodeURIComponent(ticketId)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function fetchDocumentTickets(documentId: string): Promise<Ticket[]> {
  return request<Ticket[]>(`/documents/${encodeURIComponent(documentId)}/tickets`);
}

// ── Claude Action Insights ───────────────────────────────────────────

export interface ClaudeInsight {
  title: string;
  summary: string[];
  filesChanged: string[];
  commentId: number;
  commentUrl: string;
  commentedAt: string;
  fetchedAt: string;
}

export function fetchTicketInsight(ticketId: string): Promise<ClaudeInsight> {
  return request<ClaudeInsight>(`/tickets/${encodeURIComponent(ticketId)}/insights`);
}

export function refreshTicketInsight(ticketId: string): Promise<ClaudeInsight> {
  return request<ClaudeInsight>(`/tickets/${encodeURIComponent(ticketId)}/insights/refresh`, {
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

export interface SyncedRepo {
  owner: string;
  name: string;
  fullName: string;
  syncStatus: 'active' | 'disconnected';
  webhookId: number | null;
  lastPushAt: string | null;
  linkedDocCount: number;
}

export function fetchSyncedRepos(integrationId: string): Promise<{ repos: SyncedRepo[] }> {
  return request<{ repos: SyncedRepo[] }>(`/integrations/${integrationId}/github/synced-repos`);
}

export function createGitHubRepo(
  integrationId: string,
  data: { name: string; description?: string; isPrivate?: boolean; autoInit?: boolean },
): Promise<{ repo: { id: number; name: string; full_name: string; private: boolean; html_url: string; default_branch: string } }> {
  return request(`/integrations/${integrationId}/github/repos/create`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function disconnectRepo(integrationId: string, repoFullName: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/integrations/${integrationId}/github/repos/${encodeURIComponent(repoFullName)}`, {
    method: 'DELETE',
  });
}

// ── Onboarding / Repo Scan ──────────────────────────────────────────

export interface ScanResult {
  documents: Array<{ id: string; title: string; path: string }>;
  moduleCount: number;
  fileCount: number;
}

export function scanRepository(owner: string, repo: string, teamId?: string): Promise<ScanResult> {
  return request<ScanResult>('/onboarding/scan', {
    method: 'POST',
    body: JSON.stringify({ owner, repo, teamId }),
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

// ── Feedback ────────────────────────────────────────────────────────

export interface FormattedFeedback {
  title: string;
  body: string;
  category: string;
}

export interface FeedbackSubmitResult {
  id: string;
  githubIssueUrl: string | null;
  remaining: number;
}

export function formatFeedback(message: string): Promise<FormattedFeedback> {
  return request<FormattedFeedback>('/feedback/format', {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

export function submitFeedback(data: {
  rawMessage: string;
  title: string;
  body: string;
  category: string;
}): Promise<FeedbackSubmitResult> {
  return request<FeedbackSubmitResult>('/feedback/submit', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── Intake (Chaos Ingestion) ─────────────────────────────────────────

export interface IntakeSpec {
  title: string;
  userStory: string;
  acceptanceCriteria: string[];
  edgeCases: string[];
  openQuestions: string[];
  confidence: 'high' | 'medium' | 'low';
  markdown: string;
}

export interface IntakeSession {
  id: string;
  teamId: string;
  createdById: string;
  rawInput: string;
  structuredOutput: IntakeSpec | null;
  status: string;
  documentId: string | null;
  createdAt: string;
}

export function processIntake(
  data: { rawInput: string; teamId: string },
): Promise<{ session: IntakeSession; spec: IntakeSpec }> {
  return request<{ session: IntakeSession; spec: IntakeSpec }>('/intake/process', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function clarifyIntake(
  data: { rawInput: string; questions: string[]; answers: string[]; teamId: string },
): Promise<{ session: IntakeSession; spec: IntakeSpec }> {
  return request<{ session: IntakeSession; spec: IntakeSpec }>('/intake/clarify', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function fetchIntakeHistory(
  teamId: string,
): Promise<{ sessions: IntakeSession[] }> {
  return request<{ sessions: IntakeSession[] }>(
    `/intake/history?teamId=${encodeURIComponent(teamId)}`,
  );
}

// ── Sprint Gatekeeper ────────────────────────────────────────────────

export interface SprintTicket {
  id: string;
  title: string;
  points: number;
  /** Decision weight: human judgment cost derived from the backing spec (1–100) */
  decisionWeight: number;
  /** Estimated review cycles needed before shippable */
  reviewCycles: number;
  status: string;
}

export interface SprintCapacityData {
  sprintName: string;
  /** Total decision weight the team can absorb per sprint */
  totalWeight: number;
  /** Sum of decision weight for all tickets */
  usedWeight: number;
  capacityPercent: number;
  /** Legacy story points — kept for transition */
  totalPoints: number;
  usedPoints: number;
  tickets: SprintTicket[];
  source: 'github' | 'jira' | 'none';
}

export interface SprintCheckResult {
  capacity: SprintCapacityData;
  overThreshold: boolean;
  suggestions: string[];
}

export function getSprintCapacity(teamId: string): Promise<SprintCapacityData> {
  return request<SprintCapacityData>(
    `/sprint/capacity?teamId=${encodeURIComponent(teamId)}`,
  );
}

export function checkSprintCapacity(data: {
  teamId: string;
  newTicketPoints?: number;
  newTicketWeight?: number;
}): Promise<SprintCheckResult> {
  return request<SprintCheckResult>('/sprint/check', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function deferSprintTicket(data: {
  teamId: string;
  ticketKey: string;
}): Promise<{ deferred: boolean }> {
  return request<{ deferred: boolean }>('/sprint/defer', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function scheduleNextSprint(data: {
  teamId: string;
  ticketKeys: string[];
}): Promise<{ scheduled: string[] }> {
  return request<{ scheduled: string[] }>('/sprint/schedule-next', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── Context Matching ─────────────────────────────────────

export interface ContextMatch {
  documentId: string;
  title: string;
  relevance: 'high' | 'medium' | 'low';
  relationship: 'confirms' | 'contradicts' | 'expands';
  summary: string;
}

export interface ContextSignal {
  type: 'recurring_pattern' | 'contradiction' | 'scope_creep';
  description: string;
  relatedDocIds: string[];
}

export interface ContextMatchResult {
  matches: ContextMatch[];
  signals: ContextSignal[];
}

export function findContextMatches(data: {
  rawInput: string;
  teamId: string;
}): Promise<ContextMatchResult> {
  return request<ContextMatchResult>('/intake/context', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── Slack ────────────────────────────────────────────────────────────

export interface SlackConnection {
  id: string;
  slackTeamId: string;
  triggerEmoji: string | null;
  monitoredChannels: string[];
  createdAt: string;
}

export function getSlackInstallUrl(teamId: string): Promise<{ url: string }> {
  return request<{ url: string }>(`/slack/install?teamId=${encodeURIComponent(teamId)}`);
}

export function getSlackConnection(teamId: string): Promise<{ connection: SlackConnection | null }> {
  return request<{ connection: SlackConnection | null }>(`/slack/connection?teamId=${encodeURIComponent(teamId)}`);
}

export function updateSlackConnection(
  teamId: string,
  data: { triggerEmoji?: string; monitoredChannels?: string[] },
): Promise<{ connection: SlackConnection | null }> {
  return request<{ connection: SlackConnection | null }>(
    `/slack/connection?teamId=${encodeURIComponent(teamId)}`,
    { method: 'PATCH', body: JSON.stringify(data) },
  );
}

export function disconnectSlack(teamId: string): Promise<{ disconnected: boolean }> {
  return request<{ disconnected: boolean }>(
    `/slack/connection?teamId=${encodeURIComponent(teamId)}`,
    { method: 'DELETE' },
  );
}

// ── Mockups ─────────────────────────────────────────────────────────

export function renderMockupJsx(jsx: string): Promise<{ screenshot: string }> {
  return request<{ screenshot: string }>('/mockups/render-jsx', {
    method: 'POST',
    body: JSON.stringify({ jsx }),
  });
}

// ── Intake (Audio / Transcript) ──────────────────────────────────────

export interface IntakeResult {
  transcript: string;
  structured: { title: string; content: string };
}

export async function uploadAudioForIntake(file: File): Promise<IntakeResult> {
  const formData = new FormData();
  formData.append('file', file);

  const headers: Record<string, string> = {};
  const token = await resolveToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  // Do NOT set Content-Type — browser sets multipart boundary automatically

  const res = await fetch(`${BASE}/intake/audio`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let userMessage = `Request failed (${res.status})`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.error && typeof parsed.error === 'string') {
        userMessage = parsed.error;
      }
    } catch {}
    console.error(`API ${res.status}:`, body);
    throw new Error(userMessage);
  }

  return res.json() as Promise<IntakeResult>;
}

export function processTranscriptForIntake(
  transcript: string,
): Promise<IntakeResult> {
  return request<IntakeResult>('/intake/transcript', {
    method: 'POST',
    body: JSON.stringify({ transcript }),
  });
}

// ── Subscriptions ───────────────────────────────────────────────────

export interface SubscriptionPlan {
  id: string;
  name: string;
  price: number | null;
  interval: string | null;
  features: string[];
}

export interface Subscription {
  id: string;
  teamId: string;
  plan: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export function fetchPlans(): Promise<SubscriptionPlan[]> {
  return request<SubscriptionPlan[]>('/subscriptions/plans');
}

export function fetchCurrentSubscription(teamId: string): Promise<Subscription | null> {
  return request<Subscription | null>(`/subscriptions/current?teamId=${teamId}`);
}

export function createCheckoutSession(data: { plan: string; teamId: string; successUrl: string; cancelUrl: string }): Promise<{ url: string }> {
  return request<{ url: string }>('/subscriptions/checkout', { method: 'POST', body: JSON.stringify(data) });
}

export function createPortalSession(data: { teamId: string; returnUrl: string }): Promise<{ url: string }> {
  return request<{ url: string }>('/subscriptions/portal', { method: 'POST', body: JSON.stringify(data) });
}

// ── Notifications ────────────────────────────────────────────────────

export function fetchNotifications(params?: { read?: boolean; eventType?: string; limit?: number; cursor?: string }) {
  const qs = new URLSearchParams();
  if (params?.read !== undefined) qs.set('read', String(params.read));
  if (params?.eventType) qs.set('event_type', params.eventType);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.cursor) qs.set('cursor', params.cursor);
  return request<{ items: any[]; nextCursor: string | null; unreadCount: number }>(`/notifications?${qs}`);
}

export function fetchUnreadCount() {
  return request<{ count: number }>('/notifications/unread-count');
}

export function markNotificationRead(id: string) {
  return request<void>(`/notifications/${id}/read`, { method: 'PATCH' });
}

export function markAllNotificationsRead() {
  return request<void>('/notifications/read-all', { method: 'PATCH' });
}

// ── Notification Preferences ─────────────────────────────────────────

export interface NotificationPreference {
  eventType: string;
  inApp: boolean;
  emailEnabled: boolean;
  emailMode: 'instant' | 'daily' | 'weekly' | 'off';
}

export function fetchNotificationPreferences(): Promise<NotificationPreference[]> {
  return request<NotificationPreference[]>('/notifications/preferences');
}

export function updateNotificationPreference(eventType: string, data: Partial<NotificationPreference>): Promise<void> {
  return request<void>(`/notifications/preferences/${encodeURIComponent(eventType)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ── Marketplace ─────────────────────────────────────────────────────

export interface MarketplaceListing {
  id: string;
  type: 'template' | 'workflow' | 'prompt';
  title: string;
  description: string;
  content: string;
  priceType: 'free' | 'paid';
  priceAmountCents: number | null;
  creditPrice: number | null;
  category: string | null;
  tags: string[];
  stage: string | null;
  downloadCount: number;
  authorId: string;
  published: boolean;
  createdAt: string;
  avgRating?: number | null;
  reviews?: MarketplaceReview[];
}

export interface MarketplaceReview {
  id: string;
  listingId: string;
  userId: string;
  rating: number;
  comment: string | null;
  createdAt: string;
}

export interface FeatureRequest {
  id: string;
  title: string;
  description: string;
  status: string;
  authorId: string;
  upvoteCount: number;
  createdAt: string;
  userUpvoted?: boolean;
  comments?: FeatureRequestComment[];
}

export interface FeatureRequestComment {
  id: string;
  userId: string;
  content: string;
  createdAt: string;
}

export interface ProjectShowcase {
  id: string;
  title: string;
  description: string;
  techStack: string[];
  teamSize: number | null;
  nuxFeatures: string[];
  url: string | null;
  imageUrl: string | null;
  authorId: string;
  createdAt: string;
}

export function fetchMarketplaceListings(type?: string, search?: string): Promise<MarketplaceListing[]> {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (search) params.set('search', search);
  const qs = params.toString();
  return request<MarketplaceListing[]>(`/marketplace${qs ? `?${qs}` : ''}`);
}

export function fetchMarketplaceListing(id: string): Promise<MarketplaceListing> {
  return request<MarketplaceListing>(`/marketplace/${id}`);
}

export function createMarketplaceListing(data: { type: string; title: string; description: string; content: string; priceType?: string; creditPrice?: number; priceAmountCents?: number; category?: string; tags?: string[]; stage?: string }): Promise<MarketplaceListing> {
  return request<MarketplaceListing>('/marketplace', { method: 'POST', body: JSON.stringify(data) });
}

export function downloadMarketplaceListing(id: string): Promise<{ content: string; title: string }> {
  return request<{ content: string; title: string }>(`/marketplace/${id}/download`, { method: 'POST' });
}

export function fetchCreditCosts(): Promise<{ costs: Record<string, number> }> {
  return request<{ costs: Record<string, number> }>('/credits/costs');
}

export function fetchCreditBalance(): Promise<{ balance: number }> {
  return request<{ balance: number }>('/credits/balance');
}

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  priceUsd: number;
  popular: boolean;
}

export function fetchCreditPacks(): Promise<{ packs: CreditPack[] }> {
  return request<{ packs: CreditPack[] }>('/credits/packs');
}

export function deductCredits(data: { amount: number; taskType: string; description: string }): Promise<{ balance: number }> {
  return request<{ balance: number }>('/credits/deduct', { method: 'POST', body: JSON.stringify(data) });
}

export function purchaseCreditPack(packId: string): Promise<{ balance: number; pack: CreditPack }> {
  return request<{ balance: number; pack: CreditPack }>('/credits/purchase', { method: 'POST', body: JSON.stringify({ packId }) });
}

// ── Pipeline Access ─────────────────────────────────────────────────

export interface OwnedPipeline {
  id: string;
  pipelineId: string;
  teamId: string | null;
  activatedAt: string;
  creditsPaid: number;
}

export function fetchOwnedPipelines(): Promise<{ pipelines: OwnedPipeline[] }> {
  return request<{ pipelines: OwnedPipeline[] }>('/pipelines/owned');
}

export function activatePipeline(data: {
  pipelineId: string;
  pipelineLabel: string;
  creditCost: number;
  teamId?: string;
}): Promise<{ alreadyOwned: boolean; creditsPaid: number; balance: number }> {
  return request<{ alreadyOwned: boolean; creditsPaid: number; balance: number }>('/pipelines/activate', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function checkPipelineAccess(pipelineId: string): Promise<{ owned: boolean }> {
  return request<{ owned: boolean }>(`/pipelines/check/${pipelineId}`);
}

export function reviewMarketplaceListing(id: string, data: { rating: number; comment?: string }): Promise<MarketplaceReview> {
  return request<MarketplaceReview>(`/marketplace/${id}/reviews`, { method: 'POST', body: JSON.stringify(data) });
}

export function fetchFeatureRequests(sort?: string): Promise<FeatureRequest[]> {
  const params = new URLSearchParams();
  if (sort) params.set('sort', sort);
  return request<FeatureRequest[]>(`/feature-requests?${params.toString()}`);
}

export function fetchFeatureRequest(id: string): Promise<FeatureRequest> {
  return request<FeatureRequest>(`/feature-requests/${id}`);
}

export function createFeatureRequest(data: { title: string; description: string }): Promise<FeatureRequest> {
  return request<FeatureRequest>('/feature-requests', { method: 'POST', body: JSON.stringify(data) });
}

export function toggleFeatureRequestUpvote(id: string): Promise<{ upvoted: boolean }> {
  return request<{ upvoted: boolean }>(`/feature-requests/${id}/upvote`, { method: 'POST' });
}

export function addFeatureRequestComment(id: string, content: string): Promise<FeatureRequestComment> {
  return request<FeatureRequestComment>(`/feature-requests/${id}/comments`, { method: 'POST', body: JSON.stringify({ content }) });
}

export function fetchProjectShowcases(): Promise<ProjectShowcase[]> {
  return request<ProjectShowcase[]>('/project-showcases');
}

export function createProjectShowcase(data: { title: string; description: string; techStack?: string[]; teamSize?: number; nuxFeatures?: string[]; url?: string }): Promise<ProjectShowcase> {
  return request<ProjectShowcase>('/project-showcases', { method: 'POST', body: JSON.stringify(data) });
}

// ── Observability ────────────────────────────────────────────────────

export function fetchObservabilityDashboard(): Promise<{
  metrics: Record<string, unknown[]>;
  alerts: Array<{ ruleId: string; metric: string; value: number; threshold: number; triggeredAt: number; severity: 'warning' | 'critical' }>;
  pipelineHealth: Array<{ stage: string; avgLatencyMs: number; errorRate: number; throughput: number; lastUpdated: number }>;
}> {
  return request('/observability/dashboard');
}

export function fetchObservabilityMetrics(): Promise<Record<string, unknown[]>> {
  return request('/observability/metrics');
}

export function fetchObservabilityAlerts(): Promise<Array<{ ruleId: string; metric: string; value: number; threshold: number; triggeredAt: number; severity: 'warning' | 'critical' }>> {
  return request('/observability/alerts');
}

export function fetchPipelineHealth(): Promise<Array<{ stage: string; avgLatencyMs: number; errorRate: number; throughput: number; lastUpdated: number }>> {
  return request('/observability/pipeline-health');
}

// ── Background Jobs ─────────────────────────────────────────────────

export interface JobStatus<T = unknown> {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  progressMessage: string | null;
  result: T | null;
  error: string | null;
  createdAt: string;
}

export function fetchJobStatus<T = unknown>(jobId: string): Promise<JobStatus<T>> {
  return request<JobStatus<T>>(`/jobs/${jobId}`);
}

// ── Ticket Suggestions (Bulk) ───────────────────────────────────────

export interface TicketSuggestion {
  id: string;
  documentId: string;
  title: string;
  description: string;
  labels: string[];
  status: string;
  reviewedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BulkApproveResult {
  suggestionId: string;
  success: boolean;
  ticket?: { id: string; title: string; externalUrl: string };
  error?: string;
}

export function fetchTicketSuggestions(documentId: string): Promise<TicketSuggestion[]> {
  return request<TicketSuggestion[]>(`/documents/${encodeURIComponent(documentId)}/ticket-suggestions`);
}

export function generateBulkSuggestions(documentId: string): Promise<TicketSuggestion[]> {
  return request<TicketSuggestion[]>(`/documents/${encodeURIComponent(documentId)}/bulk-suggest-tickets`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function generateFolderTicketSuggestions(
  teamId: string,
  folderPath: string,
): Promise<{ jobId: string }> {
  return request<{ jobId: string }>('/folders/suggest-tickets', {
    method: 'POST',
    body: JSON.stringify({ teamId, folderPath }),
  });
}

export function bulkApproveSuggestions(
  suggestionIds: string[],
  provider: 'github' | 'jira',
  repo?: { owner: string; name: string },
): Promise<{ jobId: string }> {
  return request<{ jobId: string }>('/ticket-suggestions/bulk-approve', {
    method: 'POST',
    body: JSON.stringify({ suggestionIds, provider, repo }),
  });
}

export function updateTicketSuggestion(
  id: string,
  updates: { title?: string; description?: string; labels?: string[] },
): Promise<TicketSuggestion> {
  return request<TicketSuggestion>(`/ticket-suggestions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

// ── Meeting Note Quality ─────────────────────────────────────────────

export interface MeetingMetrics {
  decisions: number;
  actionItems: number;
  codeReferences: number;
  openQuestions: number;
}

export interface MeetingQualityResult {
  score: number;
  suggestions: string[];
  meetingMetrics: MeetingMetrics;
}

export function analyzeMeetingQuality(content: string): Promise<MeetingQualityResult> {
  return request<MeetingQualityResult>('/ai/meeting-quality', {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export function applyMeetingSuggestions(
  content: string,
  suggestions: string[],
): Promise<{ content: string }> {
  return request<{ content: string }>('/ai/meeting-apply-suggestions', {
    method: 'POST',
    body: JSON.stringify({ content, suggestions }),
  });
}

export function dismissTicketSuggestion(id: string): Promise<TicketSuggestion> {
  return request<TicketSuggestion>(`/ticket-suggestions/${encodeURIComponent(id)}/dismiss`, {
    method: 'POST',
  });
}

// ── Agent Registry ──────────────────────────────────────────────

export interface AgentMapEntry {
  type: string;
  name: string;
  description: string;
  capabilities: string[];
  currentState: string;
  config: Record<string, unknown>;
  enabledWorkspaces: string[];
}

export function fetchAgentRegistry(): Promise<AgentMapEntry[]> {
  return request<AgentMapEntry[]>('/agent/registry');
}

export function fetchAgentDetails(type: string): Promise<AgentMapEntry> {
  return request<AgentMapEntry>(`/agent/registry/${encodeURIComponent(type)}`);
}

export function updateAgentState(type: string, state: string): Promise<AgentMapEntry> {
  return request<AgentMapEntry>(`/agent/registry/${encodeURIComponent(type)}/state`, {
    method: 'PUT',
    body: JSON.stringify({ state }),
  });
}

export function updateAgentConfig(
  type: string,
  config: Record<string, unknown>,
): Promise<AgentMapEntry> {
  return request<AgentMapEntry>(`/agent/registry/${encodeURIComponent(type)}/config`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export function enableAgent(type: string, workspaceId: string): Promise<AgentMapEntry> {
  return request<AgentMapEntry>(`/agent/registry/${encodeURIComponent(type)}/enable`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId }),
  });
}

export function disableAgent(type: string, workspaceId: string): Promise<AgentMapEntry> {
  return request<AgentMapEntry>(`/agent/registry/${encodeURIComponent(type)}/disable`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId }),
  });
}

// ── Voice / Meetings ────────────────────────────────────────────────

export interface VoiceSession {
  id: string;
  platform: 'zoom' | 'google_meet' | 'teams';
  state: 'idle' | 'connecting' | 'in_call' | 'disconnecting' | 'ended' | 'error';
  meetingUrl: string;
  startedAt: string;
  endedAt?: string;
}

export function joinCall(platform: string, meetingUrl: string): Promise<{ session: VoiceSession }> {
  return request<{ session: VoiceSession }>('/voice/join', {
    method: 'POST',
    body: JSON.stringify({ platform, meetingUrl }),
  });
}

export function leaveCall(sessionId: string): Promise<{ session: VoiceSession }> {
  return request<{ session: VoiceSession }>('/voice/leave', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}

export function createMeetingDocument(sessionId: string, teamId: string): Promise<{ documentId: string }> {
  return request<{ documentId: string }>('/voice/documents/from-meeting', {
    method: 'POST',
    body: JSON.stringify({ sessionId, teamId }),
  });
}

// ── Video Generation ─────────────────────────────────────────────────

export interface GeneratedVideo {
  id: string;
  prompt: string;
  status: string;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  duration: number;
  createdAt: string;
}

export function generateVideo(params: {
  prompt: string;
  documentId?: string;
  duration?: number;
  aspectRatio?: '16:9' | '9:16' | '1:1';
}): Promise<GeneratedVideo> {
  return request<GeneratedVideo>('/video/generate', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function listVideos(documentId: string): Promise<GeneratedVideo[]> {
  const result = await request<{ videos: GeneratedVideo[] }>(`/video?documentId=${encodeURIComponent(documentId)}`);
  return result.videos;
}

export async function downloadVideosBatch(videoIds: string[]): Promise<void> {
  const token = await resolveToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}/video/batch-download`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ videoIds }),
  });
  if (!res.ok) throw new Error('Failed to download videos');

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'nyx-videos.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Credits ─────────────────────────────────────────────────────────

export function getCreditsBalance(): Promise<{ balance: number }> {
  return request<{ balance: number }>('/credits/balance');
}

export function purchaseCredits(amount: number): Promise<{ balance: number; added: number }> {
  return request<{ balance: number; added: number }>('/credits/purchase', {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });
}

export function purchaseMarketplaceListing(listingId: string): Promise<{ content: string; title: string; balance: number }> {
  return request<{ content: string; title: string; balance: number }>(`/marketplace/${listingId}/purchase`, {
    method: 'POST',
  });
}

export function getCreditCosts(): Promise<Record<string, number>> {
  return request<Record<string, number>>('/credits/costs');
}

// ── Export: Plain Text ─────────────────────────────────────────────

export async function exportPlainText(documentId: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = await resolveToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(
    `${BASE}/export/documents/${encodeURIComponent(documentId)}/export/txt`,
    { headers },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to export plain text: ${body || res.statusText}`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'document.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Export: DOCX ───────────────────────────────────────────────────

export async function exportDocx(documentId: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = await resolveToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(
    `${BASE}/export/documents/${encodeURIComponent(documentId)}/export/docx`,
    { headers },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to export DOCX: ${body || res.statusText}`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'document.docx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Export: PDF ────────────────────────────────────────────────────

export async function exportPdf(documentId: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = await resolveToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(
    `${BASE}/export/documents/${encodeURIComponent(documentId)}/export/pdf`,
    { headers },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to export PDF: ${body || res.statusText}`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'document.pdf';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Export: Jupyter Notebook ────────────────────────────────────────

export async function exportJupyterNotebook(documentId: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = await resolveToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}/documents/${encodeURIComponent(documentId)}/export/jupyter`, {
    method: 'POST',
    headers,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to export Jupyter notebook: ${body || res.statusText}`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'document.ipynb';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── BYOK (Team AI Keys) ─────────────────────────────────────────────

export interface TeamAiKeyStatus {
  configured: boolean;
  provider?: string;
  keySuffix?: string;
  isActive?: boolean;
  createdAt?: string;
  rotatedAt?: string | null;
}

export interface AiUsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  keySource: string | null;
  byOperation: Array<{ operation: string; inputTokens: number; outputTokens: number }>;
}

export async function fetchTeamAiKeyStatus(teamId: string): Promise<TeamAiKeyStatus> {
  return request<TeamAiKeyStatus>(`${BASE}/teams/${teamId}/ai-key`);
}

export async function addTeamAiKey(
  teamId: string,
  body: { provider: string; apiKey: string },
): Promise<{ provider: string; keySuffix: string; isActive: boolean; createdAt: string }> {
  return request(`${BASE}/teams/${teamId}/ai-key`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function rotateTeamAiKey(
  teamId: string,
  body: { apiKey: string },
): Promise<{ provider: string; keySuffix: string; isActive: boolean; rotatedAt: string }> {
  return request(`${BASE}/teams/${teamId}/ai-key`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function removeTeamAiKey(teamId: string): Promise<void> {
  return request(`${BASE}/teams/${teamId}/ai-key`, { method: 'DELETE' });
}

export async function fetchTeamAiUsage(
  teamId: string,
  period = '30d',
): Promise<AiUsageSummary> {
  return request<AiUsageSummary>(`${BASE}/teams/${teamId}/ai-usage?period=${period}`);
}

// ── Atlassian Integration ────────────────────────────────────────────

export interface AtlassianConnectionStatus {
  status: 'connected' | 'token_expired' | 'disconnected' | 'error';
  connection: {
    id: string;
    cloudId: string;
    siteUrl: string;
    scopes: string[];
    status: string;
    preferences: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  } | null;
}

export function fetchAtlassianStatus(): Promise<AtlassianConnectionStatus> {
  return request<AtlassianConnectionStatus>('/integrations/atlassian/status');
}

export function disconnectAtlassian(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/integrations/atlassian/connection', {
    method: 'DELETE',
  });
}

export interface JiraProjectItem {
  id: string;
  key: string;
  name: string;
  self: string;
}

export function fetchJiraProjects(): Promise<{ projects: JiraProjectItem[] }> {
  return request<{ projects: JiraProjectItem[] }>('/integrations/atlassian/jira/projects');
}

export function createJiraIssue(payload: {
  projectKey: string;
  summary: string;
  description: string;
  issueType?: string;
  labels?: string[];
  specUrl?: string;
}): Promise<{ issue: { id: string; key: string; self: string } }> {
  return request<{ issue: { id: string; key: string; self: string } }>(
    '/integrations/atlassian/jira/issues',
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

export interface ConfluenceSpaceItem {
  id: string;
  key: string;
  name: string;
  type: string;
}

export function fetchConfluenceSpaces(): Promise<{ spaces: ConfluenceSpaceItem[] }> {
  return request<{ spaces: ConfluenceSpaceItem[] }>('/integrations/atlassian/confluence/spaces');
}

export function exportToConfluence(payload: {
  spaceId: string;
  title: string;
  content: string;
  parentPageId?: string;
  existingPageId?: string;
}): Promise<{ page: { id: string; title: string; status: string } }> {
  return request<{ page: { id: string; title: string; status: string } }>(
    '/integrations/atlassian/confluence/export',
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

export function importFromConfluence(pageId: string): Promise<{
  imported: { title: string; content: string; pageId: string; spaceId: string };
}> {
  return request<{
    imported: { title: string; content: string; pageId: string; spaceId: string };
  }>('/integrations/atlassian/confluence/import', {
    method: 'POST',
    body: JSON.stringify({ pageId }),
  });
}

export function updateAtlassianPreferences(preferences: Record<string, unknown>): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/integrations/atlassian/preferences', {
    method: 'PUT',
    body: JSON.stringify(preferences),
  });
}
