import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import tarStream from 'tar-stream';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { onboardingProgress } from '../db/schema.js';
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

export interface ScanResult {
  files: RepoFile[];
  suggestedDocs: string;
  moduleDocs: Array<{ module: string; docs: string }>;
  moduleCount: number;
  fileCount: number;
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
const SMALL_REPO_THRESHOLD = 5;

// Bounded concurrency for per-module AI calls.
//
// Anthropic's default tier comfortably handles 6 concurrent
// messages.create requests per team; do NOT raise further without
// checking current limits. The bound MUST stay enforced — a single
// unbounded Promise.all over all modules will trip the rate limiter
// on larger repos.
const AI_CONCURRENCY = 6;

// Scan-result cache TTL. Re-scans of the same { owner, repo, headSha }
// within this window return the cached result with zero GitHub/AI
// calls.
const SCAN_CACHE_TTL_MS = 10 * 60 * 1000;

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

// ── In-memory scan cache ────────────────────────────────────────────

interface ScanCacheEntry {
  result: ScanResult;
  expiresAt: number;
}

const scanResultCache = new Map<string, ScanCacheEntry>();

function scanCacheKey(owner: string, repo: string, headSha: string): string {
  return `${owner}/${repo}@${headSha}`;
}

/**
 * Manually invalidate all cached scan results for a given {owner, repo}.
 * Exposed for future use (e.g., webhook-triggered cache busting); not
 * called by the main scan pipeline today.
 */
export function invalidateScanCache(owner: string, repo: string): void {
  const prefix = `${owner}/${repo}@`;
  for (const key of scanResultCache.keys()) {
    if (key.startsWith(prefix)) {
      scanResultCache.delete(key);
    }
  }
}

/** Test helper: wipe the cache completely. */
export function _resetScanCache(): void {
  scanResultCache.clear();
}

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

interface RepoTreeResult {
  tree: GitHubTreeItem[];
  headSha: string;
}

async function fetchGitHubFileTree(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<RepoTreeResult> {
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

  const data = (await response.json()) as { tree: GitHubTreeItem[]; sha?: string };
  return { tree: data.tree, headSha: data.sha ?? '' };
}

/**
 * Download a repository as a gzipped tarball in a single request, stream
 * it through gunzip + tar-stream, and return only the entries that pass
 * the existing shouldSkip / isSourceFile / MAX_FILE_SIZE filters.
 *
 * The tarball endpoint returns a 302 redirect to codeload.github.com.
 * Node's `fetch` follows redirects by default and GitHub honors the
 * Authorization header through the redirect for both PAT and
 * installation tokens.
 *
 * The tarball path prefix is `{repo}-{shortSha}/...`. We strip that
 * prefix before using paths as map keys so downstream code can look
 * them up by the repo-relative path it already knows.
 */
async function fetchRepoTarball(
  accessToken: string,
  owner: string,
  repo: string,
  ref: string = 'HEAD',
): Promise<Map<string, string>> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/tarball/${ref}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
      redirect: 'follow',
    },
  );

  if (!response.ok || !response.body) {
    throw new Error(
      `GitHub tarball fetch failed: ${response.status} ${response.statusText}`,
    );
  }

  const fileMap = new Map<string, string>();
  const extract = tarStream.extract();

  extract.on('entry', (header, stream, next) => {
    // Only keep regular files
    if (header.type !== 'file') {
      stream.on('end', next);
      stream.resume();
      return;
    }

    // Strip the `{repo}-{shortSha}/` prefix so keys are repo-relative.
    const firstSlash = header.name.indexOf('/');
    const relPath = firstSlash === -1 ? header.name : header.name.slice(firstSlash + 1);

    // Apply the same filters we used to apply per file.
    if (!relPath || shouldSkip(relPath) || !isSourceFile(relPath)) {
      stream.on('end', next);
      stream.resume();
      return;
    }

    const declaredSize = header.size ?? 0;
    if (declaredSize >= MAX_FILE_SIZE) {
      stream.on('end', next);
      stream.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let overflowed = false;
    stream.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      total += chunk.length;
      if (total >= MAX_FILE_SIZE) {
        overflowed = true;
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (!overflowed) {
        fileMap.set(relPath, Buffer.concat(chunks).toString('utf-8'));
      }
      next();
    });
    stream.on('error', (err) => next(err));
  });

  // Convert the web ReadableStream from fetch into a Node stream, then
  // pipe it through gunzip into the tar extractor.
  const bodyStream =
    typeof (response.body as unknown as { pipe?: unknown }).pipe === 'function'
      ? (response.body as unknown as NodeJS.ReadableStream)
      : Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream);

  try {
    await pipeline(bodyStream, createGunzip(), extract);
  } catch (err) {
    throw new Error(
      `GitHub tarball stream failed: ${(err as Error).message ?? 'unknown error'}`,
    );
  }

  return fileMap;
}

