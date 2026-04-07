import { describe, it, expect } from 'vitest';
import { WORKFLOWS, getWorkflow } from '../../services/agent/workflows.js';
import { AGENT_TOOLS, getToolDefinitions } from '../../services/agent/tools.js';

describe('Agent tool selection (issue #74)', () => {
  describe('workflow tool scoping', () => {
    it('all workflows include both create_ticket and update_document', () => {
      for (const [id, workflow] of Object.entries(WORKFLOWS)) {
        expect(workflow.tools, `${id} should include create_ticket`).toContain('create_ticket');
        expect(workflow.tools, `${id} should include update_document`).toContain('update_document');
      }
    });

    it('all workflows include core tools', () => {
      const coreTools = ['read_document', 'web_search'];
      for (const [id, workflow] of Object.entries(WORKFLOWS)) {
        for (const tool of coreTools) {
          expect(workflow.tools, `${id} should include ${tool}`).toContain(tool);
        }
      }
    });

    it('every defined tool is in at least one workflow', () => {
      const allToolNames = Object.keys(AGENT_TOOLS);
      const toolsInWorkflows = new Set(
        Object.values(WORKFLOWS).flatMap((w) => w.tools),
      );
      for (const tool of allToolNames) {
        expect(toolsInWorkflows, `${tool} should be in at least one workflow`).toContain(tool);
      }
    });
  });

  describe('workflow prompts explicitly instruct tool use', () => {
    it('full_spec_review prompt instructs to call create_ticket', () => {
      const workflow = WORKFLOWS.full_spec_review;
      expect(workflow.systemPrompt).toContain('call `create_ticket`');
    });

    it('change_impact_analysis prompt instructs to call create_ticket', () => {
      const workflow = WORKFLOWS.change_impact_analysis;
      expect(workflow.systemPrompt).toContain('call `create_ticket`');
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

    it('returns default tool subset when no names are provided', () => {
      const tools = getToolDefinitions();
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.length).toBeLessThan(Object.keys(AGENT_TOOLS).length);
    });
  });
});
