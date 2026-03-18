import { randomUUID } from 'crypto';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import archiver from 'archiver';
import { eq } from 'drizzle-orm';
import { GoogleGenAI } from '@google/genai';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { config } from '../lib/config.js';

export interface VideoGenerationRequest {
  prompt: string;
  documentId?: string;
  duration?: number; // seconds, default 5
  aspectRatio?: '16:9' | '9:16' | '1:1';
  documentContext?: string; // document content for context-aware generation
}

export interface GeneratedVideo {
  id: string;
  prompt: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  videoUrl: string | null;
  thumbnailUrl: string | null;
  duration: number;
  createdAt: string;
  documentId?: string;
  error?: string;
}

// In-memory store for MVP
const videoStore = new Map<string, GeneratedVideo>();

// Video output directory
const VIDEO_OUTPUT_DIR = join(process.cwd(), 'generated-videos');

function getGoogleAIClient(): GoogleGenAI | null {
  const apiKey = config.GOOGLE_AI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

export const videoGenerationService = {
  async generateVideo(request: VideoGenerationRequest): Promise<GeneratedVideo> {
    const id = randomUUID();
    const duration = request.duration ?? 5;

    // Build context-aware prompt
    let contextPrompt = request.prompt;
    if (request.documentId && !request.documentContext) {
      const [doc] = await db.select().from(documents).where(eq(documents.id, request.documentId));
      if (doc) {
        const docSummary = doc.content.slice(0, 500);
        contextPrompt = `Based on this document "${doc.title}":\n${docSummary}\n\nVideo prompt: ${request.prompt}`;
      }
    } else if (request.documentContext) {
      const contextSummary = request.documentContext.slice(0, 500);
      contextPrompt = `Based on this document context:\n${contextSummary}\n\nVideo prompt: ${request.prompt}`;
    }

    const client = getGoogleAIClient();

    // Stub mode if no API key
    if (!client) {
      console.log('[VideoGen] No GOOGLE_AI_API_KEY — using stub mode');
      const video: GeneratedVideo = {
        id,
        prompt: contextPrompt,
        status: 'completed',
        videoUrl: `https://nyx-placeholder.test/videos/${id}.mp4`,
        thumbnailUrl: `https://nyx-placeholder.test/thumbnails/${id}.jpg`,
        duration,
        createdAt: new Date().toISOString(),
        documentId: request.documentId,
      };
      videoStore.set(id, video);
      return video;
    }

    // Create initial pending entry
    const video: GeneratedVideo = {
      id,
      prompt: contextPrompt,
      status: 'generating',
      videoUrl: null,
      thumbnailUrl: null,
      duration,
      createdAt: new Date().toISOString(),
      documentId: request.documentId,
    };
    videoStore.set(id, video);

    // Generate video with Google Veo 2
    try {
      const response = await client.models.generateVideos({
        model: 'veo-2.0-generate-001',
        prompt: contextPrompt,
        config: {
          aspectRatio: request.aspectRatio === '9:16' ? '9:16' : request.aspectRatio === '1:1' ? '1:1' : '16:9',
          numberOfVideos: 1,
          durationSeconds: duration <= 8 ? 5 : 8,
          personGeneration: 'allow_all',
        },
      });

      // Poll for completion
      let operation = response;
      while (!operation.done) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        operation = await client.operations.getVideosOperation({
          operation: operation,
        });
      }

      if (operation.response?.generatedVideos?.length) {
        const generatedVideo = operation.response.generatedVideos[0];

        if (generatedVideo.video?.uri) {
          // Save video file locally
          await mkdir(VIDEO_OUTPUT_DIR, { recursive: true });
          const fileName = `${id}.mp4`;
          const filePath = join(VIDEO_OUTPUT_DIR, fileName);

          // Download video from URI
          const videoResponse = await fetch(generatedVideo.video.uri);
          const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
          await writeFile(filePath, videoBuffer);

          video.status = 'completed';
          video.videoUrl = `/api/video/file/${id}.mp4`;
          video.thumbnailUrl = null;

          console.log(`[VideoGen] Video ${id} completed: ${filePath}`);
        } else {
          video.status = 'failed';
          video.error = 'No video URI in response';
        }
      } else {
        video.status = 'failed';
        video.error = 'No videos generated';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[VideoGen] Failed to generate video ${id}: ${message}`);
      video.status = 'failed';
      video.error = message;
    }

    videoStore.set(id, video);
    return video;
  },

  async getVideoStatus(videoId: string): Promise<GeneratedVideo | null> {
    return videoStore.get(videoId) ?? null;
  },

  async listVideos(documentId: string): Promise<GeneratedVideo[]> {
    const results: GeneratedVideo[] = [];
    for (const video of videoStore.values()) {
      if (video.documentId === documentId) {
        results.push(video);
      }
    }
    return results;
  },

  async generateBatchZip(videoIds: string[]): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const chunks: Buffer[] = [];

      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', (err: Error) => reject(err));

      for (const videoId of videoIds) {
        const video = videoStore.get(videoId);
        if (video) {
          if (video.videoUrl?.startsWith('/api/video/file/')) {
            // Real video file — add from disk
            const fileName = video.videoUrl.replace('/api/video/file/', '');
            const filePath = join(VIDEO_OUTPUT_DIR, fileName);
            archive.file(filePath, { name: fileName });
          } else {
            // Stub — add placeholder text
            const safeName = video.prompt.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
            archive.append(
              `Placeholder for video: ${video.prompt}\nID: ${video.id}\nDuration: ${video.duration}s\nStatus: ${video.status}\nURL: ${video.videoUrl}`,
              { name: `${safeName}.txt` },
            );
          }
        }
      }

      archive.finalize();
    });
  },

  /** Reset store — exported for testing */
  _reset(): void {
    videoStore.clear();
  },
};
