import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { IM_DELIVERY_STATES, type ImDeliveryState } from "@openbot/contracts/ipc";
import { type DynamicRecord, isNumber } from "@openbot/contracts/runtime-values";
import { databaseRow, databaseRows } from "../database/database-rows";

export const IM_SEND_STATES = ["submitted", "persisted", "acked", "read"] as const;
export type ImSendState = (typeof IM_SEND_STATES)[number];

const IM_DELIVERY_NEXT: Readonly<Record<ImDeliveryState, readonly ImDeliveryState[]>> = {
  submitted: ["persisted", "acked", "read", "failed", "blocked-discarded"],
  failed: ["submitted", "persisted", "acked", "read", "blocked-discarded"],
  "blocked-discarded": [],
  persisted: ["acked", "read"],
  acked: ["read"],
  read: [],
};

export class ImDeliveryDelivered extends Error {
  constructor() {
    super("im.notResendable");
    this.name = "ImDeliveryDelivered";
  }
}

function isDeliveryState(value: unknown): value is ImDeliveryState {
  return IM_DELIVERY_STATES.some((state) => state === value);
}

export function imDeliveryState(value: unknown): ImDeliveryState {
  return isDeliveryState(value) ? value : "submitted";
}

function mayAdvance(from: ImDeliveryState, to: ImDeliveryState): boolean {
  return IM_DELIVERY_NEXT[from].includes(to);
}

export interface ImStoredMessage {
  localServerId: string;
  localMemberId: string;
  localMessageId: string;
  threadId: string;
  remoteMessageId: string;
  peerServerId: string;
  peerAgentId: string;
  senderKind: "self" | "local-assistant" | "peer";
  senderAgentId: string | null;
  deviceId: string | null;
  body: string;
  causalChainId: string | null;
  proxiedBy: string | null;
  proxyVisibility: "shown" | "hidden" | null;
  nonce: string;
  signature: string;
  verified: boolean;
  sentAt: number;
  expiresAt: number;
}

export interface ImStoredDelivery {
  deliveryId: string;
  localMessageId: string;
  peerServerId: string;
  peerAgentId: string;
  state: ImDeliveryState;
  attempts: number;
  createdAt: number;
  ackedAt: number | null;
  error: string | null;
}

export class ImDuplicateMessage extends Error {
  constructor() {
    super("im.duplicateMessage");
    this.name = "ImDuplicateMessage";
  }
}

function toValues(message: ImStoredMessage): SQLInputValue[] {
  return [
    message.localServerId,
    message.localMemberId,
    message.localMessageId,
    message.threadId,
    message.remoteMessageId,
    message.peerServerId,
    message.peerAgentId,
    message.senderKind,
    message.senderAgentId,
    message.deviceId,
    message.body,
    message.causalChainId,
    message.proxiedBy,
    message.proxyVisibility,
    message.nonce,
    message.signature,
    message.verified ? 1 : 0,
    message.sentAt,
    message.expiresAt,
  ];
}

function readMessage(row: DynamicRecord): ImStoredMessage {
  return {
    localServerId: String(row.local_server_id),
    localMemberId: String(row.local_member_id),
    localMessageId: String(row.local_message_id),
    threadId: String(row.thread_id),
    remoteMessageId: String(row.remote_message_id),
    peerServerId: String(row.peer_server_id),
    peerAgentId: String(row.peer_agent_id),
    senderKind: row.sender_kind === "self" ? "self" : row.sender_kind === "peer" ? "peer" : "local-assistant",
    senderAgentId: row.sender_agent_id === null ? null : String(row.sender_agent_id),
    deviceId: row.device_id === null ? null : String(row.device_id),
    body: String(row.body),
    causalChainId: row.causal_chain_id === null ? null : String(row.causal_chain_id),
    proxiedBy: row.proxied_by === null ? null : String(row.proxied_by),
    proxyVisibility: row.proxy_visibility === "shown" ? "shown" : row.proxy_visibility === "hidden" ? "hidden" : null,
    nonce: String(row.nonce),
    signature: String(row.signature),
    verified: isNumber(row.verified) ? row.verified !== 0 : false,
    sentAt: Number(row.sent_at),
    expiresAt: Number(row.expires_at),
  };
}

