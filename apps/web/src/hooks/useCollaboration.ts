/**
 * useCollaboration — Yjs CRDT + WebSocket real-time collaboration hook.
 *
 * Maintains a Y.Doc synced with the server and all connected peers.
 * Exposes `yjsContent` (updated only on remote changes) and `applyLocalEdit`
 * (applies the user's edit to Y.Text via character-level diffing).
 *
 * IndexedDB persistence via y-indexeddb provides offline support:
 * edits made while disconnected are applied to the local Y.Doc and sent
 * to the server on reconnect.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { resolveToken } from '../lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Collaborator {
  userId: string;
  name: string;
  color: string;
}

type CollabMessage =
  | { type: 'connected'; ydocState: string }
  | { type: 'sync'; update: string }
  | { type: 'awareness'; state: Collaborator & { disconnected?: boolean } };

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Marker so Yjs update observers can skip locally-originated changes. */
const LOCAL_ORIGIN = Symbol('local-edit');

/**
 * Apply a string diff to a Y.Text using the minimal delete+insert pair,
 * tagged with LOCAL_ORIGIN so the observer doesn't echo the change back.
 */
function applyDiff(ytext: Y.Text, newContent: string): void {
  const doc = ytext.doc;
  if (!doc) return;
  const old = ytext.toString();
  if (old === newContent) return;

  // Common prefix
  let start = 0;
  while (start < old.length && start < newContent.length && old[start] === newContent[start]) {
    start++;
  }
  // Common suffix
  let oldEnd = old.length;
  let newEnd = newContent.length;
  while (oldEnd > start && newEnd > start && old[oldEnd - 1] === newContent[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  doc.transact(() => {
    if (oldEnd > start) ytext.delete(start, oldEnd - start);
    if (newEnd > start) ytext.insert(start, newContent.slice(start, newEnd));
  }, LOCAL_ORIGIN);
}

/** Deterministic pastel colour from a user ID string. */
function userColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  const palette = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'];
  return palette[Math.abs(hash) % palette.length];
}

function encodeUpdate(update: Uint8Array): string {
  return btoa(String.fromCharCode(...update));
}

function decodeUpdate(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ── Hook ──────────────────────────────────────────────────────────────────────

interface UseCollaborationOptions {
  documentId: string | undefined;
  userId: string;
  userName: string;
  /** Initial content from the REST API, used to seed an empty Yjs doc. */
  initialContent: string;
}

interface UseCollaborationResult {
  /** Collaborators currently connected (excludes the local user). */
  collaborators: Collaborator[];
  /** Whether the WebSocket is open. */
  connected: boolean;
  /**
   * Latest content from Y.Text, updated only on REMOTE changes.
   * `null` until the Yjs doc has been initialised.
   */
  yjsContent: string | null;
  /**
   * Apply a local edit to Y.Text (call this from the editor onChange handler).
   * Uses character-level diffing — does NOT re-render the calling component.
   */
  applyLocalEdit: (newContent: string) => void;
}

export function useCollaboration({
  documentId,
  userId,
  userName,
  initialContent,
}: UseCollaborationOptions): UseCollaborationResult {
  const ydocRef = useRef<Y.Doc | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [connected, setConnected] = useState(false);
  const [yjsContent, setYjsContent] = useState<string | null>(null);

  // Track awareness from peers (keyed by userId)
  const awarenessRef = useRef<Map<string, Collaborator>>(new Map());
  // True once we've initialised the Y.Doc content (either from server or IndexedDB)
  const initialisedRef = useRef(false);

  useEffect(() => {
    if (!documentId || !userId) return;

    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    const ytext = ydoc.getText('content');

    // ── IndexedDB persistence (offline edits survive page reloads) ────────
    const persistence = new IndexeddbPersistence(`syncdocs-${documentId}`, ydoc);

    persistence.on('synced', () => {
      // If the server hasn't responded yet, seed UI from local cache
      if (!initialisedRef.current) {
        const cached = ytext.toString();
        if (cached) {
          initialisedRef.current = true;
          setYjsContent(cached);
        }
      }
    });

    // ── Observe Y.Text — only propagate REMOTE changes to React state ─────
    ytext.observe((event) => {
      if (event.transaction.origin === LOCAL_ORIGIN) return;
      setYjsContent(ytext.toString());
    });

    // ── WebSocket ─────────────────────────────────────────────────────────
    let ws: WebSocket;

    const connect = async () => {
      const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';
      const wsBase = apiUrl.replace(/^http/, 'ws');
      const token = await resolveToken();
      const url = token
        ? `${wsBase}/api/collaboration/${documentId}?token=${encodeURIComponent(token)}`
        : `${wsBase}/api/collaboration/${documentId}`;

      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        // Announce presence
        ws.send(
          JSON.stringify({
            type: 'awareness',
            state: { userId, name: userName, color: userColor(userId) },
          } as CollabMessage),
        );
      };

      ws.onclose = () => setConnected(false);
      ws.onerror = () => setConnected(false);

      ws.onmessage = (event: MessageEvent<string>) => {
        try {
          const msg = JSON.parse(event.data) as CollabMessage;

          if (msg.type === 'connected') {
            // Apply the server's current document state
            const update = decodeUpdate(msg.ydocState);
            Y.applyUpdate(ydoc, update, 'remote');

            if (!initialisedRef.current) {
              initialisedRef.current = true;
              const serverContent = ytext.toString();
              if (serverContent) {
                setYjsContent(serverContent);
              } else if (initialContent) {
                // Empty server doc — seed with the REST-loaded content
                ydoc.transact(() => {
                  ytext.insert(0, initialContent);
                }, LOCAL_ORIGIN);
                setYjsContent(initialContent);
              }
            }

            // Send any local updates the server might have missed (offline edits)
            const stateVector = Y.encodeStateVectorFromUpdate(update);
            const localUpdates = Y.encodeStateAsUpdate(ydoc, stateVector);
            if (localUpdates.length > 2) {
              ws.send(JSON.stringify({ type: 'sync', update: encodeUpdate(localUpdates) } as CollabMessage));
            }
          } else if (msg.type === 'sync') {
            const update = decodeUpdate(msg.update);
            Y.applyUpdate(ydoc, update, 'remote');
          } else if (msg.type === 'awareness') {
            const { userId: uid, disconnected, ...rest } = msg.state;
            if (uid === userId) return; // ignore echoes of own presence
            if (disconnected) {
              awarenessRef.current.delete(uid);
            } else {
              awarenessRef.current.set(uid, { userId: uid, ...rest });
            }
            setCollaborators([...awarenessRef.current.values()]);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      // ── Forward local Yjs updates to the server ───────────────────────
      ydoc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === 'remote' || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'sync', update: encodeUpdate(update) } as CollabMessage));
      });
    };

    connect();

    return () => {
      ws?.close();
      persistence.destroy();
      ydoc.destroy();
      ydocRef.current = null;
      wsRef.current = null;
      initialisedRef.current = false;
      setConnected(false);
      setYjsContent(null);
      setCollaborators([]);
      awarenessRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, userId]);

  const applyLocalEdit = useCallback((newContent: string) => {
    const ydoc = ydocRef.current;
    if (!ydoc) return;
    applyDiff(ydoc.getText('content'), newContent);
  }, []);

  return { collaborators, connected, yjsContent, applyLocalEdit };
}
