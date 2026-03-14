import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockFetch } from '../helpers/setup.js';
import { jiraService } from '../../services/jira.service.js';

const BASE_URL = 'https://test.atlassian.net';
const EMAIL = 'user@example.com';
const API_TOKEN = 'jira-api-token';

function expectedAuthHeader() {
  return `Basic ${Buffer.from(`${EMAIL}:${API_TOKEN}`).toString('base64')}`;
}

describe('jiraService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listProjects', () => {
    it('calls fetch with correct URL and auth header', async () => {
      const projects = [
        { id: '1', key: 'PROJ', name: 'Project', self: 'https://test.atlassian.net/rest/api/3/project/1' },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(projects),
      });

      const result = await jiraService.listProjects(BASE_URL, EMAIL, API_TOKEN);

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/rest/api/3/project`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expectedAuthHeader(),
          }),
        }),
      );
      expect(result).toEqual(projects);
    });

    it('throws when API returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      await expect(
        jiraService.listProjects(BASE_URL, EMAIL, API_TOKEN),
      ).rejects.toThrow('Jira listProjects failed: 401 Unauthorized');
    });
  });

  describe('createIssue', () => {
    it('posts to Jira API and returns issue data', async () => {
      const issue = {
        id: '10001',
        key: 'PROJ-1',
        self: 'https://test.atlassian.net/rest/api/3/issue/10001',
        fields: {
          summary: 'Test issue',
          status: { name: 'To Do' },
          issuetype: { name: 'Task' },
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(issue),
      });

      const result = await jiraService.createIssue(BASE_URL, EMAIL, API_TOKEN, {
        projectKey: 'PROJ',
        summary: 'Test issue',
        description: 'A test description',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/rest/api/3/issue`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: expectedAuthHeader(),
            'Content-Type': 'application/json',
          }),
        }),
      );

      // Verify the body contains correct fields
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.fields.project.key).toBe('PROJ');
      expect(body.fields.summary).toBe('Test issue');
      expect(body.fields.issuetype.name).toBe('Task');

      expect(result).toEqual(issue);
    });

    it('uses custom issue type when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: '10002', key: 'PROJ-2' }),
      });

      await jiraService.createIssue(BASE_URL, EMAIL, API_TOKEN, {
        projectKey: 'PROJ',
        summary: 'Bug report',
        description: 'Something broke',
        issueType: 'Bug',
      });

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.fields.issuetype.name).toBe('Bug');
    });

    it('throws when API returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      });

      await expect(
        jiraService.createIssue(BASE_URL, EMAIL, API_TOKEN, {
          projectKey: 'PROJ',
          summary: 'Test',
          description: 'Test',
        }),
      ).rejects.toThrow('Jira createIssue failed: 400 Bad Request');
    });
  });

  describe('searchIssues', () => {
    it('calls search API with project filter', async () => {
      const issues = [
        {
          id: '10001',
          key: 'PROJ-1',
          self: 'https://test.atlassian.net/rest/api/3/issue/10001',
          fields: {
            summary: 'Test issue',
            status: { name: 'To Do' },
            issuetype: { name: 'Task' },
          },
        },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ issues }),
      });

      const result = await jiraService.searchIssues(BASE_URL, EMAIL, API_TOKEN, 'PROJ');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`${BASE_URL}/rest/api/3/search?jql=`),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expectedAuthHeader(),
          }),
        }),
      );

      // Verify the JQL includes the project key
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(encodeURIComponent('project = PROJ'));

      expect(result).toEqual(issues);
    });

    it('calls search API without project filter when not provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ issues: [] }),
      });

      await jiraService.searchIssues(BASE_URL, EMAIL, API_TOKEN);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(encodeURIComponent('ORDER BY updated DESC'));
      expect(url).not.toContain('project');
    });

    it('throws when API returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(
        jiraService.searchIssues(BASE_URL, EMAIL, API_TOKEN, 'PROJ'),
      ).rejects.toThrow('Jira searchIssues failed: 500 Internal Server Error');
    });
  });

  describe('getIssue', () => {
    it('fetches a single issue by key', async () => {
      const issue = {
        id: '10001',
        key: 'PROJ-1',
        self: 'https://test.atlassian.net/rest/api/3/issue/10001',
        fields: {
          summary: 'Test issue',
          status: { name: 'Done' },
          issuetype: { name: 'Task' },
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(issue),
      });

      const result = await jiraService.getIssue(BASE_URL, EMAIL, API_TOKEN, 'PROJ-1');

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/rest/api/3/issue/PROJ-1`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expectedAuthHeader(),
          }),
        }),
      );
      expect(result).toEqual(issue);
    });

    it('throws when issue is not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(
        jiraService.getIssue(BASE_URL, EMAIL, API_TOKEN, 'PROJ-999'),
      ).rejects.toThrow('Jira getIssue failed: 404 Not Found');
    });
  });
});
