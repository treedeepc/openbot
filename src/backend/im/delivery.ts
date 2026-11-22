import type { DatabaseSync } from "node:sqlite";
import type { ImDelivery, ImPage } from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { databaseRow, databaseRows } from "../database/database-rows";
import { ImMessageStore, imDeliveryState } from "./messages";
import { ImNotificationService } from "./notifications";

export interface ImDeliveryScope {
  localServerId: string;
  localMemberId: string;
}

export class ImDeliveryMissing extends Error {
  constructor() {
    super("im.notDelivered");
    this.name = "ImDeliveryMissing";
  }
}

export class ImNotResendable extends Error {
  constructor() {
    super("im.notResendable");
    this.name = "ImNotResendable";
  }
}

function view(row: DynamicRecord): ImDelivery {
  return {
    deliveryId: String(row.delivery_id),
    localMessageId: String(row.local_message_id),
    state: imDeliveryState(row.state),
    attempts: Number(row.attempts ?? 0),
    createdAt: Number(row.created_at),
    ackedAt: row.acked_at === null || row.acked_at === undefined ? null : Number(row.acked_at),
    error: row.error === null || row.error === undefined ? null : String(row.error),
  };
}

export class ImDeliveryService {
  readonly #db: DatabaseSync;
  readonly #localServerId: string;
  readonly #messages: ImMessageStore;
  readonly #notifications: ImNotificationService;

  constructor(db: DatabaseSync, localServerId: string) {
    this.#db = db;
    this.#localServerId = localServerId;
    this.#messages = new ImMessageStore(db);
    this.#notifications = new ImNotificationService(db, localServerId);
  }

  list(memberId: string, input: { threadId?: string; cursor?: string } = {}): ImPage<ImDelivery> {
    const rows = input.threadId
      ? databaseRows(
          this.#db
            .prepare(
              `SELECT d.* FROM im_deliveries d JOIN im_messages m
                 ON m.local_message_id = d.local_message_id AND m.local_server_id = ? AND m.local_member_id = ?
               WHERE m.thread_id = ? ORDER BY d.created_at, d.delivery_id`,
            )
            .all(this.#localServerId, memberId, input.threadId),
        )
      : databaseRows(
          this.#db
            .prepare(
              `SELECT d.* FROM im_deliveries d JOIN im_messages m
                 ON m.local_message_id = d.local_message_id AND m.local_server_id = ? AND m.local_member_id = ?
               ORDER BY d.created_at, d.delivery_id`,
            )
            .all(this.#localServerId, memberId),
        );
    const items = rows.map(view);
    return { items, next: null };
  }

  read(deliveryId: string): ImDelivery | null {
    const row = databaseRow(this.#db.prepare("SELECT * FROM im_deliveries WHERE delivery_id = ?").get(deliveryId));
    return row ? view(row) : null;
  }

  ack(memberId: string, input: { deliveryId: string; at: number }): ImDelivery {
    const current = this.read(input.deliveryId);
    if (!current || !this.#owned(memberId, current.localMessageId)) throw new ImDeliveryMissing();
    this.#messages.setDeliveryState(input.deliveryId, "acked", input.at);
    return this.read(input.deliveryId) ?? current;
  }

  markRead(
    memberId: string,
    input: { threadId: string; localMessageId: string; at: number },
  ): { threadId: string; lastReadLocalMessageId: string; updatedAt: number; receiptSent: boolean } {
    const message = this.#messages.readMessage(this.#localServerId, memberId, input.localMessageId);
    if (!message || message.threadId !== input.threadId) throw new ImDeliveryMissing();
    this.#db
      .prepare(
        `INSERT INTO read_state (local_server_id, local_member_id, thread_id, last_read_local_message_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(local_server_id, local_member_id, thread_id) DO UPDATE SET
           last_read_local_message_id = excluded.last_read_local_message_id, updated_at = excluded.updated_at`,
      )
      .run(this.#localServerId, memberId, input.threadId, input.localMessageId, input.at);
    const receiptSent = this.#notifications.readReceiptsEnabled(memberId, input.threadId);
    if (receiptSent) {
      const delivery = databaseRow(
        this.#db
          .prepare("SELECT delivery_id FROM im_deliveries WHERE local_message_id = ? LIMIT 1")
          .get(input.localMessageId),
      );
      if (delivery) this.#messages.setDeliveryState(String(delivery.delivery_id), "read", input.at);
    }
    return {
      threadId: input.threadId,
      lastReadLocalMessageId: input.localMessageId,
      updatedAt: input.at,
      receiptSent,
    };
  }

  #owned(memberId: string, localMessageId: string): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM im_messages WHERE local_server_id = ? AND local_member_id = ? AND local_message_id = ?")
        .get(this.#localServerId, memberId, localMessageId) !== undefined
    );
  }

  lastRead(memberId: string, threadId: string): string | null {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT last_read_local_message_id FROM read_state WHERE local_server_id = ? AND local_member_id = ? AND thread_id = ?",
        )
        .get(this.#localServerId, memberId, threadId),
    );
    return row && row.last_read_local_message_id !== null ? String(row.last_read_local_message_id) : null;
  }

  resend(memberId: string, input: { deliveryId: string; at: number }): ImDelivery {
    const current = this.read(input.deliveryId);
    if (!current || !this.#owned(memberId, current.localMessageId)) throw new ImDeliveryMissing();
    if (current.state !== "submitted" && current.state !== "failed") throw new ImNotResendable();
    this.#messages.bumpAttempts(input.deliveryId);
    this.#db
      .prepare("UPDATE im_deliveries SET error = NULL, next_retry_at = NULL WHERE delivery_id = ?")
      .run(input.deliveryId);
    this.#messages.setDeliveryState(input.deliveryId, "submitted", input.at);
    return this.read(input.deliveryId) ?? current;
  }
}
