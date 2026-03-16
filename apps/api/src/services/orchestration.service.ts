// Multi-agent orchestration service: manages pipelines, step sequencing,
// document locking, and shared state for collaborative agent workflows.

import { randomUUID } from 'node:crypto';

// ── Types ───────────────────────────────────────────────────────────

export interface OrchestrationPipeline {
  id: string;
  teamId: string;
  documentId: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  steps: PipelineStep[];
  sharedState: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineStep {
  id: string;
  name: string;
  workflowId: string;
  status: 'pending' | 'locked' | 'running' | 'completed' | 'failed' | 'skipped';
  assignedSessionId?: string;
  dependsOn: string[];
  output?: unknown;
  lockedAt?: string;
  completedAt?: string;
}

export interface DocumentLock {
  documentId: string;
  sessionId: string;
  pipelineId: string;
  stepId: string;
  acquiredAt: string;
  expiresAt: string;
}

// ── In-memory stores ────────────────────────────────────────────────

const pipelines = new Map<string, OrchestrationPipeline>();
const documentLocks = new Map<string, DocumentLock>();

const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Helpers ─────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function isLockExpired(lock: DocumentLock): boolean {
  return new Date(lock.expiresAt).getTime() <= Date.now();
}

// ── Service ─────────────────────────────────────────────────────────

export const orchestrationService = {
  // Pipeline CRUD

  createPipeline(params: {
    teamId: string;
    documentId: string;
    name: string;
    steps: Array<{ name: string; workflowId: string; dependsOn?: string[] }>;
  }): OrchestrationPipeline {
    const pipelineId = randomUUID();
    const timestamp = now();

    const steps: PipelineStep[] = params.steps.map((s) => ({
      id: randomUUID(),
      name: s.name,
      workflowId: s.workflowId,
      status: 'pending',
      dependsOn: s.dependsOn ?? [],
    }));

    const pipeline: OrchestrationPipeline = {
      id: pipelineId,
      teamId: params.teamId,
      documentId: params.documentId,
      name: params.name,
      status: 'pending',
      steps,
      sharedState: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    pipelines.set(pipelineId, pipeline);
    return pipeline;
  },

  getPipeline(id: string): OrchestrationPipeline | undefined {
    return pipelines.get(id);
  },

  listPipelines(teamId: string): OrchestrationPipeline[] {
    return Array.from(pipelines.values()).filter((p) => p.teamId === teamId);
  },

  // Step execution

  claimStep(
    pipelineId: string,
    stepId: string,
    sessionId: string,
  ): { claimed: boolean; lock?: DocumentLock; reason?: string } {
    const pipeline = pipelines.get(pipelineId);
    if (!pipeline) return { claimed: false, reason: 'Pipeline not found' };

    const step = pipeline.steps.find((s) => s.id === stepId);
    if (!step) return { claimed: false, reason: 'Step not found' };

    if (step.status !== 'pending') {
      return { claimed: false, reason: `Step is already ${step.status}` };
    }

    // Check dependencies
    for (const depId of step.dependsOn) {
      const dep = pipeline.steps.find((s) => s.id === depId);
      if (!dep || dep.status !== 'completed') {
        return { claimed: false, reason: 'Dependencies not met' };
      }
    }

    // Acquire document lock
    const lock = this.acquireLock(pipeline.documentId, sessionId, pipelineId, stepId);
    if (!lock) {
      return { claimed: false, reason: 'Document is locked by another session' };
    }

    // Mark step as running
    step.status = 'running';
    step.assignedSessionId = sessionId;
    step.lockedAt = now();

    // Mark pipeline as running if still pending
    if (pipeline.status === 'pending') {
      pipeline.status = 'running';
    }
    pipeline.updatedAt = now();

    return { claimed: true, lock };
  },

  completeStep(
    pipelineId: string,
    stepId: string,
    sessionId: string,
    output?: unknown,
  ): { completed: boolean } {
    const pipeline = pipelines.get(pipelineId);
    if (!pipeline) return { completed: false };

    const step = pipeline.steps.find((s) => s.id === stepId);
    if (!step) return { completed: false };

    if (step.status !== 'running' || step.assignedSessionId !== sessionId) {
      return { completed: false };
    }

    step.status = 'completed';
    step.output = output;
    step.completedAt = now();

    // Release document lock
    this.releaseLock(pipeline.documentId, sessionId);

    // Check if all steps are completed
    const allCompleted = pipeline.steps.every(
      (s) => s.status === 'completed' || s.status === 'skipped',
    );
    if (allCompleted) {
      pipeline.status = 'completed';
    }
    pipeline.updatedAt = now();

    return { completed: true };
  },

  failStep(pipelineId: string, stepId: string, sessionId: string, error: string): void {
    const pipeline = pipelines.get(pipelineId);
    if (!pipeline) return;

    const step = pipeline.steps.find((s) => s.id === stepId);
    if (!step) return;

    if (step.assignedSessionId !== sessionId) return;

    step.status = 'failed';
    step.output = { error };
    step.completedAt = now();

    // Release document lock
    this.releaseLock(pipeline.documentId, sessionId);

    pipeline.status = 'failed';
    pipeline.updatedAt = now();
  },

  // Document locking

  acquireLock(
    documentId: string,
    sessionId: string,
    pipelineId: string,
    stepId: string,
  ): DocumentLock | null {
    const existing = documentLocks.get(documentId);

    if (existing) {
      if (isLockExpired(existing)) {
        documentLocks.delete(documentId);
      } else if (existing.sessionId !== sessionId) {
        return null;
      } else {
        // Same session re-acquiring — update the lock
        const lock: DocumentLock = {
          documentId,
          sessionId,
          pipelineId,
          stepId,
          acquiredAt: now(),
          expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
        };
        documentLocks.set(documentId, lock);
        return lock;
      }
    }

    const lock: DocumentLock = {
      documentId,
      sessionId,
      pipelineId,
      stepId,
      acquiredAt: now(),
      expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
    };
    documentLocks.set(documentId, lock);
    return lock;
  },

  releaseLock(documentId: string, sessionId: string): boolean {
    const lock = documentLocks.get(documentId);
    if (!lock || lock.sessionId !== sessionId) return false;
    documentLocks.delete(documentId);
    return true;
  },

  getLock(documentId: string): DocumentLock | null {
    const lock = documentLocks.get(documentId);
    if (!lock) return null;
    if (isLockExpired(lock)) {
      documentLocks.delete(documentId);
      return null;
    }
    return lock;
  },

  // Shared state

  getSharedState(pipelineId: string): Record<string, unknown> {
    const pipeline = pipelines.get(pipelineId);
    return pipeline?.sharedState ?? {};
  },

  updateSharedState(pipelineId: string, key: string, value: unknown): void {
    const pipeline = pipelines.get(pipelineId);
    if (!pipeline) return;
    pipeline.sharedState[key] = value;
    pipeline.updatedAt = now();
  },

  // Status

  getNextAvailableSteps(pipelineId: string): PipelineStep[] {
    const pipeline = pipelines.get(pipelineId);
    if (!pipeline) return [];

    return pipeline.steps.filter((step) => {
      if (step.status !== 'pending') return false;
      return step.dependsOn.every((depId) => {
        const dep = pipeline.steps.find((s) => s.id === depId);
        return dep?.status === 'completed';
      });
    });
  },

  // Testing helper
  _reset(): void {
    pipelines.clear();
    documentLocks.clear();
  },
};
