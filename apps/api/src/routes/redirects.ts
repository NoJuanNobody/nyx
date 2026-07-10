import type { FastifyPluginAsync } from 'fastify';

/**
 * First-party ad click tracker.
 *
 * Ad destination URLs point at `/go/<slug>` instead of the landing page
 * directly. Each hit is logged (a raw click — captured even if the visitor
 * bounces before any GA JS loads) and then 302-redirected to the real landing
 * page with UTM params attached, so both our own logs and GA4 attribute the
 * click to the right channel.
 *
 * Count clicks from Railway logs, e.g.:
 *   railway logs | grep '"event":"ad_click"'
 *   railway logs | grep 'ad_click kb'
 */

interface LinkConfig {
  url: string;
  source: string;
  medium: string;
  campaign: string;
}

const LANDING = 'https://nyx-creative.com/';

// slug → destination. Add new slugs here for future channels/campaigns.
const LINKS: Record<string, LinkConfig> = {
  kb: { url: LANDING, source: 'kickbacks', medium: 'statusline', campaign: 'kb_v1' },
};

export const redirectRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { slug: string }; Querystring: { s?: string } }>(
    '/:slug',
    async (request, reply) => {
      const link = LINKS[request.params.slug];

      // Unknown slug → send to the homepage rather than lose the visitor.
      if (!link) {
        reply.header('location', LANDING);
        return reply.code(302).send();
      }

      // Optional ?s= overrides the medium (e.g. terminal vs extension surface).
      const medium = request.query.s?.trim() || link.medium;

      // First-party raw-click log — greppable in Railway; counts bounces GA misses.
      request.log.info(
        {
          event: 'ad_click',
          slug: request.params.slug,
          source: link.source,
          medium,
          campaign: link.campaign,
          referer: request.headers.referer ?? null,
          ua: request.headers['user-agent'] ?? null,
          ip: request.ip,
        },
        `ad_click ${request.params.slug}`,
      );

      const dest = new URL(link.url);
      dest.searchParams.set('utm_source', link.source);
      dest.searchParams.set('utm_medium', medium);
      dest.searchParams.set('utm_campaign', link.campaign);

      reply.header('location', dest.toString());
      return reply.code(302).send();
    },
  );
};
