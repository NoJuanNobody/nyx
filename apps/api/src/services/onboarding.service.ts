import { aiService } from './ai.service.js';

interface RepoFile {
  path: string;
  content: string;
}

interface GitHubTreeItem {
  path?: string;
  type?: string;
  size?: number;
}

const DOC_RELEVANT_PATTERNS = [
  /^readme/i,
  /^package\.json$/,
  /^tsconfig.*\.json$/,
  /^src\/.*\.ts$/,
  /^src\/.*\.tsx$/,
  /^lib\/.*\.ts$/,
  /^app\/.*\.ts$/,
  /^app\/.*\.tsx$/,
];

const MAX_FILES = 20;
const MAX_FILE_SIZE = 100_000; // 100KB limit per file

function isDocRelevant(path: string): boolean {
  return DOC_RELEVANT_PATTERNS.some((pattern) => pattern.test(path));
}

async function fetchGitHubFileTree(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<GitHubTreeItem[]> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { tree: GitHubTreeItem[] };
  return data.tree;
}

async function fetchFileContent(
  accessToken: string,
  owner: string,
  repo: string,
  path: string,
): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    },
  );

  if (!response.ok) {
    return '';
  }

  const data = (await response.json()) as { content?: string; encoding?: string };
  if (data.content && data.encoding === 'base64') {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }

  return '';
}

export const onboardingService = {
  async scanRepository(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<{ files: RepoFile[]; suggestedDocs: string }> {
    // Get the file tree from GitHub
    const tree = await fetchGitHubFileTree(accessToken, owner, repo);

    // Filter for doc-relevant files (blobs only, within size limit)
    const relevantPaths = tree
      .filter(
        (item) =>
          item.type === 'blob' &&
          item.path &&
          isDocRelevant(item.path) &&
          (item.size ?? 0) < MAX_FILE_SIZE,
      )
      .map((item) => item.path as string)
      .slice(0, MAX_FILES);

    // Fetch content for each relevant file
    const files: RepoFile[] = [];
    for (const path of relevantPaths) {
      const content = await fetchFileContent(accessToken, owner, repo, path);
      if (content) {
        files.push({ path, content });
      }
    }

    // Use AI service to bootstrap documentation
    const suggestedDocs = await aiService.bootstrapDocsFromCode(files);

    return { files, suggestedDocs };
  },
};
