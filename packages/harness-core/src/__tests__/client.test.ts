import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NyxClient } from '../client.js';

describe('NyxClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  describe('constructor', () => {
    it('throws if no apiKey is provided and NYX_API_KEY is unset', () => {
      delete process.env.NYX_API_KEY;
      expect(() => new NyxClient()).toThrow(
        'NyxClient: apiKey is required',
      );
    });

    it('accepts apiKey via config object', () => {
      expect(() => new NyxClient({ apiKey: 'test-key' })).not.toThrow();
    });

    it('reads apiKey from NYX_API_KEY env var', () => {
      process.env.NYX_API_KEY = 'env-key';
      expect(() => new NyxClient()).not.toThrow();
    });

    it('uses default apiUrl when not provided', () => {
      const client = new NyxClient({ apiKey: 'test-key' });
      expect(client.apiUrl).toBe('https://nyx-api.up.railway.app');
    });

    it('accepts custom apiUrl via config', () => {
      const client = new NyxClient({ apiKey: 'test-key', apiUrl: 'http://localhost:3001' });
      expect(client.apiUrl).toBe('http://localhost:3001');
    });

    it('reads apiUrl from NYX_API_URL env var', () => {
      process.env.NYX_API_KEY = 'key';
      process.env.NYX_API_URL = 'http://custom-api.example.com';
      const client = new NyxClient();
      expect(client.apiUrl).toBe('http://custom-api.example.com');
    });
  });

  describe('GET request', () => {
    it('sends GET with Authorization header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'team-1' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new NyxClient({ apiKey: 'sk-test', apiUrl: 'http://api.test' });
      const result = await client.get<{ id: string }>('/api/teams');

      expect(mockFetch).toHaveBeenCalledWith('http://api.test/api/teams', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk-test',
        },
        body: undefined,
      });
      expect(result).toEqual({ id: 'team-1' });
    });

    it('throws on non-OK response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('Invalid API key'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new NyxClient({ apiKey: 'bad-key', apiUrl: 'http://api.test' });
      await expect(client.get('/api/teams')).rejects.toThrow('401');
    });
  });

  describe('POST request', () => {
    it('sends POST with JSON body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'doc-1' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new NyxClient({ apiKey: 'sk-test', apiUrl: 'http://api.test' });
      const body = { title: 'My Doc', content: '# Hello' };
      await client.post('/api/documents', body);

      expect(mockFetch).toHaveBeenCalledWith('http://api.test/api/documents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk-test',
        },
        body: JSON.stringify(body),
      });
    });
  });

  describe('DELETE request', () => {
    it('sends DELETE without body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new NyxClient({ apiKey: 'sk-test', apiUrl: 'http://api.test' });
      await client.delete('/api/documents/doc-1');

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(options.method).toBe('DELETE');
      expect(options.body).toBeUndefined();
    });
  });

  describe('getTeamId', () => {
    it('returns the configured teamId', () => {
      const client = new NyxClient({ apiKey: 'key', teamId: 'team-abc' });
      expect(client.getTeamId()).toBe('team-abc');
    });

    it('returns empty string when no teamId configured', () => {
      delete process.env.NYX_TEAM_ID;
      const client = new NyxClient({ apiKey: 'key' });
      expect(client.getTeamId()).toBe('');
    });
  });
});
