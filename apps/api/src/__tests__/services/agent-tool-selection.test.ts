import { describe, it, expect } from 'vitest';
import { WORKFLOWS, getWorkflow } from '../../services/agent/workflows.js';
import { AGENT_TOOLS, getToolDefinitions } from '../../services/agent/tools.js';

describe('Agent tool selection (issue #74)', () => {
  describe('workflow tool scoping', () => {
    it('full_spec_review includes create_ticket but not update_document', () => {
      const workflow = getWorkflow('full_spec_review');
      expect(workflow).toBeDefined();
      expect(workflow!.tools).toContain('create_ticket');
      expect(workflow!.tools).not.toContain('update_document');
    });

    it('change_impact_analysis includes create_ticket but not update_document', () => {
      const workflow = getWorkflow('change_impact_analysis');
      expect(workflow).toBeDefined();
      expect(workflow!.tools).toContain('create_ticket');
      expect(workflow!.tools).not.toContain('update_document');
    });

    it('doc_generation includes update_document but not create_ticket', () => {
      const workflow = getWorkflow('doc_generation');
      expect(workflow).toBeDefined();
      expect(workflow!.tools).toContain('update_document');
      expect(workflow!.tools).not.toContain('create_ticket');
    });

    it('codebase_sync_check includes neither update_document nor create_ticket', () => {
      const workflow = getWorkflow('codebase_sync_check');
      expect(workflow).toBeDefined();
      expect(workflow!.tools).not.toContain('update_document');
      expect(workflow!.tools).not.toContain('create_ticket');
    });
  });

  describe('workflow prompts explicitly instruct tool use', () => {
    it('full_spec_review prompt instructs to call create_ticket', () => {
      const workflow = WORKFLOWS.full_spec_review;
      expect(workflow.systemPrompt).toContain('Call `create_ticket`');
      expect(workflow.systemPrompt).toContain('Do not use `update_document`');
    });

    it('change_impact_analysis prompt instructs to call create_ticket', () => {
      const workflow = WORKFLOWS.change_impact_analysis;
      expect(workflow.systemPrompt).toContain('Call `create_ticket`');
      expect(workflow.systemPrompt).toContain('Do not modify document content');
    });
  });

  describe('tool descriptions disambiguate edit vs ticket', () => {
    it('update_document description warns against using it for action items', () => {
      expect(AGENT_TOOLS.update_document.description).toContain('create_ticket');
    });

    it('create_ticket description instructs to call the tool, not summarize', () => {
      expect(AGENT_TOOLS.create_ticket.description).toContain('Do not summarize');
    });
  });

  describe('getToolDefinitions respects allowlist', () => {
    it('returns only specified tools when names are provided', () => {
      const tools = getToolDefinitions(['read_document', 'create_ticket']);
      const names = tools.map((t) => t.name);
      expect(names).toEqual(['read_document', 'create_ticket']);
      expect(names).not.toContain('update_document');
    });

    it('returns all tools when no names are provided', () => {
      const tools = getToolDefinitions();
      expect(tools.length).toBe(Object.keys(AGENT_TOOLS).length);
    });
  });
});
