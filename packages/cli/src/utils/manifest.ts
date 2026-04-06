/**
 * .nyx/manifest.json — tracks the mapping between local .md files and remote Nyx documents.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

export interface ManifestDocEntry {
  id: string;
  remoteUpdatedAt: string;
  localHash: string;
}

export interface Manifest {
  teamId: string;
  apiUrl: string;
  docs: Record<string, ManifestDocEntry>;
}

const NYX_DIR = '.nyx';
const MANIFEST_FILE = 'manifest.json';

function manifestPath(root: string): string {
  return join(root, NYX_DIR, MANIFEST_FILE);
}

export function nyxDir(root: string): string {
  return join(root, NYX_DIR);
}

export function manifestExists(root: string): boolean {
  return existsSync(manifestPath(root));
}

export function readManifest(root: string): Manifest {
  const p = manifestPath(root);
  if (!existsSync(p)) {
    throw new Error('No .nyx/manifest.json found. Run `nyx sync init` first.');
  }
  return JSON.parse(readFileSync(p, 'utf-8')) as Manifest;
}

export function writeManifest(root: string, manifest: Manifest): void {
  const dir = join(root, NYX_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(manifestPath(root), JSON.stringify(manifest, null, 2) + '\n');
}

/** SHA-256 hash of file content for change detection. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Sanitize a document title into a valid filename slug. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'untitled';
}

/** Build the local file path for a document based on its Nyx path and title. */
export function localFilePath(docPath: string, title: string): string {
  const dir = docPath === '/' ? '' : docPath.replace(/^\//, '');
  const filename = `${slugify(title)}.md`;
  return dir ? join(dir, filename) : filename;
}

/** Ensure the directory for a file path exists. */
export function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (dir && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
