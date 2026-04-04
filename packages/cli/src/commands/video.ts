import { Command } from 'commander';
import { apiRequest } from '../lib/api.js';
import { formatTable, timeAgo } from '../utils/output.js';

interface VideoResponse {
  id: string;
  prompt: string;
  documentId?: string;
  status: string;
  duration?: number;
  aspectRatio?: string;
  url?: string;
  createdAt: string;
}

interface VideoListResponse {
  videos: VideoResponse[];
}

function formatVideoStatus(video: VideoResponse, format: string): string {
  if (format === 'json') {
    return JSON.stringify(video, null, 2);
  }

  const lines: string[] = [
    '',
    `  Video: ${video.id}`,
    `  Status:       ${video.status}`,
    `  Prompt:       ${video.prompt}`,
  ];

  if (video.documentId) {
    lines.push(`  Document ID:  ${video.documentId}`);
  }
  if (video.duration) {
    lines.push(`  Duration:     ${video.duration}s`);
  }
  if (video.aspectRatio) {
    lines.push(`  Aspect Ratio: ${video.aspectRatio}`);
  }
  if (video.url) {
    lines.push(`  URL:          ${video.url}`);
  }
  lines.push(`  Created:      ${new Date(video.createdAt).toLocaleString()}`);
  lines.push('');

  return lines.join('\n');
}

export function registerVideoCommand(program: Command): void {
  const video = program
    .command('video')
    .description('Generate and manage AI videos from documentation');

  // ── nyx video generate ──────────────────────────────────
  video
    .command('generate')
    .description('Trigger video generation from a prompt')
    .requiredOption('--prompt <prompt>', 'Text prompt for video generation')
    .option('--doc-id <id>', 'Document ID to associate with the video')
    .option('--duration <seconds>', 'Video duration in seconds', parseInt)
    .option('--aspect-ratio <ratio>', 'Aspect ratio (16:9|9:16|1:1)')
    .option('--format <format>', 'Output format (json|pretty)', 'pretty')
    .action(
      async (opts: {
        prompt: string;
        docId?: string;
        duration?: number;
        aspectRatio?: '16:9' | '9:16' | '1:1';
        format: string;
      }) => {
        try {
          console.log('Generating video... this may take a while.');
          const result = await apiRequest<VideoResponse>(
            '/api/video/generate',
            {
              method: 'POST',
              body: JSON.stringify({
                prompt: opts.prompt,
                documentId: opts.docId,
                duration: opts.duration,
                aspectRatio: opts.aspectRatio,
              }),
            },
          );

          console.log(formatVideoStatus(result, opts.format));
        } catch (err) {
          console.error(
            'Error:',
            err instanceof Error ? err.message : String(err),
          );
          process.exit(1);
        }
      },
    );

  // ── nyx video list ──────────────────────────────────────
  video
    .command('list')
    .description('List generated videos for a document')
    .requiredOption('--doc-id <id>', 'Document ID to list videos for')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { docId: string; format: string }) => {
      try {
        const result = await apiRequest<VideoListResponse>(
          `/api/video?documentId=${encodeURIComponent(opts.docId)}`,
        );

        if (opts.format === 'json') {
          console.log(JSON.stringify(result.videos, null, 2));
        } else {
          console.log(
            formatTable(result.videos, [
              { key: 'id', label: 'ID', width: 36 },
              { key: 'prompt', label: 'Prompt', width: 40 },
              { key: 'status', label: 'Status', width: 12 },
              {
                key: 'createdAt',
                label: 'Created',
                transform: (v) => timeAgo(String(v)),
              },
            ]),
          );
          console.log(`\n${result.videos.length} video(s)`);
        }
      } catch (err) {
        console.error(
          'Error:',
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });

  // ── nyx video status ────────────────────────────────────
  video
    .command('status')
    .description('Check the generation status of a video')
    .argument('<video-id>', 'Video ID to check')
    .option('--format <format>', 'Output format (json|pretty)', 'pretty')
    .action(async (videoId: string, opts: { format: string }) => {
      try {
        const result = await apiRequest<VideoResponse>(
          `/api/video/${encodeURIComponent(videoId)}`,
        );

        console.log(formatVideoStatus(result, opts.format));
      } catch (err) {
        console.error(
          'Error:',
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });
}
