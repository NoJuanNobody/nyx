import { apiRequest } from './auth.js';

/**
 * MCP resource definitions — expose Nyx documents as browsable resources.
 */

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    uriTemplate: 'nyx://docs',
    name: 'All Documents',
    description: 'List all documents in Nyx',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'nyx://docs/{id}',
    name: 'Document Content',
    description: 'Read a specific document by ID',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'nyx://docs/{id}/versions',
    name: 'Document Versions',
    description: 'List version history for a document',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'nyx://teams',
    name: 'All Teams',
    description: 'List all teams the user belongs to',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'nyx://teams/{id}',
    name: 'Team Details',
    description: 'Get details for a specific team',
    mimeType: 'application/json',
  },
];

interface TeamSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}

interface DocSummary {
  id: string;
  title: string;
  path: string;
  status: string;
}

interface DocFull {
  id: string;
  title: string;
  content: string;
  path: string;
  status: string;
}

interface DocVersion {
  id: string;
  version: number;
  message: string | null;
  createdAt: string;
}

/**
 * Resolve a resource URI to its content.
 */
export async function resolveResource(uri: string): Promise<{ content: string; mimeType: string }> {
  // nyx://teams
  if (uri === 'nyx://teams') {
    const teams = await apiRequest<TeamSummary[]>('/api/teams');
    return {
      content: JSON.stringify(teams, null, 2),
      mimeType: 'application/json',
    };
  }

  // nyx://teams/{id}
  const teamMatch = uri.match(/^nyx:\/\/teams\/([^/]+)$/);
  if (teamMatch) {
    const teamId = teamMatch[1];
    const team = await apiRequest<TeamSummary>(`/api/teams/${teamId}`);
    return {
      content: JSON.stringify(team, null, 2),
      mimeType: 'application/json',
    };
  }

  // nyx://docs
  if (uri === 'nyx://docs') {
    // List all docs — we need a teamId; for MCP we use a broad listing
    const docs = await apiRequest<DocSummary[]>('/api/documents');
    return {
      content: JSON.stringify(docs, null, 2),
      mimeType: 'application/json',
    };
  }

  // nyx://docs/{id}/versions
  const versionsMatch = uri.match(/^nyx:\/\/docs\/([^/]+)\/versions$/);
  if (versionsMatch) {
    const docId = versionsMatch[1];
    const versions = await apiRequest<DocVersion[]>(`/api/documents/${docId}/versions`);
    return {
      content: JSON.stringify(versions, null, 2),
      mimeType: 'application/json',
    };
  }

  // nyx://docs/{id}
  const docMatch = uri.match(/^nyx:\/\/docs\/([^/]+)$/);
  if (docMatch) {
    const docId = docMatch[1];
    const doc = await apiRequest<DocFull>(`/api/documents/${docId}`);
    return {
      content: `# ${doc.title}\n\n${doc.content}`,
      mimeType: 'text/markdown',
    };
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}
