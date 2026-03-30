import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { backgroundJobs } from '../db/schema.js';

export const jobService = {
  async create(teamId: string, userId: string, type: string, input: Record<string, unknown> = {}) {
    const [job] = await db
      .insert(backgroundJobs)
      .values({ teamId, userId, type, input })
      .returning();
    return job;
  },

  async getById(jobId: string) {
    const [job] = await db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.id, jobId));
    return job ?? null;
  },

  async markRunning(jobId: string) {
    const [job] = await db
      .update(backgroundJobs)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(backgroundJobs.id, jobId))
      .returning();
    return job;
  },

  async updateProgress(jobId: string, progress: number, message?: string) {
    const [job] = await db
      .update(backgroundJobs)
      .set({ progress, progressMessage: message ?? null })
      .where(eq(backgroundJobs.id, jobId))
      .returning();
    return job;
  },

  async markCompleted(jobId: string, result: unknown) {
    const [job] = await db
      .update(backgroundJobs)
      .set({ status: 'completed', result, completedAt: new Date() })
      .where(eq(backgroundJobs.id, jobId))
      .returning();
    return job;
  },

  async markFailed(jobId: string, error: string) {
    const [job] = await db
      .update(backgroundJobs)
      .set({ status: 'failed', error, completedAt: new Date() })
      .where(eq(backgroundJobs.id, jobId))
      .returning();
    return job;
  },
};
