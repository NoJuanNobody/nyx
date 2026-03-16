import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NyxClient } from '../client.js';

describe('NyxClient', () => {
  const mockConfig = {
    apiKey: 'test-key-123',
    apiUrl: 'http://localhost:3001',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('makes GET requests with auth header', async () => {
    const mockResponse = { id: '1', title: 'Test Doc' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );

    const client = new NyxClient(mockConfig);
    const result = await client.get('/api/documents/1');

    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/documents/1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key-123',
        }),
      }),
    );
  });

  it('makes POST requests with body', async () => {
    const mockResponse = { id: '2', title: 'New Doc' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 201 }),
    );

    const client = new NyxClient(mockConfig);
    const result = await client.post('/api/documents', { title: 'New Doc' });

    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/documents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'New Doc' }),
      }),
    );
  });

  it('throws on non-ok responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not found', { status: 404 }),
    );

    const client = new NyxClient(mockConfig);
    await expect(client.get('/api/documents/missing')).rejects.toThrow('API error 404');
  });

  it('makes PUT requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ updated: true }), { status: 200 }),
    );

    const client = new NyxClient(mockConfig);
    await client.put('/api/documents/1', { title: 'Updated' });

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/documents/1',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('makes DELETE requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ archived: true }), { status: 200 }),
    );

    const client = new NyxClient(mockConfig);
    await client.delete('/api/documents/1');

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/documents/1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
