import type { FastifyPluginAsync } from 'fastify';
import { exportService, AVAILABLE_LATEX_THEMES, type LatexTheme } from '../services/export.service.js';

export const exportRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/export/documents/:id/export/markdown — download document as markdown
  app.get('/documents/:id/export/markdown', async (request, reply) => {
    const { id } = request.params as { id: string };

    const result = await exportService.toMarkdown(id);
    if (!result) {
      reply.code(404);
      return { error: 'Document not found' };
    }

    const filename = `${result.title.replace(/[^a-zA-Z0-9-_]/g, '_')}.md`;

    reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(result.content);
  });

  // GET /api/export/documents/:id/export/pdf — download document as PDF
  app.get('/documents/:id/export/pdf', async (request, reply) => {
    const { id } = request.params as { id: string };

    const result = await exportService.toPdf(id);
    if (!result) {
      reply.code(404);
      return { error: 'Document not found' };
    }

    const filename = `${result.title.replace(/[^a-zA-Z0-9-_]/g, '_')}.pdf`;

    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(result.buffer);
  });

  // GET /api/export/documents/:id/export/latex/themes — list available themes
  app.get('/documents/:id/export/latex/themes', async (_request, reply) => {
    reply.send({ themes: AVAILABLE_LATEX_THEMES });
  });

  // GET /api/export/documents/:id/export/latex — download document as LaTeX (.tex)
  app.get('/documents/:id/export/latex', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { theme = 'plain' } = request.query as { theme?: string };

    const validThemes = AVAILABLE_LATEX_THEMES.map((t) => t.id);
    const resolvedTheme: LatexTheme = validThemes.includes(theme) ? (theme as LatexTheme) : 'plain';

    const result = await exportService.toLatex(id, resolvedTheme);
    if (!result) {
      reply.code(404);
      return { error: 'Document not found' };
    }

    const slug = result.title.replace(/[^a-zA-Z0-9-_]/g, '_');

    // If the document has citations, return a ZIP containing .tex + .bib
    if (result.bibtex) {
      // Inline both files as a multi-part response is not standard for downloads;
      // we include the BibTeX as a separate section commented in the .tex file
      // and also append a raw .bib block for easy extraction.
      const combined = `${result.tex}\n\n% === references.bib ===\n% Save the block below as references.bib\n%\n${result.bibtex.split('\n').map((l) => `% ${l}`).join('\n')}`;
      reply
        .header('Content-Type', 'application/x-tex; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${slug}.tex"`)
        .send(combined);
    } else {
      reply
        .header('Content-Type', 'application/x-tex; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${slug}.tex"`)
        .send(result.tex);
    }
  });
};
