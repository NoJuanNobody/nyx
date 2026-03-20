import { describe, it, expect, vi } from 'vitest';

vi.mock('../auth.js', () => ({
  apiRequest: vi.fn().mockResolvedValue([]),
}));

vi.mock('../search/search.service.js', () => ({
  performWebSearch: vi.fn(),
}));

describe('createMcpServer', () => {
  it('returns a server instance', async () => {
    const { createMcpServer } = await import('../server.js');
    const server = createMcpServer();
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });
});
