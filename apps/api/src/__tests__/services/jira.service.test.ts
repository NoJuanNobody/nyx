import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockFetch } from '../helpers/setup.js';
import { jiraService } from '../../services/jira.service.js';

const BASE_URL = 'https://mycompany.atlassian.net';
const EMAIL = 'user@example.com';
const TOKEN = 'jira-api-token';

function expectedAuthHeader() {
  const encoded = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
  return `Basic ${encoded}`;
}

function makeJiraProject(overrides?: Record<string, unknown>) {
  return {
    id: 'proj-1',
    key: 'PROJ',
    name: 'Test Project',
    self: `${BASE_URL}/rest/api/3/project/PROJ`,
    ...overrides,
  };
}

function makeJiraIssue(overrides?: Record<string, unknown>) {
  return {
    id: 'issue-1',
    key: 'PROJ-1',
    self: `${BASE_URL}/rest/api/3/issue/PROJ-1`,
    fields: {
      summary: 'Test Issue',
      status: { name: 'To Do' },
      issuetype: { name: 'Task' },
    },
    ...overrides,
  };
}

function mockFetchResponse(data: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? 'OK' : 'Bad Request',
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue('Error text'),
  };
}

describe('Jira Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listProjects', () => {
    it('returns list of projects', async () => {
      const projects = [makeJiraProject(), makeJiraProject({ key: 'PROJ2', id: 'proj-2' })];
      mockFetch.mockResolvedValueOnce(mockFetchResponse(projects));

      const result = await jiraService.listProjects(BASE_URL, EMAIL, TOKEN);

      expect(result).toHaveLength(2);
      expect(result[0].key).toBe('PROJ');
    });

    it('uses correct Basic auth header', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse([]));

      await jiraService.listProjects(BASE_URL, EMAIL, TOKEN);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/rest/api/3/project');
      expect(options.headers.Authorization).toBe(expectedAuthHeader());
    });

    it('throws on non-200 response', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse(null, false));

      await expect(jiraService.listProjects(BASE_URL, EMAIL, TOKEN)).rejects.toThrow(
        'Jira listProjects failed',
      );
    });
  });

  describe('createIssue', () => {
    it('creates issue and returns it', async () => {
      const issue = makeJiraIssue();
      mockFetch.mockResolvedValueOnce(mockFetchResponse(issue));

      const result = await jiraService.createIssue(BASE_URL, EMAIL, TOKEN, {
        projectKey: 'PROJ',
        summary: 'Test Issue',
        description: 'Some description',
      });

      expect(result.key).toBe('PROJ-1');
    });

    it('sends POST with correct JSON body', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse(makeJiraIssue()));

      await jiraService.createIssue(BASE_URL, EMAIL, TOKEN, {
        projectKey: 'PROJ',
        summary: 'My Issue',
        description: 'Desc',
        issueType: 'Bug',
      });

      const [url, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe('POST');
      expect(url).toContain('/rest/api/3/issue');

      const body = JSON.parse(options.body);
      expect(body.fields.project.key).toBe('PROJ');
      expect(body.fields.summary).toBe('My Issue');
      expect(body.fields.issuetype.name).toBe('Bug');
    });

    it('defaults issueType to Task when not specified', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse(makeJiraIssue()));

      await jiraService.createIssue(BASE_URL, EMAIL, TOKEN, {
        projectKey: 'PROJ',
        summary: 'Task Issue',
        description: 'Desc',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.fields.issuetype.name).toBe('Task');
    });

    it('throws on error response', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse(null, false));

      await expect(
        jiraService.createIssue(BASE_URL, EMAIL, TOKEN, {
          projectKey: 'PROJ',
          summary: 'Issue',
          description: 'Desc',
        }),
      ).rejects.toThrow('Jira createIssue failed');
    });
  });

  describe('searchIssues', () => {
    it('returns list of issues', async () => {
      const issues = [makeJiraIssue()];
      mockFetch.mockResolvedValueOnce(mockFetchResponse({ issues }));

      const result = await jiraService.searchIssues(BASE_URL, EMAIL, TOKEN);

      expect(result).toHaveLength(1);
    });

    it('includes project filter in JQL when projectKey provided', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse({ issues: [] }));

      await jiraService.searchIssues(BASE_URL, EMAIL, TOKEN, 'PROJ');

      const [url] = mockFetch.mock.calls[0];
      expect(decodeURIComponent(url)).toContain('project = PROJ');
    });

    it('throws on error', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse(null, false));

      await expect(jiraService.searchIssues(BASE_URL, EMAIL, TOKEN)).rejects.toThrow(
        'Jira searchIssues failed',
      );
    });
  });

  describe('getIssue', () => {
    it('returns single issue', async () => {
      const issue = makeJiraIssue({ key: 'PROJ-42' });
      mockFetch.mockResolvedValueOnce(mockFetchResponse(issue));

      const result = await jiraService.getIssue(BASE_URL, EMAIL, TOKEN, 'PROJ-42');

      expect(result.key).toBe('PROJ-42');
    });

    it('calls correct URL', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse(makeJiraIssue()));

      await jiraService.getIssue(BASE_URL, EMAIL, TOKEN, 'PROJ-5');

      expect(mockFetch.mock.calls[0][0]).toContain('/rest/api/3/issue/PROJ-5');
    });

    it('throws on not found', async () => {
      mockFetch.mockResolvedValueOnce(mockFetchResponse(null, false));

      await expect(jiraService.getIssue(BASE_URL, EMAIL, TOKEN, 'PROJ-999')).rejects.toThrow(
        'Jira getIssue failed',
      );
    });
  });

  describe('attachFileToIssue', () => {
    it('uploads file attachment', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn() });

      await expect(
        jiraService.attachFileToIssue(
          BASE_URL,
          EMAIL,
          TOKEN,
          'PROJ-1',
          Buffer.from('file content'),
          'doc.pdf',
        ),
      ).resolves.toBeUndefined();

      expect(mockFetch).toHaveBeenCalled();
    });

    it('sends multipart content-type header', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn() });

      await jiraService.attachFileToIssue(
        BASE_URL,
        EMAIL,
        TOKEN,
        'PROJ-1',
        Buffer.from('data'),
        'file.pdf',
      );

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Content-Type']).toMatch(/multipart\/form-data/);
      expect(options.headers['X-Atlassian-Token']).toBe('no-check');
    });

    it('throws on upload error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: vi.fn().mockResolvedValue('Forbidden'),
      });

      await expect(
        jiraService.attachFileToIssue(
          BASE_URL,
          EMAIL,
          TOKEN,
          'PROJ-1',
          Buffer.from('data'),
          'file.pdf',
        ),
      ).rejects.toThrow('Jira API error');
    });
  });
});
