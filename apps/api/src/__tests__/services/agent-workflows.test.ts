import { describe, it, expect } from 'vitest';
import { getWorkflow, listWorkflows } from '../../services/agent/workflows.js';

describe('Agent Workflows', () => {
  it('listWorkflows returns all defined workflows', () => {
    const workflows = listWorkflows();
    expect(workflows.length).toBeGreaterThanOrEqual(4);
    expect(workflows.map(w => w.id)).toContain('full_spec_review');
    expect(workflows.map(w => w.id)).toContain('change_impact_analysis');
    expect(workflows.map(w => w.id)).toContain('codebase_sync_check');
    expect(workflows.map(w => w.id)).toContain('doc_generation');
  });

  it('getWorkflow returns a specific workflow', () => {
    const workflow = getWorkflow('full_spec_review');
    expect(workflow).toBeDefined();
    expect(workflow!.name).toBe('Full Spec Review');
    expect(workflow!.tools).toContain('read_document');
  });

  it('getWorkflow returns undefined for unknown workflow', () => {
    const workflow = getWorkflow('nonexistent');
    expect(workflow).toBeUndefined();
  });

  it('each workflow has required fields', () => {
    const workflows = listWorkflows();
    for (const wf of workflows) {
      expect(wf.id).toBeTruthy();
      expect(wf.name).toBeTruthy();
      expect(wf.description).toBeTruthy();
      expect(wf.systemPrompt).toBeTruthy();
      expect(Array.isArray(wf.tools)).toBe(true);
    }
  });
});
