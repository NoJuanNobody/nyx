import { aiService } from './ai.service.js';

export interface RepoFile {
  path: string;
  content: string;
}

interface GitHubTreeItem {
  path?: string;
  type?: string;
  size?: number;
}

export interface ModuleFiles {
  module: string;
  files: RepoFile[];
}

// ── Module detection patterns ────────────────────────────────────────

const MODULE_PATTERNS: Record<string, RegExp[]> = {
  'API Routes': [/\broutes?\b/i, /\bendpoints?\b/i],
  'Services': [/\bservices?\b/i],
  'Components': [/\bcomponents?\b/i, /\bpages?\b/i, /\bviews?\b/i],
  'Data Layer': [/\bdb\b/i, /\bschema\b/i, /\bmodels?\b/i, /\bmigrations?\b/i],
  'Middleware': [/\bmiddleware\b/i, /\bhooks?\b/i],
  'Utilities': [/\butils?\b/i, /\blib\b/i, /\bhelpers?\b/i],
  'Configuration': [/^[^/]+\.(json|ya?ml|toml)$/, /\bconfig\b/i],
};

const MAX_FILE_SIZE = 100_000; // 100KB limit per file
const MAX_PER_MODULE = 8;
const MAX_TOTAL_FILES = 80;
const FETCH_CONCURRENCY = 10;
const SMALL_REPO_THRESHOLD = 5;

// Files/dirs to always skip
const SKIP_PATTERNS = [
  /node_modules/,
  /\.git\//,
  /dist\//,
  /build\//,
  /\.next\//,
  /coverage\//,
  /\.lock$/,
  /lock\.json$/,
  /\.map$/,
  /\.min\./,
];

// Source file extensions we care about
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|swift|kt|scala|vue|svelte|astro)$/;
const CONFIG_EXTENSIONS = /\.(json|ya?ml|toml)$/;

// ── Scoring for smart sampling ───────────────────────────────────────

function scoreFile(item: GitHubTreeItem, allFiles: GitHubTreeItem[]): number {
  const path = item.path ?? '';
  const filename = path.split('/').pop() ?? '';
  const filenameNoExt = filename.replace(/\.\w+$/, '').toLowerCase();
  let score = 0;

  // Entry points
  if (filenameNoExt === 'index') score += 10;

  // Type definitions
  if (filenameNoExt === 'types' || filenameNoExt === 'interfaces' || filename.endsWith('.d.ts')) score += 8;

  // Key files
  if (['main', 'app', 'server', 'schema'].includes(filenameNoExt)) score += 7;

  // README files
  if (/^readme/i.test(filename)) score += 5;

  // Large files (top quartile by size) — likely core implementations
  const sizes = allFiles.map((f) => f.size ?? 0).sort((a, b) => a - b);
  const q75 = sizes[Math.floor(sizes.length * 0.75)] ?? 0;
  if ((item.size ?? 0) >= q75 && q75 > 0) score += 3;

  // Test files get deprioritized
  if (/\b(__tests__|test|spec)\b/i.test(path) || /\.(test|spec)\.\w+$/.test(path)) score -= 5;

  // Lock/config files get deprioritized
  if (/\.lock$|lock\.json$/.test(path)) score -= 3;

  return score;
}

// ── File tree helpers ────────────────────────────────────────────────

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.test(path) || CONFIG_EXTENSIONS.test(path) || /^readme/i.test(path.split('/').pop() ?? '');
}

function shouldSkip(path: string): boolean {
  return SKIP_PATTERNS.some((pattern) => pattern.test(path));
}

function groupFilesIntoModules(tree: GitHubTreeItem[]): Map<string, GitHubTreeItem[]> {
  const modules = new Map<string, GitHubTreeItem[]>();
  const unmatched: GitHubTreeItem[] = [];

  // Initialize module buckets
  for (const mod of Object.keys(MODULE_PATTERNS)) {
    modules.set(mod, []);
  }

  // Filter to blobs, source files, within size limit, not skipped
  const validFiles = tree.filter(
    (item) =>
      item.type === 'blob' &&
      item.path &&
      !shouldSkip(item.path) &&
      isSourceFile(item.path) &&
      (item.size ?? 0) < MAX_FILE_SIZE,
  );

  for (const item of validFiles) {
    const path = item.path!;
    let matched = false;

    for (const [mod, patterns] of Object.entries(MODULE_PATTERNS)) {
      if (patterns.some((p) => p.test(path))) {
        modules.get(mod)!.push(item);
        matched = true;
        break;
      }
    }

    if (!matched) {
      unmatched.push(item);
    }
  }

  // Put unmatched files into "Other" if any
  if (unmatched.length > 0) {
    modules.set('Other', unmatched);
  }

  // Remove empty modules
  for (const [mod, files] of modules) {
    if (files.length === 0) {
      modules.delete(mod);
    }
  }

  return modules;
}

