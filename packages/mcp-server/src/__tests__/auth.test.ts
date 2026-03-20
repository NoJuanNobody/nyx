import { describe, it, expect, vi, beforeEach } from 'vitest';

// Reset module state between tests
beforeEach(() => {
  vi.resetModules();
});

describe('configure and getConfig', () => {
  it('throws when not configured', async () => {
    const { getConfig } = await import('../auth.js');
    expect(() => getConfig()).toThrow('MCP server not configured');
  });

  it('returns config after configure is called', async () => {
    const { configure, getConfig } = await import('../auth.js');
    configure({ apiKey: 'test-key', baseUrl: 'http://localhost:3001' });
    const config = getConfig();
    expect(config.apiKey).toBe('test-key');
    expect(config.baseUrl).toBe('http://localhost:3001');
  });
});

describe('apiRequest', () => {
  it('makes authenticated requests with correct headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { configure, apiRequest } = await import('../auth.js');
    configure({ apiKey: 'sk_test', baseUrl: 'http://localhost:3001' });

    const result = await apiRequest('/api/teams');

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3001/api/teams', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk_test',
      },
    });
    expect(result).toEqual({ data: 'test' });

    vi.unstubAllGlobals();
  });

  it('throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve('Resource not found'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { configure, apiRequest } = await import('../auth.js');
    configure({ apiKey: 'sk_test', baseUrl: 'http://localhost:3001' });

    await expect(apiRequest('/api/teams/nonexistent')).rejects.toThrow(
      'Nyx API error 404: Resource not found',
    );

    vi.unstubAllGlobals();
  });

  it('merges custom headers with defaults', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { configure, apiRequest } = await import('../auth.js');
    configure({ apiKey: 'sk_test', baseUrl: 'http://localhost:3001' });

    await apiRequest('/api/test', {
      method: 'POST',
      body: '{}',
      headers: { 'X-Custom': 'value' },
    });

    const calledOptions = mockFetch.mock.calls[0][1];
    expect(calledOptions.headers['Authorization']).toBe('Bearer sk_test');
    expect(calledOptions.headers['X-Custom']).toBe('value');
    expect(calledOptions.method).toBe('POST');

    vi.unstubAllGlobals();
  });
});
