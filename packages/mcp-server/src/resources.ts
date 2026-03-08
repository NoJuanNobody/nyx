import { apiRequest } from './auth.js';

/**
 * MCP resource definitions — expose SyncDocs documents as browsable resources.
 */

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    uriTemplate: 'syncdocs://docs',
    name: 'All Documents',
    description: 'List all documents in SyncDocs',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'syncdocs://docs/{id}',
    name: 'Document Content',
    description: 'Read a specific document by ID',
    mimeType: 'text/markdown',
  },
  {
    uriTemplate: 'syncdocs://docs/{id}/versions',
    name: 'Document Versions',
    description: 'List version history for a document',
    mimeType: 'application/json',
  },
];

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
  // syncdocs://docs
  if (uri === 'syncdocs://docs') {
    // List all docs — we need a teamId; for MCP we use a broad listing
    const docs = await apiRequest<DocSummary[]>('/api/documents');
    return {
      content: JSON.stringify(docs, null, 2),
      mimeType: 'application/json',
    };
  }

  // syncdocs://docs/{id}/versions
  const versionsMatch = uri.match(/^syncdocs:\/\/docs\/([^/]+)\/versions$/);
  if (versionsMatch) {
    const docId = versionsMatch[1];
    const versions = await apiRequest<DocVersion[]>(`/api/documents/${docId}/versions`);
    return {
      content: JSON.stringify(versions, null, 2),
      mimeType: 'application/json',
    };
  }

  // syncdocs://docs/{id}
  const docMatch = uri.match(/^syncdocs:\/\/docs\/([^/]+)$/);
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
