import type { FastifyPluginAsync } from 'fastify';
import { verifyToken } from '@clerk/backend';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { pubSub } from '../services/pubsub.service.js';
import { config } from '../lib/config.js';

const DEV_USER_ID = '00000000-0000-0000-0000-000000000000';

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * WebSocket route at `/api/ws`.
 *
 * Authentication is handled via a `token` query parameter because browsers'
 * native WebSocket API does not support custom headers. The token is the same
 * Clerk session JWT used in `Authorization: Bearer <token>`.
 *
 * In dev-bypass mode (no CLERK_SECRET_KEY and NODE_ENV=development) the
 * connection is accepted without a token.
 */
export const wsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { websocket: true }, async (socket, request) => {
    const query = request.query as { token?: string };

    // ── Authenticate ──────────────────────────────────────
    let userId: string;

    const isDevBypass =
      config.NODE_ENV === 'development' &&
      (!config.CLERK_SECRET_KEY || config.DEV_AUTH_BYPASS === 'true');

    if (isDevBypass) {
      userId = DEV_USER_ID;
    } else {
      if (!query.token) {
        socket.send(JSON.stringify({ error: 'Missing token query parameter' }));
        socket.close(4001, 'Unauthorized');
        return;
      }

      if (!config.CLERK_SECRET_KEY) {
        socket.send(JSON.stringify({ error: 'Auth not configured' }));
        socket.close(4500, 'Server error');
        return;
      }

      try {
        const { sub: clerkUserId } = await verifyToken(query.token, {
          secretKey: config.CLERK_SECRET_KEY,
        });

        if (!clerkUserId) {
          socket.send(JSON.stringify({ error: 'Invalid token' }));
          socket.close(4001, 'Unauthorized');
          return;
        }

        // Resolve internal user ID from Clerk ID
        const [user] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.clerkId, clerkUserId))
          .limit(1);

        if (!user) {
          socket.send(JSON.stringify({ error: 'User not found' }));
          socket.close(4001, 'Unauthorized');
          return;
        }

        userId = user.id;
      } catch {
        socket.send(JSON.stringify({ error: 'Token verification failed' }));
        socket.close(4001, 'Unauthorized');
        return;
      }
    }

    // ── Subscribe to pub/sub ──────────────────────────────
    pubSub.subscribe(userId, socket);

    // Send a welcome message so the client knows the connection is ready
    socket.send(JSON.stringify({ type: 'connected', userId }));

    // ── Heartbeat (keep-alive) ────────────────────────────
    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);

    socket.on('close', () => {
      clearInterval(heartbeat);
    });

    // ── Handle incoming messages (future use) ─────────────
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const msg = JSON.parse(String(raw));
        // Currently only support a 'ping' message for client-side keep-alive
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // Ignore malformed messages
      }
    });
  });
};
