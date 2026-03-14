import { describe, it, expect } from 'vitest';
import { AGENT_TOOLS, getToolDefinitions } from '../../services/agent/tools.js';

describe('Agent Tools', () => {
  it('AGENT_TOOLS has all expected tool definitions', () => {
    expect(Object.keys(AGENT_TOOLS)).toContain('read_document');
    expect(Object.keys(AGENT_TOOLS)).toContain('list_documents');
    expect(Object.keys(AGENT_TOOLS)).toContain('update_document');
    expect(Object.keys(AGENT_TOOLS)).toContain('analyze_spec_quality');
    expect(Object.keys(AGENT_TOOLS)).toContain('detect_drift');
    expect(Object.keys(AGENT_TOOLS)).toContain('get_github_files');
    expect(Object.keys(AGENT_TOOLS)).toContain('create_ticket');
    expect(Object.keys(AGENT_TOOLS)).toContain('search_audit_trail');
  });

  it('each tool has name, description, and input_schema', () => {
    for (const [key, tool] of Object.entries(AGENT_TOOLS)) {
      expect(tool.name).toBe(key);
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
    }
  });

  it('getToolDefinitions returns all tools when no names specified', () => {
    const tools = getToolDefinitions();
    expect(tools.length).toBe(Object.keys(AGENT_TOOLS).length);
  });

  it('getToolDefinitions returns all tools with empty array', () => {
    const tools = getToolDefinitions([]);
    expect(tools.length).toBe(Object.keys(AGENT_TOOLS).length);
  });

  it('getToolDefinitions filters by name', () => {
    const tools = getToolDefinitions(['read_document', 'create_ticket']);
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name)).toContain('read_document');
    expect(tools.map(t => t.name)).toContain('create_ticket');
  });

  it('getToolDefinitions ignores unknown names', () => {
    const tools = getToolDefinitions(['read_document', 'nonexistent_tool']);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('read_document');
  });
});
