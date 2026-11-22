import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ImAttachment, ImMessage, ImPage, ImPeer, ImProxyVisibility, ImSenderKind } from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { databaseRow, databaseRows } from "../database/database-rows";
import { imFingerprint } from "./identity";
import { ImDuplicateMessage, ImMessageStore, type ImStoredMessage } from "./messages";

export interface ImServiceScope {
  localServerId: string;
  localMemberId: string;
}

export interface ImSendMessageInput {
  threadId: string;
  remoteMessageId: string;
  body: string;
  attachments: ImAttachment[];
  replyTo: string | null;
  proxiedBy: string | null;
  proxyVisibility: ImProxyVisibility | null;
  senderKind: ImSenderKind;
  senderAgentId: string | null;
  deviceId: string | null;
  causalChainId: string | null;
  nonce: string;
  signature: string;
  verified: boolean;
  sentAt: number;
  expiresAt: number;
}

export interface ImListMessagesInput {
  threadId: string;
  cursor?: string;
}

export interface ImListPeersInput {
  cursor?: string;
}

export interface ImPeerRefInput {
  peerServerId: string;
  peerAgentId: string;
}

export interface ImVerifyPeerInput {
  peerServerId: string;
  peerAgentId: string;
  fingerprint: string;
}

export class ImPeerUnknown extends Error {
  constructor() {
    super("im.notFound");
    this.name = "ImPeerUnknown";
  }
}

export class ImFingerprintMismatch extends Error {
  constructor() {
    super("im.confirmMismatch");
    this.name = "ImFingerprintMismatch";
  }
}

export class ImMessageMissing extends Error {
  constructor() {
    super("im.messageNotFound");
    this.name = "ImMessageMissing";
  }
}

const IM_CLIENT_MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const PAGE = 50;

function toView(message: ImStoredMessage, withdrawnAt: number | null, attachments: ImAttachment[]): ImMessage {
  return {
    localMessageId: message.localMessageId,
    remoteMessageId: message.remoteMessageId,
    threadId: message.threadId,
    senderKind: message.senderKind,
    senderAgentId: message.senderAgentId,
    deviceId: message.deviceId,
    body: message.body,
    attachments,
    replyTo: null,
    proxiedBy: message.proxiedBy,
    proxyVisibility: message.proxyVisibility,
    causalChainId: message.causalChainId,
    sentAt: message.sentAt,
    expiresAt: message.expiresAt,
    withdrawnAt,
    verified: message.verified,
  };
}

function pageOf<Item>(items: Item[], cursor: string | undefined, key: (item: Item) => string): ImPage<Item> {
  const start = cursor ? items.findIndex((item) => key(item) > cursor) : 0;
  const from = start < 0 ? items.length : start;
  const kept = items.slice(from, from + PAGE);
  const last = kept.at(-1);
  return { items: kept, next: kept.length === PAGE && last !== undefined ? key(last) : null };
}

export class ImService {
  readonly #db: DatabaseSync;
  readonly #messages: ImMessageStore;
  readonly #localServerId: string;

  constructor(db: DatabaseSync, localServerId: string) {
    this.#db = db;
    this.#messages = new ImMessageStore(db);
    this.#localServerId = localServerId;
  }

