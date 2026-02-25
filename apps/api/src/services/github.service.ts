// GitHub integration: repo scanning, webhook handling, issue creation
// TODO: implement with GitHub API

export const githubService = {
  async listRepos(accessToken: string) {
    return [];
  },

  async getFileTree(owner: string, repo: string, ref: string) {
    return [];
  },

  async createIssue(owner: string, repo: string, title: string, body: string) {
    return null;
  },

  async handleWebhook(event: string, payload: unknown) {
    // TODO: process push events for drift detection
  },
};
