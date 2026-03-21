import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import archiver from 'archiver';
import { eq } from 'drizzle-orm';
import { GoogleGenAI } from '@google/genai';
import { db } from '../db/index.js';
import { documents, generatedVideos } from '../db/schema.js';
import { config } from '../lib/config.js';

export interface VideoGenerationRequest {
  prompt: string;
  documentId?: string;
  duration?: number;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  documentContext?: string;
}

export interface GeneratedVideo {
  id: string;
  prompt: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  videoUrl: string | null;
  thumbnailUrl: string | null;
  duration: number;
  createdAt: string;
  documentId?: string | null;
  error?: string | null;
}

const VIDEO_OUTPUT_DIR = join(process.cwd(), 'generated-videos');

function getGoogleAIClient(): GoogleGenAI | null {
  const apiKey = config.GOOGLE_AI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

async function buildContextPrompt(request: VideoGenerationRequest): Promise<string> {
  let contextPrompt = request.prompt;

  if (request.documentId && !request.documentContext) {
    try {
      const [doc] = await db.select().from(documents).where(eq(documents.id, request.documentId));
      if (doc) {
        const docSummary = doc.content.slice(0, 500);
        contextPrompt = `Based on this document "${doc.title}":\n${docSummary}\n\nVideo prompt: ${request.prompt}`;
      }
    } catch {
      // Invalid UUID or DB error — continue with original prompt
    }
  } else if (request.documentContext) {
    const contextSummary = request.documentContext.slice(0, 500);
    contextPrompt = `Based on this document context:\n${contextSummary}\n\nVideo prompt: ${request.prompt}`;
  }

  return contextPrompt;
}

async function generateInBackground(
  id: string,
  client: GoogleGenAI,
  contextPrompt: string,
  aspectRatio: string | undefined,
): Promise<void> {
  try {
    const ar = aspectRatio === '9:16' ? '9:16' : aspectRatio === '1:1' ? '1:1' : '16:9';

    const response = await client.models.generateVideos({
      model: 'veo-3.0-fast-generate-001',
      prompt: contextPrompt,
      config: {
        aspectRatio: ar,
        numberOfVideos: 1,
      },
    });

    let operation = response;
    while (!operation.done) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      operation = await client.operations.getVideosOperation({ operation });
    }

    if (operation.response?.generatedVideos?.length) {
      const generatedVideo = operation.response.generatedVideos[0];

      if (generatedVideo.video?.uri) {
        // Download and store the video locally so batch download works
        const downloadUrl = new URL(generatedVideo.video.uri);
        downloadUrl.searchParams.set('key', config.GOOGLE_AI_API_KEY!);

        let videoUrl = downloadUrl.toString();
        try {
          await mkdir(VIDEO_OUTPUT_DIR, { recursive: true });
          const res = await fetch(downloadUrl.toString());
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const fileName = `${id}.mp4`;
            await writeFile(join(VIDEO_OUTPUT_DIR, fileName), buffer);
            videoUrl = `/api/video/file/${fileName}`;
          }
        } catch {
          // Fall back to remote URL if local save fails
        }

        await db.update(generatedVideos).set({
          status: 'completed',
          videoUrl,
        }).where(eq(generatedVideos.id, id));

        console.log(`[VideoGen] Video ${id} completed`);
      } else {
        await db.update(generatedVideos).set({ status: 'failed', error: 'No video URI in response' }).where(eq(generatedVideos.id, id));
      }
    } else {
      await db.update(generatedVideos).set({ status: 'failed', error: 'No videos generated' }).where(eq(generatedVideos.id, id));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[VideoGen] Failed to generate video ${id}: ${message}`);
    await db.update(generatedVideos).set({ status: 'failed', error: message.slice(0, 500) }).where(eq(generatedVideos.id, id)).catch(() => {});
  }
}

function toGeneratedVideo(row: typeof generatedVideos.$inferSelect): GeneratedVideo {
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status,
    videoUrl: row.videoUrl,
    thumbnailUrl: row.thumbnailUrl,
    duration: row.duration,
    createdAt: row.createdAt.toISOString(),
    documentId: row.documentId,
    error: row.error,
  };
}

export const videoGenerationService = {
  async generateVideo(request: VideoGenerationRequest): Promise<GeneratedVideo> {
    const duration = request.duration ?? 5;
    const contextPrompt = await buildContextPrompt(request);
    const client = getGoogleAIClient();

    // Insert into DB
    const [row] = await db.insert(generatedVideos).values({
      documentId: request.documentId ?? null,
      prompt: contextPrompt,
      status: client ? 'generating' : 'completed',
      videoUrl: client ? null : `https://nyx-placeholder.test/videos/stub.mp4`,
      duration,
    }).returning();

    if (!client) {
      console.log('[VideoGen] No GOOGLE_AI_API_KEY — using stub mode');
      return toGeneratedVideo(row);
    }

    // Generate in background
    generateInBackground(row.id, client, contextPrompt, request.aspectRatio).catch(() => {});

    return toGeneratedVideo(row);
  },

  async getVideoStatus(videoId: string): Promise<GeneratedVideo | null> {
    const [row] = await db.select().from(generatedVideos).where(eq(generatedVideos.id, videoId));
    return row ? toGeneratedVideo(row) : null;
  },

  async listVideos(documentId: string): Promise<GeneratedVideo[]> {
    const rows = await db.select().from(generatedVideos).where(eq(generatedVideos.documentId, documentId));
    return rows.map(toGeneratedVideo);
  },

  async generateBatchZip(videoIds: string[]): Promise<Buffer | null> {
    let included = 0;

    return new Promise<Buffer | null>(async (resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const chunks: Buffer[] = [];

      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('end', () => resolve(included > 0 ? Buffer.concat(chunks) : null));
      archive.on('error', (err: Error) => reject(err));

      for (const videoId of videoIds) {
        const [video] = await db.select().from(generatedVideos).where(eq(generatedVideos.id, videoId));
        if (!video) continue;

        const safeName = video.prompt.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);

        // Skip stub/placeholder videos — no real file exists
        if (video.videoUrl?.includes('placeholder.test')) continue;

        // Check for local file: either from videoUrl or by ID convention
        const localFileName = video.videoUrl?.startsWith('/api/video/file/')
          ? video.videoUrl.replace('/api/video/file/', '')
          : `${video.id}.mp4`;
        const localFilePath = join(VIDEO_OUTPUT_DIR, localFileName);

        if (existsSync(localFilePath)) {
          archive.file(localFilePath, { name: `${safeName}.mp4` });
          included++;
        } else if (video.videoUrl && video.status === 'completed') {
          try {
            const res = await fetch(video.videoUrl);
            if (res.ok) {
              const buffer = Buffer.from(await res.arrayBuffer());
              archive.append(buffer, { name: `${safeName}.mp4` });
              included++;
            }
          } catch {
            // Skip unfetchable videos
          }
        }
      }

      archive.finalize();
    });
  },
};