export class ImMessageStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  hasDuplicate(input: {
    localServerId: string;
    localMemberId: string;
    peerServerId: string;
    peerAgentId: string;
    remoteMessageId: string;
    deviceId: string;
    nonce: string;
  }): boolean {
    const row = databaseRow(
      this.#db
        .prepare(
          `SELECT remote_message_id FROM message_dedup
           WHERE local_server_id = ? AND local_member_id = ? AND peer_server_id = ? AND peer_agent_id = ?
             AND remote_message_id = ? AND device_id = ? AND nonce = ?`,
        )
        .get(
          input.localServerId,
          input.localMemberId,
          input.peerServerId,
          input.peerAgentId,
          input.remoteMessageId,
          input.deviceId,
          input.nonce,
        ),
    );
    return row !== null;
  }

  markDuplicate(input: {
    localServerId: string;
    localMemberId: string;
    peerServerId: string;
    peerAgentId: string;
    remoteMessageId: string;
    deviceId: string;
    nonce: string;
    receivedAt: number;
  }): void {
    if (this.hasDuplicate(input)) throw new ImDuplicateMessage();
    this.#db
      .prepare(
        `INSERT INTO message_dedup (local_server_id, local_member_id, peer_server_id, peer_agent_id,
          remote_message_id, device_id, nonce, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.localServerId,
        input.localMemberId,
        input.peerServerId,
        input.peerAgentId,
        input.remoteMessageId,
        input.deviceId,
        input.nonce,
        input.receivedAt,
      );
  }

  insertMessage(message: ImStoredMessage): void {
    this.#db
      .prepare(
        `INSERT INTO im_messages (local_server_id, local_member_id, local_message_id, thread_id, remote_message_id,
          peer_server_id, peer_agent_id, sender_kind, sender_agent_id, device_id, body, causal_chain_id,
          proxied_by, proxy_visibility, nonce, signature, verified, sent_at, expires_at)
         VALUES (${toValues(message)
           .map(() => "?")
           .join(", ")})`,
      )
      .run(...toValues(message));
  }

  readMessage(localServerId: string, localMemberId: string, localMessageId: string): ImStoredMessage | null {
    const row = databaseRow(
      this.#db
        .prepare("SELECT * FROM im_messages WHERE local_server_id = ? AND local_member_id = ? AND local_message_id = ?")
        .get(localServerId, localMemberId, localMessageId),
    );
    return row ? readMessage(row) : null;
  }

  listMessages(localServerId: string, localMemberId: string, threadId: string): ImStoredMessage[] {
    return databaseRows(
      this.#db
        .prepare(
          `SELECT * FROM im_messages WHERE local_server_id = ? AND local_member_id = ? AND thread_id = ?
           ORDER BY sent_at, local_message_id`,
        )
        .all(localServerId, localMemberId, threadId),
    ).map(readMessage);
  }

  insertDelivery(delivery: {
    localServerId: string;
    localMemberId: string;
    deliveryId: string;
    localMessageId: string;
    peerServerId: string;
    peerAgentId: string;
    createdAt: number;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO im_deliveries (local_server_id, local_member_id, delivery_id, local_message_id, peer_server_id,
          peer_agent_id, state, attempts, created_at, acked_at)
         VALUES (?, ?, ?, ?, ?, ?, 'submitted', 0, ?, NULL)`,
      )
      .run(
        delivery.localServerId,
        delivery.localMemberId,
        delivery.deliveryId,
        delivery.localMessageId,
        delivery.peerServerId,
        delivery.peerAgentId,
        delivery.createdAt,
      );
  }

  readDelivery(deliveryId: string): ImStoredDelivery | null {
    const row = databaseRow(this.#db.prepare("SELECT * FROM im_deliveries WHERE delivery_id = ?").get(deliveryId));
    if (!row) return null;
    return {
      deliveryId: String(row.delivery_id),
      localMessageId: String(row.local_message_id),
      peerServerId: String(row.peer_server_id),
      peerAgentId: String(row.peer_agent_id),
      state: imDeliveryState(row.state),
      attempts: Number(row.attempts ?? 0),
      createdAt: Number(row.created_at),
      ackedAt: row.acked_at === null || row.acked_at === undefined ? null : Number(row.acked_at),
      error: row.error === null || row.error === undefined ? null : String(row.error),
    };
  }

  setDeliveryState(deliveryId: string, state: ImDeliveryState, at: number): void {
    const current = this.readDelivery(deliveryId);
    if (!current) return;
    if (current.state === state) return;
    if (!mayAdvance(current.state, state)) return;
    if (state === "acked") {
      this.#db
        .prepare("UPDATE im_deliveries SET state = ?, acked_at = ? WHERE delivery_id = ?")
        .run(state, at, deliveryId);
      return;
    }
    this.#db.prepare("UPDATE im_deliveries SET state = ? WHERE delivery_id = ?").run(state, deliveryId);
  }

  bumpAttempts(deliveryId: string): void {
    this.#db.prepare("UPDATE im_deliveries SET attempts = attempts + 1 WHERE delivery_id = ?").run(deliveryId);
  }

  markUndelivered(deliveryId: string, input: { error: string; nextRetryAt: number | null }): boolean {
    const current = this.readDelivery(deliveryId);
    if (!current) return false;
    if (current.state !== "failed" && !mayAdvance(current.state, "failed")) return false;
    this.#db
      .prepare("UPDATE im_deliveries SET state = 'failed', error = ?, next_retry_at = ? WHERE delivery_id = ?")
      .run(input.error, input.nextRetryAt, deliveryId);
    return true;
  }

  discardDelivery(deliveryId: string, error: string): boolean {
    const current = this.readDelivery(deliveryId);
    if (!current) return false;
    if (!mayAdvance(current.state, "blocked-discarded")) return false;
    this.#db
      .prepare(
        "UPDATE im_deliveries SET state = 'blocked-discarded', error = ?, next_retry_at = NULL WHERE delivery_id = ?",
      )
      .run(error, deliveryId);
    return true;
  }
}
