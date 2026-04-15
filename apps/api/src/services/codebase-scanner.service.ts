// Codebase Scanner Service — scans connected GitHub repos and fills missing spec sections

import { eq, desc, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, integrations, changeProposals } from '../db/schema.js';
import { githubService, type GitHubTreeEntry } from './github.service.js';
import { aiService } from './ai.service.js';

// ── Types ────────────────────────────────────────────────

export interface DocumentScanResult {
  documentId: string;
  documentTitle: string;
  relevantFiles: string[];
  missingSections: Array<{ name: string; description: string; priority: 'high' | 'medium' | 'low' }>;
  proposedContent: string | null;
  proposalId: string | null;
}

export interface ScanResult {
  teamId: string;
  scannedAt: string;
  documentsScanned: number;
  proposalsCreated: number;
  results: DocumentScanResult[];
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', '.nuxt',
  'coverage', '.cache', '.turbo', '__pycache__', '.venv',
  'vendor', 'target', 'out', '.output',
]);

const IGNORED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.avi', '.mov',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.lock', '.map',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
  '.rb', '.php', '.swift', '.kt', '.cs', '.cpp', '.c', '.h',
  '.vue', '.svelte', '.astro',
  '.sql', '.graphql', '.gql', '.proto',
  '.yaml', '.yml', '.toml', '.json', '.env.example',
  '.md', '.mdx', '.txt',
  '.sh', '.bash', '.zsh',
  '.dockerfile', '.docker-compose.yml',
]);

function isRelevantFile(entry: GitHubTreeEntry): boolean {
  if (entry.type !== 'blob') return false;

  const pathParts = entry.path.split('/');
  if (pathParts.some((part) => IGNORED_DIRS.has(part))) return false;

  // Check extension
  const ext = '.' + entry.path.split('.').pop()?.toLowerCase();
  if (IGNORED_EXTENSIONS.has(ext)) return false;

  // Allow known code extensions or config files without extension
  if (CODE_EXTENSIONS.has(ext)) return true;

  // Allow common config files
  const fileName = pathParts[pathParts.length - 1];
  if (['Dockerfile', 'Makefile', 'Procfile', '.env.example'].includes(fileName)) return true;

  return false;
}

const MAX_FILES_PER_DOC = 10;
const MAX_TOTAL_CONTENT_BYTES = 50 * 1024; // 50KB

// ── Service ──────────────────────────────────────────────

