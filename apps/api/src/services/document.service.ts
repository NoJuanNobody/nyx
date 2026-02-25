// Document CRUD and search operations
// TODO: implement with Drizzle queries

export const documentService = {
  async list(teamId: string) {
    return [];
  },

  async getById(id: string) {
    return null;
  },

  async create(data: { title: string; content: string; teamId: string; createdById: string }) {
    return null;
  },

  async update(id: string, data: { title?: string; content?: string; status?: string }) {
    return null;
  },

  async delete(id: string) {
    return null;
  },
};
