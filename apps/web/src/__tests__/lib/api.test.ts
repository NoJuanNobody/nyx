import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setAuthToken, fetchDocuments, inviteTeamMember } from '../../lib/api.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

describe('API Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuthToken(null);
  });

  it('request attaches Bearer token header when authToken is set', async () => {
    setAuthToken('my-jwt');
    mockFetch.mockResolvedValueOnce(mockResponse([]));

    await fetchDocuments('team-1');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/documents'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-jwt',
        }),
      }),
    );
  });

  it('request omits Content-Type when no body', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([]));

    await fetchDocuments('team-1');

    const callHeaders = mockFetch.mock.calls[0][1].headers;
    expect(callHeaders['Content-Type']).toBeUndefined();
  });

  it('request throws with error message on non-OK response', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: 'Not found' }, false, 404));

    await expect(fetchDocuments('team-1')).rejects.toThrow('Not found');
  });

  it('fetchDocuments calls correct URL with teamId', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([]));

    await fetchDocuments('team-abc');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/documents?teamId=team-abc',
      expect.any(Object),
    );
  });

  it('inviteTeamMember sends email and role in body', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ id: 'inv-1' }));

    await inviteTeamMember('team-1', 'new@test.com', 'editor');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/teams/team-1/members',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'new@test.com', role: 'editor' }),
      }),
    );
  });
});
