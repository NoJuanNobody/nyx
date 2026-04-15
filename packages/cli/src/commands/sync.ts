import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, extname } from 'node:path';
import { NyxClient, resolveTeamId } from '../client.js';
import { error } from '../utils/output.js';
import {
  readManifest,
  writeManifest,
  manifestExists,
  nyxDir,
  contentHash,
  localFilePath,
  ensureDir,
  type Manifest,
} from '../utils/manifest.js';
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from '../utils/frontmatter.js';

interface NyxDocument {
  id: string;
  title: string;
  content: string;
  path: string;
  status: string;
  stage: string | null;
  updatedAt: string;
}

export function registerSyncCommand(program: Command): void {
  const sync = program.command('sync').description('Two-way sync between Nyx docs and local .md files');

  // ── init ──────────────────────────────────────────────

  sync
    .command('init')
    .description('Initialize a sync workspace in the current directory')
    .option('--team-id <teamId>', 'Team ID')
    .action(async (opts: { teamId?: string }) => {
      try {
        const cwd = process.cwd();
        if (manifestExists(cwd)) {
          console.log('.nyx/manifest.json already exists. Nothing to do.');
          return;
        }

        const teamId = resolveTeamId(opts.teamId);
        const client = new NyxClient();

        const manifest: Manifest = {
          teamId,
          apiUrl: client.apiUrl,
          docs: {},
        };

        writeManifest(cwd, manifest);

        // Add .nyx/ to .gitignore if it exists and doesn't already have it
        const gitignorePath = join(cwd, '.gitignore');
        if (existsSync(gitignorePath)) {
          const gitignore = readFileSync(gitignorePath, 'utf-8');
          if (!gitignore.includes('.nyx/') && !gitignore.includes('.nyx\n')) {
            writeFileSync(gitignorePath, gitignore.trimEnd() + '\n.nyx/\n');
            console.log('Added .nyx/ to .gitignore');
          }
        }

        console.log(`Initialized Nyx sync workspace (team: ${teamId})`);
        console.log('Run `nyx sync pull` to download documents.');
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── pull ──────────────────────────────────────────────

  sync
    .command('pull')
    .description('Pull remote Nyx documents to local .md files')
    .option('--force', 'Overwrite local changes without prompting')
    .action(async (opts: { force?: boolean }) => {
      try {
        const cwd = process.cwd();
        const manifest = readManifest(cwd);
        const client = new NyxClient();

        const docs = await client.get<NyxDocument[]>(
          `/api/documents?teamId=${manifest.teamId}`,
        );

        let created = 0;
        let updated = 0;
        let unchanged = 0;

        // The API already filters out soft-deleted documents by default
        // (deletedAt IS NOT NULL). No per-doc filter needed here.
        for (const doc of docs) {
          const filePath = localFilePath(doc.path, doc.title);
          const absPath = join(cwd, filePath);
          const existing = manifest.docs[filePath];

          // Build frontmatter
          const meta: Frontmatter = {
            nyx_id: doc.id,
            title: doc.title,
            stage: doc.stage,
            status: doc.status,
            path: doc.path,
          };
          const fileContent = serializeFrontmatter(meta, doc.content);
          const hash = contentHash(fileContent);

          // Check if we need to write
          if (existing) {
            // Already tracked — check if remote changed
            if (existing.remoteUpdatedAt === doc.updatedAt && existing.localHash === hash) {
              unchanged++;
              continue;
            }

            // Check for local modifications
            if (!opts.force && existsSync(absPath)) {
              const currentContent = readFileSync(absPath, 'utf-8');
              const currentHash = contentHash(currentContent);
              if (currentHash !== existing.localHash) {
                console.log(`  skip  ${filePath} (local changes — use --force to overwrite)`);
                continue;
              }
            }

            updated++;
          } else {
            created++;
          }

          // Write file
          ensureDir(absPath);
          writeFileSync(absPath, fileContent);

          // Update manifest
          manifest.docs[filePath] = {
            id: doc.id,
            remoteUpdatedAt: doc.updatedAt,
            localHash: hash,
          };
        }

        writeManifest(cwd, manifest);

        const total = created + updated;
        console.log(
          `Pulled ${total} document(s): ${created} new, ${updated} updated, ${unchanged} unchanged`,
        );
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── push ──────────────────────────────────────────────

  sync
    .command('push')
    .description('Push local .md file changes to Nyx')
    .action(async () => {
      try {
        const cwd = process.cwd();
        const manifest = readManifest(cwd);
        const client = new NyxClient();

        let pushed = 0;
        let unchanged = 0;
        let missing = 0;

        for (const [filePath, entry] of Object.entries(manifest.docs)) {
          const absPath = join(cwd, filePath);

          if (!existsSync(absPath)) {
            console.log(`  missing  ${filePath} (file deleted locally)`);
            missing++;
            continue;
          }

          const raw = readFileSync(absPath, 'utf-8');
          const currentHash = contentHash(raw);

          if (currentHash === entry.localHash) {
            unchanged++;
            continue;
          }

          // Parse frontmatter to get metadata
          const { meta, content } = parseFrontmatter(raw);
          const docId = meta.nyx_id ?? entry.id;

          const body: Record<string, unknown> = { content };
          if (meta.title) body.title = meta.title;
          if (meta.path) body.path = meta.path;
          if (meta.status) body.status = meta.status;
          if (meta.stage !== undefined) body.stage = meta.stage;

          const result = await client.put<NyxDocument>(`/api/documents/${docId}`, body);

          // Update manifest
          manifest.docs[filePath] = {
            id: docId,
            remoteUpdatedAt: result.updatedAt,
            localHash: currentHash,
          };

          console.log(`  pushed  ${filePath}`);
          pushed++;
        }

        writeManifest(cwd, manifest);

        console.log(
          `Pushed ${pushed} document(s): ${unchanged} unchanged${missing ? `, ${missing} missing` : ''}`,
        );
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── status ────────────────────────────────────────────

  sync
    .command('status')
    .description('Show sync status of tracked files')
    .action(async () => {
      try {
        const cwd = process.cwd();
        const manifest = readManifest(cwd);
        const client = new NyxClient();

        const tracked = Object.entries(manifest.docs);
        if (tracked.length === 0) {
          console.log('No documents tracked. Run `nyx sync pull` to download.');
          return;
        }

        let clean = 0;

        for (const [filePath, entry] of tracked) {
          const absPath = join(cwd, filePath);

          // Check local state
          if (!existsSync(absPath)) {
            console.log(`  deleted     ${filePath}`);
            continue;
          }

          const raw = readFileSync(absPath, 'utf-8');
          const currentHash = contentHash(raw);
          const localChanged = currentHash !== entry.localHash;

          // Check remote state
          let remoteChanged = false;
          try {
            const doc = await client.get<NyxDocument>(`/api/documents/${entry.id}`);
            remoteChanged = doc.updatedAt !== entry.remoteUpdatedAt;
          } catch {
            console.log(`  error       ${filePath} (could not fetch remote)`);
            continue;
          }

          if (localChanged && remoteChanged) {
            console.log(`  conflict    ${filePath}`);
          } else if (localChanged) {
            console.log(`  modified    ${filePath}`);
          } else if (remoteChanged) {
            console.log(`  behind      ${filePath}`);
          } else {
            clean++;
          }
        }

        // Scan for untracked .md files
        const untracked = findMdFiles(cwd).filter(
          (f) => !manifest.docs[f] && !f.startsWith('.nyx/'),
        );
        for (const f of untracked) {
          console.log(`  untracked   ${f}`);
        }

        if (clean === tracked.length && untracked.length === 0) {
          console.log('Everything up to date.');
        } else if (clean > 0) {
          console.log(`\n${clean} file(s) up to date`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── add ───────────────────────────────────────────────

  sync
    .command('add <file>')
    .description('Create a new Nyx document from a local .md file')
    .action(async (file: string) => {
      try {
        const cwd = process.cwd();
        const manifest = readManifest(cwd);
        const client = new NyxClient();

        const absPath = join(cwd, file);
        if (!existsSync(absPath)) {
          throw new Error(`File not found: ${file}`);
        }

        const raw = readFileSync(absPath, 'utf-8');
        const { meta, content } = parseFrontmatter(raw);

        if (meta.nyx_id) {
          throw new Error(`File already tracked (nyx_id: ${meta.nyx_id}). Use \`nyx sync push\` instead.`);
        }

        // Derive metadata
        const relPath = relative(cwd, absPath);
        const dir = dirname(relPath);
        const nyxPath = dir === '.' ? '/' : `/${dir}`;
        const title = meta.title || relPath.replace(/\.md$/, '').replace(/[-_]/g, ' ');

        const doc = await client.post<NyxDocument>('/api/documents', {
          teamId: manifest.teamId,
          title,
          content,
          path: nyxPath,
          stage: meta.stage || undefined,
        });

        // Rewrite file with nyx_id in frontmatter
        const newMeta: Frontmatter = {
          nyx_id: doc.id,
          title: doc.title,
          stage: doc.stage,
          status: doc.status,
          path: doc.path,
        };
        const newContent = serializeFrontmatter(newMeta, content);
        writeFileSync(absPath, newContent);

        // Add to manifest
        manifest.docs[relPath] = {
          id: doc.id,
          remoteUpdatedAt: doc.updatedAt,
          localHash: contentHash(newContent),
        };
        writeManifest(cwd, manifest);

        console.log(`Created: ${doc.title} (${doc.id})`);
        console.log(`  path: ${doc.path}`);
        console.log(`  file: ${relPath}`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}

// ── helpers ────────────────────────────────────────────

/** Recursively find all .md files relative to root, skipping node_modules and hidden dirs. */
function findMdFiles(root: string, dir = ''): string[] {
  const results: string[] = [];
  const absDir = dir ? join(root, dir) : root;

  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const relPath = dir ? join(dir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      results.push(...findMdFiles(root, relPath));
    } else if (extname(entry.name) === '.md') {
      results.push(relPath);
    }
  }

  return results;
}
