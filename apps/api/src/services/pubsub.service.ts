import type { WebSocket } from 'ws';

export interface PubSubMessage {
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Lightweight in-memory pub/sub for pushing real-time events over WebSocket.
 *
 * Services call `pubSub.publish(userId, message)` to broadcast; the WS route
 * subscribes each authenticated connection via `pubSub.subscribe(userId, ws)`.
 */
class PubSubService {
  /** userId -> set of connected WebSocket clients */
  private subscribers = new Map<string, Set<WebSocket>>();

  subscribe(userId: string, ws: WebSocket): void {
    let sockets = this.subscribers.get(userId);
    if (!sockets) {
      sockets = new Set();
      this.subscribers.set(userId, sockets);
    }
    sockets.add(ws);

    ws.on('close', () => {
      sockets!.delete(ws);
      if (sockets!.size === 0) {
        this.subscribers.delete(userId);
      }
    });
  }

  publish(userId: string, message: PubSubMessage): void {
    const sockets = this.subscribers.get(userId);
    if (!sockets) return;

    const data = JSON.stringify(message);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  /** Broadcast the same message to multiple users at once. */
  publishToMany(userIds: string[], message: PubSubMessage): void {
    for (const userId of userIds) {
      this.publish(userId, message);
    }
  }

  /** Return the number of active connections for a user (useful for health checks). */
  connectionCount(userId: string): number {
    return this.subscribers.get(userId)?.size ?? 0;
  }
}

export const pubSub = new PubSubService();
