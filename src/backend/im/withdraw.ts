import type { DatabaseSync } from "node:sqlite";
import { databaseRow, databaseRows } from "../database/database-rows";
import { ImMessageStore } from "./messages";
import type { ImFrameNonce } from "./wire";

export interface ImWithdrawScope {
  localServerId: string;
  localMemberId: string;
}

export const IM_WITHDRAW_WINDOW_MS = 120_000;
export const IM_WITHDRAWN_TOMBSTONE = "im.messageWithdrawn";

export class ImMessageMissing extends Error {
  constructor() {
    super("im.messageNotFound");
    this.name = "ImMessageMissing";
  }
}

export class ImWithdrawExpired extends Error {
  constructor() {
    super("im.withdrawExpired");
    this.name = "ImWithdrawExpired";
  }
}

export type ImWithdrawScene = "online" | "offline-queue" | "lan-undelivered" | "after-read";

export interface ImWithdrawResult {
  localMessageId: string;
  withdrawnAt: number;
  tombstone: string;
  scene: ImWithdrawScene;
  queueRemoved: boolean;
  notifiedRecipient: boolean;
}

export class ImWithdrawService {
  readonly #db: DatabaseSync;
  readonly #localServerId: string;

  constructor(db: DatabaseSync, localServerId: string) {
    this.#db = db;
    this.#localServerId = localServerId;
  }

  withdraw(
    memberId: string,
    input: { threadId: string; localMessageId: string; at: number; scene?: ImWithdrawScene },
  ): ImWithdrawResult {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT thread_id, sent_at, body FROM im_messages WHERE local_server_id = ? AND local_member_id = ? AND local_message_id = ?",
        )
        .get(this.#localServerId, memberId, input.localMessageId),
    );
    if (!row || String(row.thread_id) !== input.threadId) throw new ImMessageMissing();
    const sentAt = Number(row.sent_at);
    if (input.at - sentAt > IM_WITHDRAW_WINDOW_MS) throw new ImWithdrawExpired();
    const scene = input.scene ?? this.#scene(memberId, input.localMessageId);
    this.#db
      .prepare(
        `INSERT INTO withdrawn_messages (local_server_id, local_member_id, local_message_id, withdrawn_at, withdrawn_by, tombstone_text)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_server_id, local_member_id, local_message_id) DO NOTHING`,
      )
      .run(this.#localServerId, memberId, input.localMessageId, input.at, memberId, IM_WITHDRAWN_TOMBSTONE);
    this.#db
      .prepare(
        `UPDATE im_messages SET withdrawn_at = ?, body = ?
         WHERE local_server_id = ? AND local_member_id = ? AND local_message_id = ?`,
      )
      .run(input.at, IM_WITHDRAWN_TOMBSTONE, this.#localServerId, memberId, input.localMessageId);
    const droppedQueued = this.#dropQueued(memberId, input.localMessageId);
    const droppedDraft = this.#dropDraft(input.localMessageId);
    return {
      localMessageId: input.localMessageId,
      withdrawnAt: input.at,
      tombstone: IM_WITHDRAWN_TOMBSTONE,
      scene,
      queueRemoved: droppedQueued || droppedDraft,
      notifiedRecipient: scene === "online",
    };
  }

  tombstone(memberId: string, localMessageId: string): { tombstone: string; withdrawnAt: number } | null {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT tombstone_text, withdrawn_at FROM withdrawn_messages WHERE local_server_id = ? AND local_member_id = ? AND local_message_id = ?",
        )
        .get(this.#localServerId, memberId, localMessageId),
    );
    return row ? { tombstone: String(row.tombstone_text), withdrawnAt: Number(row.withdrawn_at) } : null;
  }

  #scene(memberId: string, localMessageId: string): ImWithdrawScene {
    const delivery = databaseRow(
      this.#db
        .prepare("SELECT state FROM im_deliveries WHERE local_message_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(localMessageId),
    );
    const queued = databaseRow(
      this.#db
        .prepare(
          "SELECT queue_id FROM offline_queue WHERE local_server_id = ? AND local_member_id = ? AND remote_message_id = ? LIMIT 1",
        )
        .get(this.#localServerId, memberId, localMessageId),
    );
    if (queued) return "offline-queue";
    if (!delivery || delivery.state === "failed") return "lan-undelivered";
    return delivery.state === "read" ? "after-read" : "online";
  }

  #dropDraft(localMessageId: string): boolean {
    const rows = databaseRows(
      this.#db
        .prepare("SELECT delivery_id FROM im_deliveries WHERE local_message_id = ? AND state = 'failed'")
        .all(localMessageId),
    );
    const store = new ImMessageStore(this.#db);
    let dropped = false;
    for (const row of rows) {
      if (store.discardDelivery(String(row.delivery_id), IM_WITHDRAWN_TOMBSTONE)) dropped = true;
    }
    return dropped;
  }

  #dropQueued(memberId: string, localMessageId: string): boolean {
    const message = databaseRow(
      this.#db
        .prepare(
          "SELECT remote_message_id, nonce FROM im_messages WHERE local_server_id = ? AND local_member_id = ? AND local_message_id = ?",
        )
        .get(this.#localServerId, memberId, localMessageId),
    );
    const remoteMessageId = message ? String(message.remote_message_id) : localMessageId;
    const frameNonce: ImFrameNonce = message ? String(message.nonce) : localMessageId;
    return (
      this.#db
        .prepare(
          "DELETE FROM offline_queue WHERE local_server_id = ? AND local_member_id = ? AND (remote_message_id = ? OR remote_message_id = ? OR remote_message_id = ?)",
        )
        .run(this.#localServerId, memberId, remoteMessageId, frameNonce, localMessageId).changes > 0
    );
  }
}
