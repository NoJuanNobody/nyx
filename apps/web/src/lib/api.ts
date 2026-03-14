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
    // Detect GitHub token expiration
    if (res.status === 401 && body.includes('github_token_expired')) {
      throw new GitHubTokenExpiredError('Your GitHub connection has expired. Please reconnect.');
    }
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
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

export function createTicket(documentId: string, data: { provider: 'github' | 'jira'; title: string; body: string }): Promise<Ticket> {
  return request<Ticket>(`/documents/${encodeURIComponent(documentId)}/tickets`, {
    method: 'POST',
    body: JSON.stringify(data),
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

export function disconnectRepo(integrationId: string, repoFullName: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/integrations/${integrationId}/github/repos/${encodeURIComponent(repoFullName)}`, {
    method: 'DELETE',
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
  status: string;
}

export interface SprintCapacityData {
  sprintName: string;
  totalPoints: number;
  usedPoints: number;
  capacityPercent: number;
  tickets: SprintTicket[];
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
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
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
