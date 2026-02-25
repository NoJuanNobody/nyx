import type { FastifyPluginAsync } from 'fastify';

export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => {
    // TODO: list documents
    return [];
  });

  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    // TODO: get document by id
    return { id };
  });

  app.post('/', async (request) => {
    // TODO: create document
    return { message: 'not implemented' };
  });

  app.put('/:id', async (request) => {
    const { id } = request.params as { id: string };
    // TODO: update document
    return { id, message: 'not implemented' };
  });

  app.delete('/:id', async (request) => {
    const { id } = request.params as { id: string };
    // TODO: delete document
    return { id, message: 'not implemented' };
  });
};
