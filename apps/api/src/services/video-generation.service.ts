import { randomUUID } from 'crypto';
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
        await mkdir(VIDEO_OUTPUT_DIR, { recursive: true });
        const fileName = `${id}.mp4`;
        const filePath = join(VIDEO_OUTPUT_DIR, fileName);

        const downloadUrl = new URL(generatedVideo.video.uri);
        downloadUrl.searchParams.set('key', config.GOOGLE_AI_API_KEY!);
        const videoResponse = await fetch(downloadUrl.toString());

        if (!videoResponse.ok) {
          const errBody = await videoResponse.text().catch(() => 'Download failed');
          await db.update(generatedVideos).set({ status: 'failed', error: errBody.slice(0, 500) }).where(eq(generatedVideos.id, id));
          console.error(`[VideoGen] Video ${id} download failed: ${errBody.slice(0, 200)}`);
          return;
        }

        const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

        if (videoBuffer.length < 1000 || videoBuffer.slice(0, 1).toString() === '{') {
          const text = videoBuffer.toString('utf-8').slice(0, 300);
          await db.update(generatedVideos).set({ status: 'failed', error: text }).where(eq(generatedVideos.id, id));
          console.error(`[VideoGen] Video ${id} invalid content`);
          return;
        }

        await writeFile(filePath, videoBuffer);
        await db.update(generatedVideos).set({
          status: 'completed',
          videoUrl: `/api/video/file/${id}.mp4`,
        }).where(eq(generatedVideos.id, id));

        console.log(`[VideoGen] Video ${id} completed (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
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

  async generateBatchZip(videoIds: string[]): Promise<Buffer> {
    return new Promise<Buffer>(async (resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const chunks: Buffer[] = [];

      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', (err: Error) => reject(err));

      for (const videoId of videoIds) {
        const [video] = await db.select().from(generatedVideos).where(eq(generatedVideos.id, videoId));
        if (video) {
          if (video.videoUrl?.startsWith('/api/video/file/')) {
            const fileName = video.videoUrl.replace('/api/video/file/', '');
            const filePath = join(VIDEO_OUTPUT_DIR, fileName);
            archive.file(filePath, { name: fileName });
          } else {
            const safeName = video.prompt.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
            archive.append(
              `Video: ${video.prompt}\nID: ${video.id}\nDuration: ${video.duration}s\nStatus: ${video.status}`,
              { name: `${safeName}.txt` },
            );
          }
        }
      }

      archive.finalize();
    });
  },
};
