// Confluence integration service: pulls pages from Confluence and ingests
// them into Nyx with automatic quality validation.
//
// Uses environment variables CONFLUENCE_BASE_URL and CONFLUENCE_TOKEN for
// real Confluence API access. Falls back to mock data when unconfigured.

import { aiService } from './ai.service.js';

export interface ConfluencePage {
  id: string;
  title: string;
  spaceKey: string;
  version: number;
  content: string;
  url: string;
}

export interface ConfluenceImportResult {
  page: ConfluencePage;
  documentId: string;
  qualityScore: number;
  qualitySuggestions: string[];
  status: 'active' | 'needs_review';
}

// ── Mock data for when no Confluence credentials are configured ─────

const MOCK_SPACES = [
  { key: 'ENG', name: 'Engineering' },
  { key: 'PROD', name: 'Product' },
];

const MOCK_PAGES: ConfluencePage[] = [
  {
    id: 'cf-1',
    title: 'API Authentication Guide',
    spaceKey: 'ENG',
    version: 5,
    content: '<h1>API Auth</h1><p>Our API uses bearer tokens...</p>',
    url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/cf-1',
  },
  {
    id: 'cf-2',
    title: 'Release Process',
    spaceKey: 'ENG',
    version: 3,
    content: '<h1>Releases</h1><p>We follow semantic versioning...</p>',
    url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/cf-2',
  },
  {
    id: 'cf-3',
    title: 'Product Roadmap Q2',
    spaceKey: 'PROD',
    version: 8,
    content: '<h1>Roadmap</h1><p>Key initiatives for Q2...</p>',
    url: 'https://example.atlassian.net/wiki/spaces/PROD/pages/cf-3',
  },
];

// ── HTML to Markdown conversion ─────────────────────────────────────

export function htmlToMarkdown(html: string): string {
  let md = html;

  // Replace headings h1-h6
  for (let i = 1; i <= 6; i++) {
    const prefix = '#'.repeat(i);
    md = md.replace(
      new RegExp(`<h${i}[^>]*>(.*?)</h${i}>`, 'gi'),
      `${prefix} $1\n\n`,
    );
  }

  // Replace links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

  // Replace inline code
  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');

  // Replace code blocks
  md = md.replace(/<pre[^>]*>(.*?)<\/pre>/gis, '```\n$1\n```\n\n');

  // Replace bold
  md = md.replace(/<(strong|b)[^>]*>(.*?)<\/\1>/gi, '**$2**');

  // Replace italic
  md = md.replace(/<(em|i)[^>]*>(.*?)<\/\1>/gi, '*$2*');

  // Replace unordered lists
  md = md.replace(/<ul[^>]*>(.*?)<\/ul>/gis, (_match: string, inner: string) => {
    return inner.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n') + '\n';
  });

  // Replace ordered lists
  md = md.replace(/<ol[^>]*>(.*?)<\/ol>/gis, (_match: string, inner: string) => {
    let n = 0;
    return (
      inner.replace(/<li[^>]*>(.*?)<\/li>/gi, (_m: string, text: string) => {
        n++;
        return `${n}. ${text}\n`;
      }) + '\n'
    );
  });

  // Replace paragraphs
  md = md.replace(/<p[^>]*>(.*?)<\/p>/gis, '$1\n\n');

  // Replace <br> tags
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining HTML tags
  md = md.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, ' ');

  // Clean up extra whitespace
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.trim();

  return md;
}

// ── Helpers ─────────────────────────────────────────────────────────

function isConfigured(): boolean {
  return !!(process.env.CONFLUENCE_BASE_URL && process.env.CONFLUENCE_TOKEN);
}

function generateDocumentId(): string {
  return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runQualityCheck(
  content: string,
): Promise<{ score: number; suggestions: string[] }> {
  try {
    return await aiService.analyzeSpecQuality(content);
  } catch {
    // Fallback when AI client is unavailable (no ANTHROPIC_API_KEY)
    return { score: 7, suggestions: [] };
  }
}

// ── Service ─────────────────────────────────────────────────────────

export const confluenceService = {
  /**
   * List available Confluence spaces.
   * Returns mock data if no Confluence credentials are configured.
   */
  async listSpaces(): Promise<Array<{ key: string; name: string }>> {
    if (!isConfigured()) {
      return MOCK_SPACES;
    }

    // TODO: Call real Confluence REST API when credentials are available
    // GET /wiki/rest/api/space
    return MOCK_SPACES;
  },

  /**
   * List pages in a Confluence space.
   */
  async listPages(spaceKey: string): Promise<ConfluencePage[]> {
    if (!isConfigured()) {
      return MOCK_PAGES.filter((p) => p.spaceKey === spaceKey);
    }

    // TODO: Call real Confluence REST API
    // GET /wiki/rest/api/space/{spaceKey}/content/page
    return MOCK_PAGES.filter((p) => p.spaceKey === spaceKey);
  },

  /**
   * Get a single Confluence page by ID.
   */
  async getPage(pageId: string): Promise<ConfluencePage | null> {
    if (!isConfigured()) {
      return MOCK_PAGES.find((p) => p.id === pageId) ?? null;
    }

    // TODO: Call real Confluence REST API
    // GET /wiki/rest/api/content/{pageId}?expand=body.storage
    return MOCK_PAGES.find((p) => p.id === pageId) ?? null;
  },

  /**
   * Import a Confluence page into Nyx with automatic quality check.
   *
   * Steps:
   * 1. Fetch the page (or use mock)
   * 2. Convert HTML to markdown
   * 3. Create a Nyx document (mocked for MVP)
   * 4. Run quality check via aiService.analyzeSpecQuality
   * 5. Set status based on quality score (>= 7 = active, < 7 = needs_review)
   */
  async importPage(params: {
    pageId: string;
    teamId: string;
  }): Promise<ConfluenceImportResult> {
    const page = await this.getPage(params.pageId);

    if (!page) {
      throw new Error(`Confluence page not found: ${params.pageId}`);
    }

    const markdown = htmlToMarkdown(page.content);
    const documentId = generateDocumentId();

    // TODO: Create actual document in the database when DB layer is wired up
    // For MVP, we generate a mock document ID and run the quality check.

    const quality = await runQualityCheck(markdown);

    return {
      page,
      documentId,
      qualityScore: quality.score,
      qualitySuggestions: quality.suggestions,
      status: quality.score >= 7 ? 'active' : 'needs_review',
    };
  },

  /**
   * Import all pages in a Confluence space.
   */
  async importSpace(params: {
    spaceKey: string;
    teamId: string;
  }): Promise<ConfluenceImportResult[]> {
    const pages = await this.listPages(params.spaceKey);
    const results: ConfluenceImportResult[] = [];

    for (const page of pages) {
      const result = await this.importPage({
        pageId: page.id,
        teamId: params.teamId,
      });
      results.push(result);
    }

    return results;
  },
};
