/**
 * Real-time collaboration WebSocket route.
 *
 * Protocol (JSON over WebSocket):
 *   connected  { type: 'connected'; ydocState: string }       Server → Client (on join)
 *   sync       { type: 'sync'; update: string }               Bidirectional (base64 Yjs update)
 *   awareness  { type: 'awareness'; state: CollaboratorState }Bidirectional (presence)
 *
 * Auth: uses req.user set by the auth middleware (dev bypass or Clerk JWT via ?token= query param).
 * In-memory room store — state is reset on server restart. REST saves keep the DB in sync.
 */
import type { FastifyPluginAsync } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CollaboratorState {
  userId: string;
  name: string;
  color: string;
  disconnected?: boolean;
}

type CollabMessage =
  | { type: 'connected'; ydocState: string }
  | { type: 'sync'; update: string }
  | { type: 'awareness'; state: CollaboratorState };

interface ClientInfo {
  userId: string;
  name: string;
  state: CollaboratorState | null;
}

interface Room {
  ydoc: Y.Doc;
  clients: Map<WebSocket, ClientInfo>;
}

// ── In-memory room store ───────────────────────────────────────────────────────

const rooms = new Map<string, Room>();

function getOrCreateRoom(docId: string): Room {
  let room = rooms.get(docId);
  if (!room) {
    room = { ydoc: new Y.Doc(), clients: new Map() };
    rooms.set(docId, room);
  }
  return room;
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

function encodeUpdate(update: Uint8Array): string {
  return Buffer.from(update).toString('base64');
}

function decodeUpdate(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ── Broadcast to all clients in a room except the sender ─────────────────────

function broadcast(room: Room, exclude: WebSocket, msg: string): void {
  for (const [client] of room.clients) {
    if (client !== exclude && client.readyState === 1 /* OPEN */) {
      client.send(msg);
    }
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const collaborationRoutes: FastifyPluginAsync = async (app) => {
  await app.register(fastifyWebsocket);

  app.get<{
    Params: { documentId: string };
  }>(
    '/:documentId',
    { websocket: true },
    (socket, req) => {
      const user = req.user;
      if (!user?.id) {
        socket.close(1008, 'Unauthorized');
        return;
      }

      const { documentId } = req.params;
      const room = getOrCreateRoom(documentId);
      // @fastify/websocket exposes the raw ws.WebSocket as `socket`
      const ws = socket as unknown as WebSocket;

      room.clients.set(ws, { userId: user.id, name: user.name, state: null });

      // ── Send initial state to the new client ──────────────────────────────
      const currentState = Y.encodeStateAsUpdate(room.ydoc);
      socket.send(
        JSON.stringify({
          type: 'connected',
          ydocState: encodeUpdate(currentState),
        } as CollabMessage),
      );

      // ── Re-broadcast awareness for existing collaborators ─────────────────
      for (const [, info] of room.clients) {
        if (info.userId !== user.id && info.state) {
          socket.send(JSON.stringify({ type: 'awareness', state: info.state } as CollabMessage));
        }
      }

      // ── Handle incoming messages ──────────────────────────────────────────
      socket.on('message', (rawData: Buffer) => {
        try {
          const msg = JSON.parse(rawData.toString()) as CollabMessage;

          if (msg.type === 'sync') {
            // Apply to server-side doc so late joiners get full state
            const update = decodeUpdate(msg.update);
            Y.applyUpdate(room.ydoc, update);
            broadcast(room, ws, JSON.stringify(msg));
          } else if (msg.type === 'awareness') {
            const info = room.clients.get(ws);
            if (info) info.state = msg.state;
            broadcast(room, ws, JSON.stringify(msg));
          }
        } catch (err) {
          app.log.warn({ err }, 'collab: message parse error');
        }
      });

      // ── Handle disconnect ─────────────────────────────────────────────────
      socket.on('close', () => {
        const info = room.clients.get(ws);
        room.clients.delete(ws);

        // Notify others this collaborator left
        if (info?.state) {
          const leaveMsg = JSON.stringify({
            type: 'awareness',
            state: { ...info.state, disconnected: true },
          } as CollabMessage);
          for (const [client] of room.clients) {
            if (client.readyState === 1) client.send(leaveMsg);
          }
        }

        // Reclaim memory for idle rooms
        if (room.clients.size === 0) {
          rooms.delete(documentId);
        }
      });
    },
  );
};
