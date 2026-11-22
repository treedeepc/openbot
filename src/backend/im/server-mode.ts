import type { DatabaseSync } from "node:sqlite";
import { databaseRow, databaseRows } from "../database/database-rows";

export interface ImServerScope {
  localServerId: string;
  localMemberId: string;
}

export interface ImPresencePeer {
  peerServerId: string;
  peerAgentId: string;
}

export const IM_PRESENCE_STATES = ["online", "away", "offline"] as const;
export type ImPresenceState = (typeof IM_PRESENCE_STATES)[number];

export const IM_PRESENCE_THROTTLE_MS = 30_000;

export interface ImPresenceView {
  peerServerId: string;
  peerAgentId: string;
  state: ImPresenceState;
  hidden: boolean;
}

export class ImPeerNotFriend extends Error {
  constructor() {
    super("im.notFriend");
    this.name = "ImPeerNotFriend";
  }
}

function state(value: unknown): ImPresenceState {
  return value === "online" ? "online" : value === "away" ? "away" : "offline";
}

export class ImPresenceStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  update(input: ImPresencePeer & { state: ImPresenceState; hidden: boolean; at: number }): ImPresenceView {
    this.#db
      .prepare(
        `INSERT INTO presence (peer_server_id, peer_agent_id, state, hidden, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(peer_server_id, peer_agent_id) DO UPDATE SET state = excluded.state, hidden = excluded.hidden,
           updated_at = excluded.updated_at`,
      )
      .run(input.peerServerId, input.peerAgentId, input.state, input.hidden ? 1 : 0, input.at);
    return this.#exposed(input.peerServerId, input.peerAgentId, input.at);
  }

  current(peer: ImPresencePeer): ImPresenceView {
    const row = this.#row(peer.peerServerId, peer.peerAgentId);
    const hidden = row ? Number(row.hidden) === 1 : false;
    return {
      peerServerId: peer.peerServerId,
      peerAgentId: peer.peerAgentId,
      state: hidden ? "offline" : row ? state(row.state) : "offline",
      hidden,
    };
  }

  visible(scope: ImServerScope, peer: ImPresencePeer, at = Date.now()): ImPresenceView {
    if (!this.#friend(scope, peer)) throw new ImPeerNotFriend();
    return this.#exposed(peer.peerServerId, peer.peerAgentId, at);
  }

  hide(peer: ImPresencePeer, hidden: boolean, at: number): ImPresenceView {
    const row = this.#row(peer.peerServerId, peer.peerAgentId);
    return this.update({
      ...peer,
      state: row ? state(row.state) : "offline",
      hidden,
      at,
    });
  }

  #exposed(peerServerId: string, peerAgentId: string, at: number): ImPresenceView {
    const row = this.#row(peerServerId, peerAgentId);
    const hidden = row ? Number(row.hidden) === 1 : false;
    const truth: ImPresenceState = hidden ? "offline" : row ? state(row.state) : "offline";
    const exposedAt = row && row.exposed_at !== null && row.exposed_at !== undefined ? Number(row.exposed_at) : null;
    const bucket = Math.floor(at / IM_PRESENCE_THROTTLE_MS);
    const exposedBucket = exposedAt === null ? -1 : Math.floor(exposedAt / IM_PRESENCE_THROTTLE_MS);
    if (bucket > exposedBucket) {
      this.#db
        .prepare(
          "UPDATE presence SET exposed_state = ?, exposed_hidden = ?, exposed_at = ? WHERE peer_server_id = ? AND peer_agent_id = ?",
        )
        .run(truth, hidden ? 1 : 0, at, peerServerId, peerAgentId);
      return { peerServerId, peerAgentId, state: truth, hidden };
    }
    const exposedHidden = row ? Number(row.exposed_hidden ?? 0) === 1 : false;
    return {
      peerServerId,
      peerAgentId,
      state: exposedHidden
        ? "offline"
        : row && row.exposed_state !== null && row.exposed_state !== undefined
          ? state(row.exposed_state)
          : truth,
      hidden: exposedHidden,
    };
  }

  #row(peerServerId: string, peerAgentId: string) {
    return databaseRow(
      this.#db
        .prepare(
          "SELECT state, hidden, updated_at, exposed_state, exposed_hidden, exposed_at FROM presence WHERE peer_server_id = ? AND peer_agent_id = ?",
        )
        .get(peerServerId, peerAgentId),
    );
  }

  #friend(scope: ImServerScope, peer: ImPresencePeer): boolean {
    return (
      this.#db
        .prepare(
          "SELECT 1 FROM contacts WHERE local_server_id = ? AND local_member_id = ? AND peer_server_id = ? AND peer_agent_id = ? AND state = 'accepted'",
        )
        .get(scope.localServerId, scope.localMemberId, peer.peerServerId, peer.peerAgentId) !== undefined
    );
  }
}

