import { randomUUID } from 'crypto';
import archiver from 'archiver';

export interface VideoGenerationRequest {
  prompt: string;
  documentId?: string;
  duration?: number; // seconds, default 5
  aspectRatio?: '16:9' | '9:16' | '1:1';
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
}

// In-memory store for MVP
const videoStore = new Map<string, GeneratedVideo>();

export const videoGenerationService = {
  async generateVideo(request: VideoGenerationRequest): Promise<GeneratedVideo> {
    const id = randomUUID();
    const duration = request.duration ?? 5;

    // Stub implementation — in production this would call Replicate/Sora API
    const video: GeneratedVideo = {
      id,
      prompt: request.prompt,
      status: 'completed',
      videoUrl: `https://nyx-placeholder.test/videos/${id}.mp4`,
      thumbnailUrl: `https://nyx-placeholder.test/thumbnails/${id}.jpg`,
      duration,
      createdAt: new Date().toISOString(),
      documentId: request.documentId,
    };

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
          // Since videos are stubs, create placeholder text files
          const safeName = video.prompt.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
          archive.append(
            `Placeholder for video: ${video.prompt}\nID: ${video.id}\nDuration: ${video.duration}s\nStatus: ${video.status}\nURL: ${video.videoUrl}`,
            { name: `${safeName}.txt` },
          );
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