export const codebaseScannerService = {
  /**
   * Scan all documents for a team against their connected GitHub repo.
   * Creates change proposals for documents with missing or incomplete sections.
   */
  async scanAndFillSpecs(teamId: string): Promise<ScanResult> {
    const scanResult: ScanResult = {
      teamId,
      scannedAt: new Date().toISOString(),
      documentsScanned: 0,
      proposalsCreated: 0,
      results: [],
    };

    // 1. Get GitHub integration
    const [integration] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.teamId, teamId), eq(integrations.type, 'github')));

    if (!integration) {
      scanResult.error = 'No GitHub integration configured for this team';
      return scanResult;
    }

    const config = integration.config as {
      accessToken?: string;
      selectedRepos?: Array<{ owner: string; name: string; fullName: string }>;
      owner?: string;
      repo?: string;
    };

    const token = config.accessToken;
    const owner = config.selectedRepos?.[0]?.owner ?? config.owner;
    const repo = config.selectedRepos?.[0]?.name ?? config.repo;

    if (!token || !owner || !repo) {
      scanResult.error = 'GitHub integration is missing access token or repository configuration';
      return scanResult;
    }

    // 2. Get file tree
    let fileTree: GitHubTreeEntry[];
    try {
      fileTree = await githubService.getFileTree(token, owner, repo);
    } catch (err) {
      scanResult.error = `Failed to fetch file tree: ${err instanceof Error ? err.message : String(err)}`;
      return scanResult;
    }

    const relevantFiles = fileTree.filter(isRelevantFile);
    const filePathList = relevantFiles.map((f) => f.path);

    // 3. Get all non-deleted team documents (the published/draft split is
    // retired — every doc is equally scan-eligible now).
    const teamDocs = await db
      .select()
      .from(documents)
      .where(and(eq(documents.teamId, teamId), isNull(documents.deletedAt)))
      .orderBy(desc(documents.updatedAt));

    if (teamDocs.length === 0) {
      scanResult.error = 'No documents found for this team';
      return scanResult;
    }

    // 4. Scan each document
    for (const doc of teamDocs) {
      try {
        const docResult = await this._scanSingleDocument(
          doc, token, owner, repo, filePathList, teamId,
        );
        scanResult.results.push(docResult);
        scanResult.documentsScanned++;
        if (docResult.proposalId) scanResult.proposalsCreated++;
      } catch (err) {
        // Best-effort per document — log and continue
        scanResult.results.push({
          documentId: doc.id,
          documentTitle: doc.title,
          relevantFiles: [],
          missingSections: [],
          proposedContent: null,
          proposalId: null,
        });
      }
    }

    return scanResult;
  },

  /**
   * Scan a single document against the connected GitHub repo.
   */
  async scanDocument(documentId: string, teamId: string): Promise<DocumentScanResult> {
    // Get the document
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.teamId, teamId)));

    if (!doc) {
      throw new Error('Document not found');
    }

    // Get GitHub integration
    const [integration] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.teamId, teamId), eq(integrations.type, 'github')));

    if (!integration) {
      throw new Error('No GitHub integration configured for this team');
    }

    const config = integration.config as {
      accessToken?: string;
      selectedRepos?: Array<{ owner: string; name: string; fullName: string }>;
      owner?: string;
      repo?: string;
    };

    const token = config.accessToken;
    const owner = config.selectedRepos?.[0]?.owner ?? config.owner;
    const repo = config.selectedRepos?.[0]?.name ?? config.repo;

    if (!token || !owner || !repo) {
      throw new Error('GitHub integration is missing access token or repository configuration');
    }

    // Get file tree
    const fileTree = await githubService.getFileTree(token, owner, repo);
    const relevantFiles = fileTree.filter(isRelevantFile);
    const filePathList = relevantFiles.map((f) => f.path);

    return this._scanSingleDocument(doc, token, owner, repo, filePathList, teamId);
  },

  /**
   * Internal: scan a single document against code files.
   */
  async _scanSingleDocument(
    doc: { id: string; title: string; content: string; stage: string | null },
    token: string,
    owner: string,
    repo: string,
    allFilePaths: string[],
    teamId: string,
  ): Promise<DocumentScanResult> {
    // Step 1: Use AI to find which code files are relevant to this document
    const matchedPaths = await this._matchCodeFiles(doc.title, doc.content, allFilePaths);

    if (matchedPaths.length === 0) {
      return {
        documentId: doc.id,
        documentTitle: doc.title,
        relevantFiles: [],
        missingSections: [],
        proposedContent: null,
        proposalId: null,
      };
    }

    // Step 2: Read the relevant code files (limited to prevent token explosion)
    const codeContents: Array<{ path: string; content: string }> = [];
    let totalBytes = 0;

    for (const filePath of matchedPaths.slice(0, MAX_FILES_PER_DOC)) {
      if (totalBytes >= MAX_TOTAL_CONTENT_BYTES) break;

      try {
        const file = await githubService.getFileContent(token, owner, repo, filePath);
        const decoded = file.encoding === 'base64'
          ? Buffer.from(file.content, 'base64').toString('utf-8')
          : file.content;

        const truncated = decoded.slice(0, MAX_TOTAL_CONTENT_BYTES - totalBytes);
        codeContents.push({ path: filePath, content: truncated });
        totalBytes += truncated.length;
      } catch {
        // Skip files that can't be read
      }
    }

    if (codeContents.length === 0) {
      return {
        documentId: doc.id,
        documentTitle: doc.title,
        relevantFiles: matchedPaths,
        missingSections: [],
        proposedContent: null,
        proposalId: null,
      };
    }

    // Step 3: Analyze missing sections based on actual code
    const { missingSections, proposedContent } = await this._analyzeAndGenerate(
      doc.title, doc.content, doc.stage, codeContents,
    );

    // Step 4: Create a change proposal if there's content to propose
    let proposalId: string | null = null;
    if (proposedContent && missingSections.length > 0) {
      try {
        const [proposal] = await db
          .insert(changeProposals)
          .values({
            documentId: doc.id,
            teamId,
            // Use a system user ID for automated proposals
            createdById: '00000000-0000-0000-0000-000000000000',
            title: `[Auto-scan] Fill missing sections for "${doc.title}"`,
            description: `Codebase scan found ${missingSections.length} missing or incomplete section(s) based on the actual implementation code.\n\nMissing sections:\n${missingSections.map((s) => `- **${s.name}** (${s.priority}): ${s.description}`).join('\n')}`,
            status: 'pending',
            suggestedTickets: [],
            sourceVersions: [],
          })
          .returning();

        proposalId = proposal.id;
      } catch {
        // Proposal creation is best-effort
      }
    }

    return {
      documentId: doc.id,
      documentTitle: doc.title,
      relevantFiles: matchedPaths,
      missingSections,
      proposedContent,
      proposalId,
    };
  },

  /**
   * Use AI to match a document to relevant code file paths.
   */
  async _matchCodeFiles(
    docTitle: string,
    docContent: string,
    allFilePaths: string[],
  ): Promise<string[]> {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const { config } = await import('../lib/config.js');

      if (!config.ANTHROPIC_API_KEY) return [];

      const ai = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

      // Limit the file list to prevent token overflow
      const fileListStr = allFilePaths.slice(0, 500).join('\n');
      const docSnippet = docContent.slice(0, 2000);

      const response = await ai.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `You are a code-to-documentation matcher. Given a spec document and a list of file paths from a repository, identify which code files are most relevant to the spec.

Return ONLY a JSON array of file paths, ordered by relevance (most relevant first). Return at most 10 paths. Example: ["src/services/auth.ts", "src/routes/login.ts"]

If no files seem relevant, return an empty array: []`,
        messages: [{
          role: 'user',
          content: `## Document: "${docTitle}"\n\n${docSnippet}\n\n## Repository Files\n${fileListStr}`,
        }],
      });

      let text = response.content[0].type === 'text' ? response.content[0].text : '[]';
      text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

      const parsed = JSON.parse(text) as string[];
      // Validate that returned paths exist in the original list
      const validPaths = new Set(allFilePaths);
      return Array.isArray(parsed)
        ? parsed.filter((p) => typeof p === 'string' && validPaths.has(p)).slice(0, MAX_FILES_PER_DOC)
        : [];
    } catch {
      return [];
    }
  },

  /**
   * Analyze missing sections and generate fill content based on actual code.
   */
  async _analyzeAndGenerate(
    docTitle: string,
    docContent: string,
    docStage: string | null,
    codeContents: Array<{ path: string; content: string }>,
  ): Promise<{
    missingSections: Array<{ name: string; description: string; priority: 'high' | 'medium' | 'low' }>;
    proposedContent: string | null;
  }> {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const { config } = await import('../lib/config.js');

      if (!config.ANTHROPIC_API_KEY) {
        return { missingSections: [], proposedContent: null };
      }

      const ai = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

      const codeBlock = codeContents
        .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
        .join('\n\n');

      const stageContext = docStage ? ` This is a "${docStage}" stage document.` : '';

      const response = await ai.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: `You are a spec completeness analyzer. Given a specification document and the actual implementation code, identify what sections are missing or incomplete in the spec, then generate the missing content based on what the code actually implements.${stageContext}

Respond ONLY with valid JSON in this exact format:
{
  "missingSections": [
    {"name": "section name", "description": "what is missing", "priority": "high|medium|low"}
  ],
  "proposedContent": "The full updated document content with missing sections filled in based on the code. Use markdown format. Preserve existing content and add new sections where appropriate."
}

If the spec is already complete relative to the code, return:
{"missingSections": [], "proposedContent": null}`,
        messages: [{
          role: 'user',
          content: `## Specification: "${docTitle}"\n\n${docContent}\n\n## Implementation Code\n\n${codeBlock}`,
        }],
      });

      let text = response.content[0].type === 'text' ? response.content[0].text : '';
      text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

      // Try to extract JSON
      const jsonMatch = text.match(/\{[\s\S]*"missingSections"\s*:[\s\S]*\}/);
      const jsonCandidate = jsonMatch ? jsonMatch[0] : text;

      const parsed = JSON.parse(jsonCandidate) as {
        missingSections: Array<{ name: string; description: string; priority: string }>;
        proposedContent: string | null;
      };

      const missingSections = Array.isArray(parsed.missingSections)
        ? parsed.missingSections
            .filter((s) => s.name && s.description && ['high', 'medium', 'low'].includes(s.priority))
            .map((s) => ({
              name: s.name,
              description: s.description,
              priority: s.priority as 'high' | 'medium' | 'low',
            }))
        : [];

      return {
        missingSections,
        proposedContent: typeof parsed.proposedContent === 'string' ? parsed.proposedContent : null,
      };
    } catch {
      return { missingSections: [], proposedContent: null };
    }
  },
};
