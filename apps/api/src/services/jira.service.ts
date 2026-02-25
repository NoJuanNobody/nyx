// Jira integration: project listing, issue creation, status sync
// TODO: implement with Jira REST API

export const jiraService = {
  async listProjects(accessToken: string) {
    return [];
  },

  async createIssue(projectKey: string, title: string, description: string) {
    return null;
  },

  async syncStatus(issueKey: string) {
    return null;
  },
};
