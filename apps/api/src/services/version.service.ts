// Document version management
// TODO: implement with Drizzle queries

export const versionService = {
  async listByDocument(documentId: string) {
    return [];
  },

  async create(data: {
    documentId: string;
    content: string;
    message?: string;
    createdById: string;
  }) {
    return null;
  },

  async diff(versionIdA: string, versionIdB: string) {
    return null;
  },
};