  scope(memberId: string): ImServiceScope {
    return { localServerId: this.#localServerId, localMemberId: memberId };
  }

  sendMessage(memberId: string, input: ImSendMessageInput): ImMessage {
    const peer = this.#peerOf(memberId, input.threadId);
    const stored: ImStoredMessage = {
      localServerId: this.#localServerId,
      localMemberId: memberId,
      localMessageId: `lm-${input.remoteMessageId}`,
      threadId: input.threadId,
      remoteMessageId: input.remoteMessageId,
      peerServerId: peer.peerServerId,
      peerAgentId: peer.peerAgentId,
      senderKind: input.senderKind,
      senderAgentId: input.senderAgentId,
      deviceId: input.deviceId,
      body: input.body,
      causalChainId: input.causalChainId,
      proxiedBy: input.proxiedBy,
      proxyVisibility: input.proxyVisibility,
      nonce: input.nonce,
      signature: input.signature,
      verified: input.verified,
      sentAt: input.sentAt,
      expiresAt: input.expiresAt,
    };
    const dedup = {
      localServerId: this.#localServerId,
      localMemberId: memberId,
      peerServerId: peer.peerServerId,
      peerAgentId: peer.peerAgentId,
      remoteMessageId: input.remoteMessageId,
      deviceId: input.deviceId ?? "none",
      nonce: input.nonce,
    };
    if (this.#messages.hasDuplicate(dedup) || this.#alreadySent(memberId, peer, input.remoteMessageId)) {
      throw new ImDuplicateMessage();
    }
    this.#messages.markDuplicate({ ...dedup, receivedAt: input.sentAt });
    this.#messages.insertMessage(stored);
    this.#messages.insertDelivery({
      localServerId: this.#localServerId,
      localMemberId: memberId,
      deliveryId: `dl-${input.remoteMessageId}`,
      localMessageId: stored.localMessageId,
      peerServerId: stored.peerServerId,
      peerAgentId: stored.peerAgentId,
      createdAt: input.sentAt,
    });
    return toView(stored, null, input.attachments);
  }

  listMessages(memberId: string, input: ImListMessagesInput): ImPage<ImMessage> {
    const stored = this.#messages.listMessages(this.#localServerId, memberId, input.threadId);
    return pageOf(
      stored.map((message) => toView(message, this.#withdrawnAt(memberId, message.localMessageId), [])),
      input.cursor,
      (message) => message.localMessageId,
    );
  }

  listPeers(memberId: string, input: ImListPeersInput): ImPage<ImPeer> {
    const rows = databaseRows(
      this.#db
        .prepare(
          `SELECT p.peer_server_id, p.peer_agent_id, p.public_key, p.display_name, p.verified_at
           FROM peers p
           WHERE EXISTS (
             SELECT 1 FROM im_threads t
              WHERE t.local_server_id = ? AND t.local_member_id = ?
                AND t.peer_server_id = p.peer_server_id AND t.peer_agent_id = p.peer_agent_id
           ) OR EXISTS (
             SELECT 1 FROM contacts c
              WHERE c.local_server_id = ? AND c.local_member_id = ?
                AND c.peer_server_id = p.peer_server_id AND c.peer_agent_id = p.peer_agent_id
           )
           ORDER BY p.peer_server_id, p.peer_agent_id`,
        )
        .all(this.#localServerId, memberId, this.#localServerId, memberId),
    );
    return pageOf(rows.map(readPeer), input.cursor, (peer) => `${peer.peerServerId}/${peer.peerAgentId}`);
  }

  verifyPeer(memberId: string, input: ImVerifyPeerInput, at = Date.now()): ImPeer {
    const row = databaseRow(
      this.#db
        .prepare("SELECT * FROM peers WHERE peer_server_id = ? AND peer_agent_id = ?")
        .get(input.peerServerId, input.peerAgentId),
    );
    if (!row) throw new ImPeerUnknown();
    if (!this.#visible(memberId, input.peerServerId, input.peerAgentId)) throw new ImPeerUnknown();
    const peer = readPeer(row);
    if (peer.fingerprint !== input.fingerprint) throw new ImFingerprintMismatch();
    this.#db
      .prepare("UPDATE peers SET verified_at = ? WHERE peer_server_id = ? AND peer_agent_id = ?")
      .run(at, input.peerServerId, input.peerAgentId);
    return { ...peer, verified: true };
  }

  sendFromClient(
    memberId: string,
    input: {
      threadId: string;
      remoteMessageId: string;
      body: string;
      attachments: ImAttachment[];
      replyTo: string | null;
      proxiedBy: string | null;
      proxyVisibility: ImProxyVisibility | null;
      causalChainId?: string | null;
      at?: number;
    },
  ): ImMessage {
    const sentAt = input.at ?? Date.now();
    return this.sendMessage(memberId, {
      ...input,
      causalChainId: input.causalChainId ?? null,
      senderKind: "self",
      senderAgentId: null,
      deviceId: null,
      nonce: randomUUID(),
      signature: "",
      verified: false,
      sentAt,
      expiresAt: sentAt + IM_CLIENT_MESSAGE_TTL_MS,
    });
  }

  withdrawMessage(memberId: string, input: { threadId: string; localMessageId: string }): void {
    const message = this.#messages.readMessage(this.#localServerId, memberId, input.localMessageId);
    if (!message || message.threadId !== input.threadId) throw new ImMessageMissing();
    const at = Date.now();
    this.#db
      .prepare(
        `INSERT INTO withdrawn_messages (local_server_id, local_member_id, local_message_id, withdrawn_at,
          withdrawn_by, tombstone_text)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_server_id, local_member_id, local_message_id) DO NOTHING`,
      )
      .run(this.#localServerId, memberId, input.localMessageId, at, memberId, "");
    this.#db
      .prepare(
        "UPDATE im_messages SET withdrawn_at = ? WHERE local_server_id = ? AND local_member_id = ? AND local_message_id = ?",
      )
      .run(at, this.#localServerId, memberId, input.localMessageId);
  }

  #alreadySent(
    memberId: string,
    peer: { peerServerId: string; peerAgentId: string },
    remoteMessageId: string,
  ): boolean {
    return (
      this.#db
        .prepare(
          `SELECT 1 FROM im_messages
            WHERE local_server_id = ? AND local_member_id = ? AND peer_server_id = ? AND peer_agent_id = ?
              AND remote_message_id = ?`,
        )
        .get(this.#localServerId, memberId, peer.peerServerId, peer.peerAgentId, remoteMessageId) !== undefined
    );
  }

  revokePeerVerification(memberId: string, input: ImPeerRefInput): boolean {
    const row = databaseRow(
      this.#db
        .prepare("SELECT peer_server_id FROM peers WHERE peer_server_id = ? AND peer_agent_id = ?")
        .get(input.peerServerId, input.peerAgentId),
    );
    if (!row || !this.#visible(memberId, input.peerServerId, input.peerAgentId)) throw new ImPeerUnknown();
    return (
      this.#db
        .prepare("UPDATE peers SET verified_at = NULL WHERE peer_server_id = ? AND peer_agent_id = ?")
        .run(input.peerServerId, input.peerAgentId).changes > 0
    );
  }

  recordPeerKey(
    memberId: string,
    input: ImPeerRefInput & { publicKey: string; displayName?: string | null; at: number },
  ): ImPeer {
    const row = databaseRow(
      this.#db
        .prepare("SELECT * FROM peers WHERE peer_server_id = ? AND peer_agent_id = ?")
        .get(input.peerServerId, input.peerAgentId),
    );
    if (!row) throw new ImPeerUnknown();
    if (!this.#visible(memberId, input.peerServerId, input.peerAgentId)) throw new ImPeerUnknown();
    const known = readPeer(row);
    const fingerprint = imFingerprint(input.publicKey);
    this.#db
      .prepare(
        `UPDATE peers SET public_key = ?, display_name = COALESCE(?, display_name), last_seen_at = ?,
           verified_at = CASE WHEN ? THEN NULL ELSE verified_at END
         WHERE peer_server_id = ? AND peer_agent_id = ?`,
      )
      .run(
        input.publicKey,
        input.displayName ?? null,
        input.at,
        known.fingerprint !== fingerprint ? 1 : 0,
        input.peerServerId,
        input.peerAgentId,
      );
    return {
      ...known,
      displayName: input.displayName ?? known.displayName,
      fingerprint,
      verified: known.fingerprint === fingerprint ? known.verified : false,
    };
  }

  peerVerifiedAt(memberId: string, input: ImPeerRefInput): number | null {
    const row = databaseRow(
      this.#db
        .prepare("SELECT verified_at FROM peers WHERE peer_server_id = ? AND peer_agent_id = ?")
        .get(input.peerServerId, input.peerAgentId),
    );
    if (!row || !this.#visible(memberId, input.peerServerId, input.peerAgentId)) throw new ImPeerUnknown();
    return row.verified_at === null || row.verified_at === undefined ? null : Number(row.verified_at);
  }

  visiblePeer(memberId: string, input: ImPeerRefInput): boolean {
    return this.#visible(memberId, input.peerServerId, input.peerAgentId);
  }

  #visible(memberId: string, peerServerId: string, peerAgentId: string): boolean {
    return (
      this.#db
        .prepare(
          `SELECT 1 FROM im_threads
            WHERE local_server_id = ? AND local_member_id = ? AND peer_server_id = ? AND peer_agent_id = ?
           UNION ALL
           SELECT 1 FROM contacts
            WHERE local_server_id = ? AND local_member_id = ? AND peer_server_id = ? AND peer_agent_id = ?
           LIMIT 1`,
        )
        .get(
          this.#localServerId,
          memberId,
          peerServerId,
          peerAgentId,
          this.#localServerId,
          memberId,
          peerServerId,
          peerAgentId,
        ) !== undefined
    );
  }

  #peerOf(memberId: string, threadId: string): { peerServerId: string; peerAgentId: string } {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT peer_server_id, peer_agent_id FROM im_threads WHERE local_server_id = ? AND local_member_id = ? AND thread_id = ?",
        )
        .get(this.#localServerId, memberId, threadId),
    );
    if (!row) throw new ImPeerUnknown();
    return { peerServerId: String(row.peer_server_id), peerAgentId: String(row.peer_agent_id) };
  }

  #withdrawnAt(memberId: string, localMessageId: string): number | null {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT withdrawn_at FROM withdrawn_messages WHERE local_server_id = ? AND local_member_id = ? AND local_message_id = ?",
        )
        .get(this.#localServerId, memberId, localMessageId),
    );
    return row && row.withdrawn_at !== null ? Number(row.withdrawn_at) : null;
  }
}

function readPeer(row: DynamicRecord): ImPeer {
  const publicKey = String(row.public_key);
  return {
    peerServerId: String(row.peer_server_id),
    peerAgentId: String(row.peer_agent_id),
    displayName: String(row.display_name),
    verified: row.verified_at !== null && row.verified_at !== undefined,
    fingerprint: imFingerprint(publicKey),
  };
}
