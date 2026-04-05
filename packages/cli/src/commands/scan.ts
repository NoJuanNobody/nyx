import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { error } from '../utils/output.js';

interface ScanDocumentResult {
  documentId: string;
  documentTitle: string;
  relevantFiles: string[];
  missingSections: Array<{ name: string; description: string; priority: string }>;
  proposedContent: string | null;
  proposalId: string | null;
}

interface ScanResult {
  teamId: string;
  scannedAt: string;
  documentsScanned: number;
  proposalsCreated: number;
  results: ScanDocumentResult[];
  error?: string;
}

function priorityIcon(priority: string): string {
  switch (priority) {
    case 'high': return '!!!';
    case 'medium': return '!! ';
    case 'low': return '!  ';
    default: return '   ';
  }
}

function printScanResult(result: ScanResult): void {
  const check = '\u2713';
  const cross = '\u2717';
  const line = '\u2500'.repeat(50);

  console.log('');
  console.log('  Codebase Scan Results');
  console.log(`  ${line}`);

  if (result.error) {
    console.log(`  ${cross} ${result.error}`);
    console.log('');
    return;
  }

  console.log(`  Scanned at:       ${result.scannedAt}`);
  console.log(`  Documents:        ${result.documentsScanned}`);
  console.log(`  Proposals created: ${result.proposalsCreated}`);
  console.log('');

  if (result.results.length === 0) {
    console.log('  No documents found to scan.');
    console.log('');
    return;
  }

  for (const doc of result.results) {
    const icon = doc.missingSections.length > 0 ? cross : check;
    console.log(`  ${icon} ${doc.documentTitle}`);

    if (doc.relevantFiles.length > 0) {
      console.log(`    Related files: ${doc.relevantFiles.length}`);
      for (const f of doc.relevantFiles.slice(0, 5)) {
        console.log(`      - ${f}`);
      }
      if (doc.relevantFiles.length > 5) {
        console.log(`      ... and ${doc.relevantFiles.length - 5} more`);
      }
    }

    if (doc.missingSections.length > 0) {
      console.log('    Missing sections:');
      for (const s of doc.missingSections) {
        console.log(`      ${priorityIcon(s.priority)} ${s.name}: ${s.description}`);
      }
    }

    if (doc.proposalId) {
      console.log(`    Proposal: ${doc.proposalId} (pending review)`);
    }

    console.log('');
  }
}

function printDocResult(result: ScanDocumentResult): void {
  const check = '\u2713';
  const cross = '\u2717';
  const line = '\u2500'.repeat(50);

  console.log('');
  console.log(`  Document Scan: ${result.documentTitle}`);
  console.log(`  ${line}`);

  if (result.relevantFiles.length > 0) {
    console.log(`  Related code files (${result.relevantFiles.length}):`);
    for (const f of result.relevantFiles) {
      console.log(`    - ${f}`);
    }
    console.log('');
  }

  if (result.missingSections.length === 0) {
    console.log(`  ${check} Spec is complete relative to the codebase.`);
  } else {
    console.log(`  ${cross} Found ${result.missingSections.length} missing section(s):`);
    for (const s of result.missingSections) {
      console.log(`    ${priorityIcon(s.priority)} ${s.name}: ${s.description}`);
    }
  }

  if (result.proposalId) {
    console.log('');
    console.log(`  Change proposal created: ${result.proposalId}`);
    console.log('  Review with: nyx proposals list');
  }

  console.log('');
}

export function registerScanCommand(program: Command): void {
  program
    .command('scan [doc-id]')
    .description('Scan codebase to fill missing spec sections')
    .option('--team-id <id>', 'Team ID')
    .option('--format <format>', 'Output format (json|pretty)', 'pretty')
    .action(async (docId: string | undefined, opts: { teamId?: string; format: string }) => {
      try {
        const client = new NyxClient();
        const teamId = resolveTeamId(opts.teamId);

        if (docId) {
          // Single document scan
          console.log(`Scanning document ${docId}...`);
          const result = await client.post<ScanDocumentResult>('/api/scanner/scan-document', {
            documentId: docId,
            teamId,
          });

          if (opts.format === 'json') {
            console.log(JSON.stringify(result, null, 2));
          } else {
            printDocResult(result);
          }
        } else {
          // Full team scan
          console.log('Scanning entire codebase...');
          const result = await client.post<ScanResult>('/api/scanner/scan', { teamId });

          if (opts.format === 'json') {
            console.log(JSON.stringify(result, null, 2));
          } else {
            printScanResult(result);
          }
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
