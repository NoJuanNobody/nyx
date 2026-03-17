import { describe, it, expect, beforeEach } from 'vitest';
import { orchestrationService } from '../../services/orchestration.service.js';

describe('Orchestration Service', () => {
  beforeEach(() => {
    orchestrationService._reset();
  });

  // ── Pipeline CRUD ──────────────────────────────────────────────────

  describe('createPipeline', () => {
    it('creates a pipeline with multiple steps', () => {
      const pipeline = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Review Pipeline',
        steps: [
          { name: 'Analyze', workflowId: 'full_spec_review' },
          { name: 'Generate', workflowId: 'doc_generation', dependsOn: [] },
        ],
      });

      expect(pipeline.id).toBeTruthy();
      expect(pipeline.teamId).toBe('team-1');
      expect(pipeline.documentId).toBe('doc-1');
      expect(pipeline.name).toBe('Review Pipeline');
      expect(pipeline.status).toBe('pending');
      expect(pipeline.steps).toHaveLength(2);
      expect(pipeline.sharedState).toEqual({});
      expect(pipeline.steps[0].status).toBe('pending');
      expect(pipeline.steps[0].dependsOn).toEqual([]);
    });

    it('creates step dependencies correctly', () => {
      const pipeline = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Chained Pipeline',
        steps: [
          { name: 'Step A', workflowId: 'wf-a' },
        ],
      });

      const stepAId = pipeline.steps[0].id;

      const pipeline2 = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-2',
        name: 'Pipeline 2',
        steps: [
          { name: 'Step A', workflowId: 'wf-a' },
          { name: 'Step B', workflowId: 'wf-b', dependsOn: [stepAId] },
        ],
      });

      // dependsOn references are stored (even if cross-pipeline; caller is responsible for correct IDs)
      expect(pipeline2.steps[1].dependsOn).toContain(stepAId);
    });
  });

  describe('getPipeline', () => {
    it('returns the pipeline by id', () => {
      const created = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Test',
        steps: [{ name: 'S1', workflowId: 'wf-1' }],
      });
      expect(orchestrationService.getPipeline(created.id)).toEqual(created);
    });

    it('returns undefined for unknown id', () => {
      expect(orchestrationService.getPipeline('nonexistent')).toBeUndefined();
    });
  });

  describe('listPipelines', () => {
    it('returns pipelines filtered by teamId', () => {
      orchestrationService.createPipeline({
        teamId: 'team-a',
        documentId: 'doc-1',
        name: 'P1',
        steps: [{ name: 'S1', workflowId: 'wf-1' }],
      });
      orchestrationService.createPipeline({
        teamId: 'team-b',
        documentId: 'doc-2',
        name: 'P2',
        steps: [{ name: 'S1', workflowId: 'wf-1' }],
      });

      const teamAPipelines = orchestrationService.listPipelines('team-a');
      expect(teamAPipelines).toHaveLength(1);
      expect(teamAPipelines[0].name).toBe('P1');
    });
  });

  // ── Step lifecycle ─────────────────────────────────────────────────

  describe('claimStep', () => {
    it('claims a step with no dependencies', () => {
      const pipeline = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Test',
        steps: [{ name: 'S1', workflowId: 'wf-1' }],
      });
      const stepId = pipeline.steps[0].id;

      const result = orchestrationService.claimStep(pipeline.id, stepId, 'session-1');

      expect(result.claimed).toBe(true);
      expect(result.lock).toBeDefined();
      expect(result.lock!.sessionId).toBe('session-1');

      const updated = orchestrationService.getPipeline(pipeline.id)!;
      expect(updated.steps[0].status).toBe('running');
      expect(updated.steps[0].assignedSessionId).toBe('session-1');
      expect(updated.status).toBe('running');
    });

    it('rejects claim when dependencies are not met', () => {
      const pipeline = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Test',
        steps: [
          { name: 'S1', workflowId: 'wf-1' },
        ],
      });
      const stepAId = pipeline.steps[0].id;

      // Create a second pipeline with a step that depends on stepA
      const pipeline2 = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-2',
        name: 'Test2',
        steps: [
          { name: 'S1', workflowId: 'wf-1' },
          { name: 'S2', workflowId: 'wf-2', dependsOn: [stepAId] },
        ],
      });

      // stepAId is from pipeline1, not pipeline2, so it won't be found
      // Let's use a proper pipeline with internal deps instead
      const p = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-3',
        name: 'Chained',
        steps: [
          { name: 'S1', workflowId: 'wf-1' },
        ],
      });

      const s1Id = p.steps[0].id;

      // Now create pipeline where S2 depends on S1
      const p2 = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-4',
        name: 'Dep test',
        steps: [
          { name: 'First', workflowId: 'wf-1' },
          { name: 'Second', workflowId: 'wf-2' },
        ],
      });

      // Manually set dependsOn for the second step (using first step's id within same pipeline)
      const firstId = p2.steps[0].id;
      p2.steps[1].dependsOn = [firstId];

      const result = orchestrationService.claimStep(p2.id, p2.steps[1].id, 'session-1');
      expect(result.claimed).toBe(false);
      expect(result.reason).toBe('Dependencies not met');
    });

    it('rejects concurrent claim on same step', () => {
      const pipeline = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Test',
        steps: [{ name: 'S1', workflowId: 'wf-1' }],
      });
      const stepId = pipeline.steps[0].id;

      orchestrationService.claimStep(pipeline.id, stepId, 'session-1');
      const result = orchestrationService.claimStep(pipeline.id, stepId, 'session-2');

      expect(result.claimed).toBe(false);
      expect(result.reason).toBe('Step is already running');
    });

    it('rejects claim when document is locked by another session', () => {
      // Two pipelines on the same document
      const p1 = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'shared-doc',
        name: 'P1',
        steps: [{ name: 'S1', workflowId: 'wf-1' }],
      });
      const p2 = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'shared-doc',
        name: 'P2',
        steps: [{ name: 'S1', workflowId: 'wf-1' }],
      });

      orchestrationService.claimStep(p1.id, p1.steps[0].id, 'session-1');
      const result = orchestrationService.claimStep(p2.id, p2.steps[0].id, 'session-2');

      expect(result.claimed).toBe(false);
      expect(result.reason).toBe('Document is locked by another session');
    });
  });

  describe('completeStep', () => {
    it('completes a running step and releases the lock', () => {
      const pipeline = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Test',
        steps: [{ name: 'S1', workflowId: 'wf-1' }],
      });
      const stepId = pipeline.steps[0].id;

      orchestrationService.claimStep(pipeline.id, stepId, 'session-1');
      const result = orchestrationService.completeStep(pipeline.id, stepId, 'session-1', {
        summary: 'done',
      });

      expect(result.completed).toBe(true);

      const updated = orchestrationService.getPipeline(pipeline.id)!;
      expect(updated.steps[0].status).toBe('completed');
      expect(updated.steps[0].output).toEqual({ summary: 'done' });
      expect(updated.steps[0].completedAt).toBeTruthy();

      // Lock should be released
      expect(orchestrationService.getLock('doc-1')).toBeNull();
    });

    it('rejects completion from wrong session', () => {
      const pipeline = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Test',
        steps: [{ name: 'S1', workflowId: 'wf-1' }],
      });
      const stepId = pipeline.steps[0].id;

      orchestrationService.claimStep(pipeline.id, stepId, 'session-1');
      const result = orchestrationService.completeStep(pipeline.id, stepId, 'session-2');

      expect(result.completed).toBe(false);
    });
  });

  describe('pipeline auto-completion', () => {
    it('marks pipeline as completed when all steps complete', () => {
      const pipeline = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Two step',
        steps: [
          { name: 'S1', workflowId: 'wf-1' },
          { name: 'S2', workflowId: 'wf-2' },
        ],
      });

      const s1 = pipeline.steps[0].id;
      const s2 = pipeline.steps[1].id;

      orchestrationService.claimStep(pipeline.id, s1, 'session-1');
      orchestrationService.completeStep(pipeline.id, s1, 'session-1');

      orchestrationService.claimStep(pipeline.id, s2, 'session-2');
      orchestrationService.completeStep(pipeline.id, s2, 'session-2');

      const updated = orchestrationService.getPipeline(pipeline.id)!;
      expect(updated.status).toBe('completed');
    });
  });

  describe('failStep', () => {
    it('marks step and pipeline as failed', () => {
      const pipeline = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Test',
        steps: [{ name: 'S1', workflowId: 'wf-1' }],
      });
      const stepId = pipeline.steps[0].id;

      orchestrationService.claimStep(pipeline.id, stepId, 'session-1');
      orchestrationService.failStep(pipeline.id, stepId, 'session-1', 'Something went wrong');

      const updated = orchestrationService.getPipeline(pipeline.id)!;
      expect(updated.steps[0].status).toBe('failed');
      expect(updated.steps[0].output).toEqual({ error: 'Something went wrong' });
      expect(updated.status).toBe('failed');

      // Lock should be released
      expect(orchestrationService.getLock('doc-1')).toBeNull();
    });
  });

  // ── Document locking ───────────────────────────────────────────────

  describe('document locking', () => {
    it('acquires and releases a lock', () => {
      const lock = orchestrationService.acquireLock('doc-1', 'session-1', 'p-1', 's-1');
      expect(lock).not.toBeNull();
      expect(lock!.documentId).toBe('doc-1');
      expect(lock!.sessionId).toBe('session-1');

      const released = orchestrationService.releaseLock('doc-1', 'session-1');
      expect(released).toBe(true);
      expect(orchestrationService.getLock('doc-1')).toBeNull();
    });

    it('prevents a different session from acquiring a held lock', () => {
      orchestrationService.acquireLock('doc-1', 'session-1', 'p-1', 's-1');
      const lock2 = orchestrationService.acquireLock('doc-1', 'session-2', 'p-1', 's-2');
      expect(lock2).toBeNull();
    });

    it('allows same session to re-acquire its own lock', () => {
      orchestrationService.acquireLock('doc-1', 'session-1', 'p-1', 's-1');
      const lock2 = orchestrationService.acquireLock('doc-1', 'session-1', 'p-1', 's-2');
      expect(lock2).not.toBeNull();
      expect(lock2!.stepId).toBe('s-2');
    });

    it('expired lock can be acquired by another session', () => {
      // Acquire a lock then manually expire it
      const lock = orchestrationService.acquireLock('doc-1', 'session-1', 'p-1', 's-1');
      expect(lock).not.toBeNull();

      // Mutate expiresAt to the past to simulate expiry
      (lock as any).expiresAt = new Date(Date.now() - 1000).toISOString();

      const lock2 = orchestrationService.acquireLock('doc-1', 'session-2', 'p-1', 's-2');
      expect(lock2).not.toBeNull();
      expect(lock2!.sessionId).toBe('session-2');
    });

    it('getLock returns null for expired lock', () => {
      const lock = orchestrationService.acquireLock('doc-1', 'session-1', 'p-1', 's-1');
      (lock as any).expiresAt = new Date(Date.now() - 1000).toISOString();

      expect(orchestrationService.getLock('doc-1')).toBeNull();
    });

    it('releaseLock fails for wrong session', () => {
      orchestrationService.acquireLock('doc-1', 'session-1', 'p-1', 's-1');
      expect(orchestrationService.releaseLock('doc-1', 'session-2')).toBe(false);
    });
  });

  // ── Shared state ───────────────────────────────────────────────────

  describe('shared state', () => {
    it('reads and writes shared state', () => {
      const pipeline = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Test',
        steps: [{ name: 'S1', workflowId: 'wf-1' }],
      });

      orchestrationService.updateSharedState(pipeline.id, 'analysis', { score: 85 });
      orchestrationService.updateSharedState(pipeline.id, 'tags', ['api', 'auth']);

      const state = orchestrationService.getSharedState(pipeline.id);
      expect(state).toEqual({
        analysis: { score: 85 },
        tags: ['api', 'auth'],
      });
    });

    it('returns empty object for unknown pipeline', () => {
      expect(orchestrationService.getSharedState('nonexistent')).toEqual({});
    });
  });

  // ── getNextAvailableSteps ──────────────────────────────────────────

  describe('getNextAvailableSteps', () => {
    it('returns steps with all dependencies completed', () => {
      const pipeline = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Chained',
        steps: [
          { name: 'S1', workflowId: 'wf-1' },
          { name: 'S2', workflowId: 'wf-2' },
          { name: 'S3', workflowId: 'wf-3' },
        ],
      });

      const s1 = pipeline.steps[0].id;
      const s2 = pipeline.steps[1].id;

      // S2 depends on S1, S3 depends on S2
      pipeline.steps[1].dependsOn = [s1];
      pipeline.steps[2].dependsOn = [s2];

      // Initially only S1 is available (no deps)
      let available = orchestrationService.getNextAvailableSteps(pipeline.id);
      expect(available.map((s) => s.name)).toEqual(['S1']);

      // Complete S1 → S2 becomes available
      orchestrationService.claimStep(pipeline.id, s1, 'session-1');
      orchestrationService.completeStep(pipeline.id, s1, 'session-1');

      available = orchestrationService.getNextAvailableSteps(pipeline.id);
      expect(available.map((s) => s.name)).toEqual(['S2']);

      // Complete S2 → S3 becomes available
      orchestrationService.claimStep(pipeline.id, s2, 'session-1');
      orchestrationService.completeStep(pipeline.id, s2, 'session-1');

      available = orchestrationService.getNextAvailableSteps(pipeline.id);
      expect(available.map((s) => s.name)).toEqual(['S3']);
    });

    it('returns multiple steps when they have no shared dependencies', () => {
      const pipeline = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Parallel',
        steps: [
          { name: 'S1', workflowId: 'wf-1' },
          { name: 'S2', workflowId: 'wf-2' },
          { name: 'S3', workflowId: 'wf-3' },
        ],
      });

      // All steps have no dependencies, so all are available
      const available = orchestrationService.getNextAvailableSteps(pipeline.id);
      expect(available).toHaveLength(3);
    });

    it('returns empty array for unknown pipeline', () => {
      expect(orchestrationService.getNextAvailableSteps('nonexistent')).toEqual([]);
    });

    it('returns empty array when all steps are done', () => {
      const pipeline = orchestrationService.createPipeline({
        teamId: 'team-1',
        documentId: 'doc-1',
        name: 'Simple',
        steps: [{ name: 'S1', workflowId: 'wf-1' }],
      });

      orchestrationService.claimStep(pipeline.id, pipeline.steps[0].id, 'session-1');
      orchestrationService.completeStep(pipeline.id, pipeline.steps[0].id, 'session-1');

      expect(orchestrationService.getNextAvailableSteps(pipeline.id)).toEqual([]);
    });
  });
});
