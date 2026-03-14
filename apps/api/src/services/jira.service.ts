// Jira integration: project listing, issue creation, status sync

function authHeader(email: string, apiToken: string): string {
  const encoded = Buffer.from(`${email}:${apiToken}`).toString('base64');
  return `Basic ${encoded}`;
}

function baseHeaders(email: string, apiToken: string): Record<string, string> {
  return {
    Authorization: authHeader(email, apiToken),
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

// ── Response types ────────────────────────────────────

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  self: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    status: { name: string };
    issuetype: { name: string };
  };
}

export interface JiraCreateIssueData {
  projectKey: string;
  summary: string;
  description: string;
  issueType?: string;
}

// ── Service ───────────────────────────────────────────

export const jiraService = {
  async listProjects(
    baseUrl: string,
    email: string,
    apiToken: string,
  ): Promise<JiraProject[]> {
    const res = await fetch(`${baseUrl}/rest/api/3/project`, {
      headers: baseHeaders(email, apiToken),
    });

    if (!res.ok) {
      throw new Error(`Jira listProjects failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as JiraProject[];
  },

  async createIssue(
    baseUrl: string,
    email: string,
    apiToken: string,
    data: JiraCreateIssueData,
  ): Promise<JiraIssue> {
    const res = await fetch(`${baseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: baseHeaders(email, apiToken),
      body: JSON.stringify({
        fields: {
          project: { key: data.projectKey },
          summary: data.summary,
          description: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: data.description }],
              },
            ],
          },
          issuetype: { name: data.issueType ?? 'Task' },
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Jira createIssue failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as JiraIssue;
  },

  async searchIssues(
    baseUrl: string,
    email: string,
    apiToken: string,
    projectKey?: string,
  ): Promise<JiraIssue[]> {
    const jql = projectKey ? `project = ${projectKey} ORDER BY updated DESC` : 'ORDER BY updated DESC';
    const res = await fetch(`${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=100`, {
      headers: baseHeaders(email, apiToken),
    });

    if (!res.ok) {
      throw new Error(`Jira searchIssues failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { issues: JiraIssue[] };
    return data.issues;
  },

  async attachFileToIssue(
    baseUrl: string,
    email: string,
    apiToken: string,
    issueKey: string,
    fileBuffer: Buffer,
    filename: string,
  ): Promise<void> {
    const boundary = '----NyxFormBoundary' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    const res = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}/attachments`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'X-Atlassian-Token': 'no-check',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jira API error ${res.status}: ${text}`);
    }
  },

  async getIssue(
    baseUrl: string,
    email: string,
    apiToken: string,
    issueKey: string,
  ): Promise<JiraIssue> {
    const res = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}`, {
      headers: baseHeaders(email, apiToken),
    });

    if (!res.ok) {
      throw new Error(`Jira getIssue failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as JiraIssue;
  },
};