// ── Legacy single-prompt scan (for small repos) ─────────────────────

async function scanSmallRepo(
  tarballFiles: Map<string, string>,
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

  const files: RepoFile[] = [];
  for (const item of validFiles) {
    const content = tarballFiles.get(item.path!);
    if (content !== undefined) {
      files.push({ path: item.path!, content });
    }
  }
  const suggestedDocs = await aiService.bootstrapDocsFromCode(files);

  return { files, suggestedDocs };
}

// ── Main service ─────────────────────────────────────────────────────

export const onboardingService = {
  async getProgress(userId: string): Promise<string[]> {
    const rows = await db
      .select({ stepKey: onboardingProgress.stepKey })
      .from(onboardingProgress)
      .where(eq(onboardingProgress.userId, userId));
    return rows.map(r => r.stepKey);
  },

  async markStepComplete(userId: string, stepKey: string): Promise<void> {
    await db
      .insert(onboardingProgress)
      .values({ userId, stepKey })
      .onConflictDoNothing();
  },

  async scanRepository(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<ScanResult> {
    // Phase 1: Get the file tree from GitHub (for module grouping and
    // a stable HEAD SHA used as the cache key).
    const { tree, headSha } = await fetchGitHubFileTree(accessToken, owner, repo);

    // Phase 1b: Cache check — if we've scanned this exact commit
    // recently, return the cached result with zero further GitHub or
    // AI work.
    if (headSha) {
      const key = scanCacheKey(owner, repo, headSha);
      const cached = scanResultCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }
      // Opportunistic GC of expired entries.
      if (cached) scanResultCache.delete(key);
    }

    // Count valid source files
    const validFileCount = tree.filter(
      (item) =>
        item.type === 'blob' &&
        item.path &&
        !shouldSkip(item.path) &&
        isSourceFile(item.path) &&
        (item.size ?? 0) < MAX_FILE_SIZE,
    ).length;

    // Phase 2: Fetch the entire repository as a single tarball. This
    // replaces up to 80 per-file Contents API calls with one streamed
    // HTTP request, unpacked in memory with the existing shouldSkip /
    // isSourceFile / MAX_FILE_SIZE filters applied during extraction.
    const tarballFiles = await fetchRepoTarball(accessToken, owner, repo);

    // For small repos, use the legacy single-prompt approach.
    if (validFileCount < SMALL_REPO_THRESHOLD) {
      const result = await scanSmallRepo(tarballFiles, tree);
      const scanResult: ScanResult = {
        ...result,
        moduleDocs: [{ module: 'Overview', docs: result.suggestedDocs }],
        moduleCount: 1,
        fileCount: result.files.length,
      };
      if (headSha) {
        scanResultCache.set(scanCacheKey(owner, repo, headSha), {
          result: scanResult,
          expiresAt: Date.now() + SCAN_CACHE_TTL_MS,
        });
      }
      return scanResult;
    }

    // Phase 3: Group into modules
    const modules = groupFilesIntoModules(tree);

    // Phase 4: Sample representative files per module
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

    // Phase 5: Build per-module file maps from the in-memory tarball.
    // No network I/O — just Map lookups. The outer per-module fetch
    // loop from the previous implementation has been deleted.
    const allFiles: RepoFile[] = [];
    const moduleFileMap = new Map<string, RepoFile[]>();

    for (const [mod, paths] of sampled) {
      const files: RepoFile[] = [];
      for (const path of paths) {
        const content = tarballFiles.get(path);
        if (content !== undefined) {
          files.push({ path, content });
        }
      }
      moduleFileMap.set(mod, files);
      allFiles.push(...files);
    }

    // Phase 6: Generate docs per module in parallel, bounded by
    // AI_CONCURRENCY. We keep the explicit batching loop — do NOT
    // replace with a single Promise.all over every module.
    const moduleEntries = [...moduleFileMap.entries()].filter(([, files]) => files.length > 0);
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

    // Phase 7: Merge module docs into a structured document
    const suggestedDocs = await aiService.mergeModuleDocs(
      moduleDocs,
      `${owner}/${repo}`,
    );

    const scanResult: ScanResult = {
      files: allFiles,
      suggestedDocs,
      moduleDocs,
      moduleCount: moduleDocs.length,
      fileCount: allFiles.length,
    };

    if (headSha) {
      scanResultCache.set(scanCacheKey(owner, repo, headSha), {
        result: scanResult,
        expiresAt: Date.now() + SCAN_CACHE_TTL_MS,
      });
    }

    return scanResult;
  },
};

// Export helpers for testing
export {
  groupFilesIntoModules,
  sampleFilesFromModule,
  scoreFile,
  fetchRepoTarball,
  AI_CONCURRENCY,
  SCAN_CACHE_TTL_MS,
};