export interface ImDirectoryProfile {
  peerServerId: string;
  peerAgentId: string;
  displayName: string;
  bio: string | null;
  avatar: string | null;
}

export interface ImDirectoryPort {
  register?(input: ImPresencePeer & { displayName: string; bio: string | null; avatar: string | null }): void;
  deactivate?(input: ImPresencePeer): void;
}

export class ImDirectoryStore {
  readonly #db: DatabaseSync;
  readonly #port: ImDirectoryPort;

  constructor(db: DatabaseSync, port: ImDirectoryPort = {}) {
    this.#db = db;
    this.#port = port;
  }

  profile(peer: ImPresencePeer): ImDirectoryProfile | null {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT display_name, bio, avatar FROM directory_profiles WHERE peer_server_id = ? AND peer_agent_id = ?",
        )
        .get(peer.peerServerId, peer.peerAgentId),
    );
    if (!row) return null;
    return {
      peerServerId: peer.peerServerId,
      peerAgentId: peer.peerAgentId,
      displayName: String(row.display_name),
      bio: row.bio === null ? null : String(row.bio),
      avatar: row.avatar === null ? null : String(row.avatar),
    };
  }

  register(
    input: ImPresencePeer & { displayName: string; bio: string | null; avatar: string | null; at: number },
  ): void {
    if (!this.#port.register) throw new ImDirectoryPortMissing();
    this.#port.register(input);
    this.#db
      .prepare(
        `INSERT INTO directory_profiles (peer_server_id, peer_agent_id, display_name, bio, avatar, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(peer_server_id, peer_agent_id) DO UPDATE SET display_name = excluded.display_name,
           bio = excluded.bio, avatar = excluded.avatar, updated_at = excluded.updated_at`,
      )
      .run(input.peerServerId, input.peerAgentId, input.displayName, input.bio, input.avatar, input.at);
  }

  deactivate(input: ImPresencePeer): void {
    if (!this.#port.deactivate) throw new ImDirectoryPortMissing();
    this.#port.deactivate(input);
  }
}

export class ImDirectoryPortMissing extends Error {
  constructor() {
    super("im.notRegistered");
    this.name = "ImDirectoryPortMissing";
  }
}

export const IM_OFFLINE_MAX_ITEMS = 500;
export const IM_OFFLINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface ImOfflineItem {
  queueId: string;
  peerServerId: string;
  peerAgentId: string;
  recipientDeviceId: string;
  remoteMessageId: string;
  sealedPayload: Uint8Array;
  seq: number;
  expiresAt: number;
}

export interface ImOfflineDrop {
  dropped: ImOfflineItem[];
  reason: "expired" | "over-limit";
  notifySender: boolean;
}

export class ImOfflineQueue {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  enqueue(
    scope: ImServerScope,
    input: {
      queueId: string;
      peer: ImPresencePeer;
      recipientDeviceId: string;
      remoteMessageId: string;
      sealedPayload: Uint8Array;
      at: number;
    },
  ): { stored: ImOfflineItem; dropped: ImOfflineDrop } {
    const seq = this.#nextSeq(scope);
    this.#db
      .prepare(
        `INSERT INTO offline_queue (local_server_id, local_member_id, queue_id, peer_server_id, peer_agent_id,
          recipient_device_id, remote_message_id, sealed_payload, seq, expires_at, acked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        scope.localServerId,
        scope.localMemberId,
        input.queueId,
        input.peer.peerServerId,
        input.peer.peerAgentId,
        input.recipientDeviceId,
        input.remoteMessageId,
        input.sealedPayload,
        seq,
        input.at + IM_OFFLINE_MAX_AGE_MS,
      );
    const dropped = this.enforceLimits(scope, input.at);
    const stored = this.read(scope, input.queueId);
    if (!stored) throw new ImOfflineQueueEmpty();
    return { stored, dropped };
  }

  enforceLimits(scope: ImServerScope, at: number): ImOfflineDrop {
    const dropped: ImOfflineItem[] = [];
    const expired = databaseRows(
      this.#db
        .prepare(
          "SELECT queue_id FROM offline_queue WHERE local_server_id = ? AND local_member_id = ? AND expires_at <= ? ORDER BY seq",
        )
        .all(scope.localServerId, scope.localMemberId, at),
    );
    for (const row of expired) {
      const item = this.read(scope, String(row.queue_id));
      if (item) dropped.push(item);
      this.#delete(scope, String(row.queue_id));
    }
    let overflow = databaseRows(
      this.#db
        .prepare("SELECT queue_id FROM offline_queue WHERE local_server_id = ? AND local_member_id = ? ORDER BY seq")
        .all(scope.localServerId, scope.localMemberId),
    );
    while (overflow.length > IM_OFFLINE_MAX_ITEMS) {
      const oldest = overflow[0];
      if (!oldest) break;
      const item = this.read(scope, String(oldest.queue_id));
      if (item) dropped.push(item);
      this.#delete(scope, String(oldest.queue_id));
      overflow = overflow.slice(1);
    }
    return {
      dropped,
      reason: expired.length > 0 ? "expired" : "over-limit",
      notifySender: dropped.length > 0,
    };
  }

  read(scope: ImServerScope, queueId: string): ImOfflineItem | null {
    const row = databaseRow(
      this.#db
        .prepare("SELECT * FROM offline_queue WHERE local_server_id = ? AND local_member_id = ? AND queue_id = ?")
        .get(scope.localServerId, scope.localMemberId, queueId),
    );
    if (!row) return null;
    return {
      queueId: String(row.queue_id),
      peerServerId: String(row.peer_server_id),
      peerAgentId: String(row.peer_agent_id),
      recipientDeviceId: String(row.recipient_device_id),
      remoteMessageId: String(row.remote_message_id),
      sealedPayload: bytesColumn(row.sealed_payload),
      seq: Number(row.seq),
      expiresAt: Number(row.expires_at),
    };
  }

  pending(scope: ImServerScope, recipientDeviceId: string): ImOfflineItem[] {
    return databaseRows(
      this.#db
        .prepare(
          `SELECT q.queue_id FROM offline_queue q
           WHERE q.local_server_id = ? AND q.local_member_id = ? AND q.recipient_device_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM offline_targets t
                WHERE t.local_server_id = q.local_server_id AND t.local_member_id = q.local_member_id
                  AND t.peer_server_id = q.peer_server_id AND t.peer_agent_id = q.peer_agent_id
                  AND t.remote_message_id = q.remote_message_id AND t.recipient_device_id = q.recipient_device_id
                  AND t.state = 'excluded'
             )
           ORDER BY q.seq`,
        )
        .all(scope.localServerId, scope.localMemberId, recipientDeviceId),
    )
      .map((row) => this.read(scope, String(row.queue_id)))
      .filter((item): item is ImOfflineItem => item !== null);
  }

  snapshot(
    scope: ImServerScope,
    input: { peer: ImPresencePeer; remoteMessageId: string; recipientDeviceIds: readonly string[]; at: number },
  ): void {
    for (const recipientDeviceId of input.recipientDeviceIds) {
      this.#db
        .prepare(
          `INSERT INTO offline_targets (local_server_id, local_member_id, peer_server_id, peer_agent_id,
            remote_message_id, recipient_device_id, snapshot_at, state, acked_at, excluded_at, audit_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)
           ON CONFLICT(local_server_id, local_member_id, peer_server_id, peer_agent_id, remote_message_id, recipient_device_id)
             DO UPDATE SET snapshot_at = excluded.snapshot_at`,
        )
        .run(
          scope.localServerId,
          scope.localMemberId,
          input.peer.peerServerId,
          input.peer.peerAgentId,
          input.remoteMessageId,
          recipientDeviceId,
          input.at,
        );
    }
  }

  confirm(scope: ImServerScope, input: { queueId: string; at: number }): boolean {
    const item = this.read(scope, input.queueId);
    if (!item) return false;
    if (this.#excluded(scope, item)) return false;
    this.#db
      .prepare(
        "UPDATE offline_queue SET acked_at = ? WHERE local_server_id = ? AND local_member_id = ? AND queue_id = ?",
      )
      .run(input.at, scope.localServerId, scope.localMemberId, input.queueId);
    this.#db
      .prepare(
        `UPDATE offline_targets SET state = 'acked', acked_at = ?
         WHERE local_server_id = ? AND local_member_id = ? AND peer_server_id = ? AND peer_agent_id = ?
           AND remote_message_id = ? AND recipient_device_id = ?`,
      )
      .run(
        input.at,
        scope.localServerId,
        scope.localMemberId,
        item.peerServerId,
        item.peerAgentId,
        item.remoteMessageId,
        item.recipientDeviceId,
      );
    this.#delete(scope, input.queueId);
    return true;
  }

  settled(scope: ImServerScope, input: { peer: ImPresencePeer; remoteMessageId: string }): boolean {
    const row = databaseRow(
      this.#db
        .prepare(
          `SELECT COUNT(*) AS open FROM offline_targets
           WHERE local_server_id = ? AND local_member_id = ? AND peer_server_id = ? AND peer_agent_id = ?
             AND remote_message_id = ? AND state <> 'acked' AND state <> 'excluded'`,
        )
        .get(
          scope.localServerId,
          scope.localMemberId,
          input.peer.peerServerId,
          input.peer.peerAgentId,
          input.remoteMessageId,
        ),
    );
    return Number(row?.open ?? 0) === 0;
  }

  #excluded(scope: ImServerScope, item: ImOfflineItem): boolean {
    const row = databaseRow(
      this.#db
        .prepare(
          `SELECT 1 FROM offline_targets WHERE local_server_id = ? AND local_member_id = ? AND peer_server_id = ?
             AND peer_agent_id = ? AND remote_message_id = ? AND recipient_device_id = ? AND state = 'excluded'`,
        )
        .get(
          scope.localServerId,
          scope.localMemberId,
          item.peerServerId,
          item.peerAgentId,
          item.remoteMessageId,
          item.recipientDeviceId,
        ),
    );
    return row !== null;
  }

  exclude(
    scope: ImServerScope,
    input: {
      peer: ImPresencePeer;
      remoteMessageId: string;
      recipientDeviceId: string;
      at: number;
      auditId?: string | null;
    },
  ): boolean {
    const marked =
      this.#db
        .prepare(
          `UPDATE offline_targets SET state = 'excluded', excluded_at = ?, audit_id = ?
           WHERE local_server_id = ? AND local_member_id = ? AND peer_server_id = ? AND peer_agent_id = ?
             AND remote_message_id = ? AND recipient_device_id = ?`,
        )
        .run(
          input.at,
          input.auditId ?? null,
          scope.localServerId,
          scope.localMemberId,
          input.peer.peerServerId,
          input.peer.peerAgentId,
          input.remoteMessageId,
          input.recipientDeviceId,
        ).changes > 0;
    this.#db
      .prepare(
        `DELETE FROM offline_queue WHERE local_server_id = ? AND local_member_id = ? AND peer_server_id = ?
           AND peer_agent_id = ? AND remote_message_id = ? AND recipient_device_id = ?`,
      )
      .run(
        scope.localServerId,
        scope.localMemberId,
        input.peer.peerServerId,
        input.peer.peerAgentId,
        input.remoteMessageId,
        input.recipientDeviceId,
      );
    return marked;
  }

  #nextSeq(scope: ImServerScope): number {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM offline_queue WHERE local_server_id = ? AND local_member_id = ?",
        )
        .get(scope.localServerId, scope.localMemberId),
    );
    return row ? Number(row.next) : 1;
  }

  #delete(scope: ImServerScope, queueId: string): void {
    this.#db
      .prepare("DELETE FROM offline_queue WHERE local_server_id = ? AND local_member_id = ? AND queue_id = ?")
      .run(scope.localServerId, scope.localMemberId, queueId);
  }
}

function bytesColumn(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error("im.protocolError");
}

export class ImOfflineQueueEmpty extends Error {
  constructor() {
    super("im.messageNotFound");
    this.name = "ImOfflineQueueEmpty";
  }
}