function sampleFilesFromModule(files: GitHubTreeItem[], maxPerModule = MAX_PER_MODULE): GitHubTreeItem[] {
  if (files.length <= maxPerModule) return files;

  // Score and sort
  const scored = files.map((f) => ({ file: f, score: scoreFile(f, files) }));
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxPerModule).map((s) => s.file);
}

// ── GitHub API helpers ───────────────────────────────────────────────

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

async function fetchFilesParallel(
  accessToken: string,
  owner: string,
  repo: string,
  paths: string[],
): Promise<RepoFile[]> {
  const results: RepoFile[] = [];
  for (let i = 0; i < paths.length; i += FETCH_CONCURRENCY) {
    const batch = paths.slice(i, i + FETCH_CONCURRENCY);
    const fetched = await Promise.all(
      batch.map(async (path) => {
        const content = await fetchFileContent(accessToken, owner, repo, path);
        return content ? { path, content } : null;
      }),
    );
    results.push(...(fetched.filter(Boolean) as RepoFile[]));
  }
  return results;
}

// ── Legacy single-prompt scan (for small repos) ─────────────────────

async function scanSmallRepo(
  accessToken: string,
  owner: string,
  repo: string,
  tree: GitHubTreeItem[],
): Promise<{ files: RepoFile[]; suggestedDocs: string }> {
  const validFiles = tree.filter(
    (item) =>
      item.type === 'blob' &&
      item.path &&
      !shouldSkip(item.path) &&
      isSourceFile(item.path) &&
      (item.size ?? 0) < MAX_FILE_SIZE,
  );

  const paths = validFiles.map((item) => item.path as string);
  const files = await fetchFilesParallel(accessToken, owner, repo, paths);
  const suggestedDocs = await aiService.bootstrapDocsFromCode(files);

  return { files, suggestedDocs };
}

// ── Main service ─────────────────────────────────────────────────────

export const onboardingService = {
  async scanRepository(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<{
    files: RepoFile[];
    suggestedDocs: string;
    moduleDocs: Array<{ module: string; docs: string }>;
    moduleCount: number;
    fileCount: number;
  }> {
    // Phase 1: Get the file tree from GitHub
    const tree = await fetchGitHubFileTree(accessToken, owner, repo);

    // Count valid source files
    const validFileCount = tree.filter(
      (item) =>
        item.type === 'blob' &&
        item.path &&
        !shouldSkip(item.path) &&
        isSourceFile(item.path) &&
        (item.size ?? 0) < MAX_FILE_SIZE,
    ).length;

    // For small repos, use the legacy single-prompt approach
    if (validFileCount < SMALL_REPO_THRESHOLD) {
      const result = await scanSmallRepo(accessToken, owner, repo, tree);
      return {
        ...result,
        moduleDocs: [{ module: 'Overview', docs: result.suggestedDocs }],
        moduleCount: 1,
        fileCount: result.files.length,
      };
    }

    // Phase 2: Group into modules
    const modules = groupFilesIntoModules(tree);

    // Phase 3: Sample representative files per module
    const sampled = new Map<string, string[]>();
    let totalSampled = 0;

    for (const [mod, files] of modules) {
      const remaining = MAX_TOTAL_FILES - totalSampled;
      if (remaining <= 0) break;

      const maxForModule = Math.min(MAX_PER_MODULE, remaining);
      const selected = sampleFilesFromModule(files, maxForModule);
      const paths = selected.map((f) => f.path as string);
      sampled.set(mod, paths);
      totalSampled += paths.length;
    }

    // Phase 4: Fetch files in parallel per module
    const allFiles: RepoFile[] = [];
    const moduleFileMap = new Map<string, RepoFile[]>();

    for (const [mod, paths] of sampled) {
      const files = await fetchFilesParallel(accessToken, owner, repo, paths);
      moduleFileMap.set(mod, files);
      allFiles.push(...files);
    }

    // Phase 5: Generate docs per module in parallel (concurrency 3)
    const moduleEntries = [...moduleFileMap.entries()].filter(([, files]) => files.length > 0);
    const AI_CONCURRENCY = 3;
    const moduleDocs: Array<{ module: string; docs: string }> = [];

    for (let i = 0; i < moduleEntries.length; i += AI_CONCURRENCY) {
      const batch = moduleEntries.slice(i, i + AI_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async ([mod, files]) => ({
          module: mod,
          docs: await aiService.bootstrapModuleDocs(mod, files),
        })),
      );
      moduleDocs.push(...results);
    }

    // Phase 6: Merge module docs into a structured document
    const suggestedDocs = await aiService.mergeModuleDocs(
      moduleDocs,
      `${owner}/${repo}`,
    );

    return {
      files: allFiles,
      suggestedDocs,
      moduleDocs,
      moduleCount: moduleDocs.length,
      fileCount: allFiles.length,
    };
  },
};

// Export helpers for testing
export { groupFilesIntoModules, sampleFilesFromModule, scoreFile, fetchFilesParallel };
