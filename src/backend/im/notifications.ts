import type { DatabaseSync } from "node:sqlite";
import { databaseRow } from "../database/database-rows";

export interface ImNotifyScope {
  localServerId: string;
  localMemberId: string;
}

export const IM_NOTIFY_ON = ["all", "mentions", "none"] as const;
export type ImNotifyOn = (typeof IM_NOTIFY_ON)[number];

export interface ImNotificationDefaults {
  notifyOn: ImNotifyOn;
  showPreview: boolean;
}

export interface ImNotificationOverride {
  threadId: string;
  mutedUntil: number | null;
  notifyOn: ImNotifyOn | null;
  showPreview: boolean | null;
  sendReadReceipts: boolean | null;
}

export interface ImNotificationDecision {
  notify: boolean;
  showPreview: boolean;
  reason: "ok" | "muted" | "notify-none" | "no-mention" | "duplicate-proxy";
}

function notifyOn(value: unknown): ImNotifyOn {
  return value === "none" ? "none" : value === "mentions" ? "mentions" : "all";
}

function flag(value: unknown): boolean {
  return value === 1 || value === true;
}

export class ImNotificationService {
  readonly #db: DatabaseSync;
  readonly #localServerId: string;
  readonly #seenProxy = new Set<string>();

  constructor(db: DatabaseSync, localServerId: string) {
    this.#db = db;
    this.#localServerId = localServerId;
  }

  defaults(memberId: string): ImNotificationDefaults {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT notify_on, show_preview FROM notification_defaults WHERE local_server_id = ? AND local_member_id = ?",
        )
        .get(this.#localServerId, memberId),
    );
    return {
      notifyOn: row ? notifyOn(row.notify_on) : "all",
      showPreview: row ? flag(row.show_preview) : false,
    };
  }

  setDefaults(memberId: string, input: ImNotificationDefaults): ImNotificationDefaults {
    this.#db
      .prepare(
        `INSERT INTO notification_defaults (local_server_id, local_member_id, notify_on, show_preview)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(local_server_id, local_member_id) DO UPDATE SET notify_on = excluded.notify_on,
           show_preview = excluded.show_preview`,
      )
      .run(this.#localServerId, memberId, input.notifyOn, input.showPreview ? 1 : 0);
    return input;
  }

  override(memberId: string, threadId: string): ImNotificationOverride | null {
    const row = databaseRow(
      this.#db
        .prepare(
          `SELECT thread_id, muted_until, notify_on, show_preview, send_read_receipts FROM notification_overrides
           WHERE local_server_id = ? AND local_member_id = ? AND thread_id = ?`,
        )
        .get(this.#localServerId, memberId, threadId),
    );
    if (!row) return null;
    return {
      threadId: String(row.thread_id),
      mutedUntil: row.muted_until === null ? null : Number(row.muted_until),
      notifyOn: row.notify_on === null ? null : notifyOn(row.notify_on),
      showPreview: row.show_preview === null ? null : flag(row.show_preview),
      sendReadReceipts:
        row.send_read_receipts === null || row.send_read_receipts === undefined ? null : flag(row.send_read_receipts),
    };
  }

  setOverride(
    memberId: string,
    input: {
      threadId: string;
      mutedUntil: number | null;
      notifyOn: ImNotifyOn | null;
      showPreview: boolean | null;
      sendReadReceipts?: boolean | null;
    },
  ): ImNotificationOverride {
    this.#db
      .prepare(
        `INSERT INTO notification_overrides (local_server_id, local_member_id, thread_id, muted_until, notify_on,
          show_preview, send_read_receipts)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_server_id, local_member_id, thread_id) DO UPDATE SET muted_until = excluded.muted_until,
           notify_on = excluded.notify_on, show_preview = excluded.show_preview,
           send_read_receipts = excluded.send_read_receipts`,
      )
      .run(
        this.#localServerId,
        memberId,
        input.threadId,
        input.mutedUntil,
        input.notifyOn,
        input.showPreview === null ? null : input.showPreview ? 1 : 0,
        input.sendReadReceipts === undefined || input.sendReadReceipts === null ? null : input.sendReadReceipts ? 1 : 0,
      );
    return { ...input, sendReadReceipts: input.sendReadReceipts ?? null };
  }

  clearOverride(memberId: string, threadId: string): boolean {
    return (
      this.#db
        .prepare(
          "DELETE FROM notification_overrides WHERE local_server_id = ? AND local_member_id = ? AND thread_id = ?",
        )
        .run(this.#localServerId, memberId, threadId).changes > 0
    );
  }

  readReceiptsEnabled(memberId: string, threadId: string): boolean {
    const over = this.override(memberId, threadId);
    return over?.sendReadReceipts ?? true;
  }

  decide(
    memberId: string,
    input: { threadId: string; at: number; messageId: string; mention?: boolean; proxiedBy?: string | null },
  ): ImNotificationDecision {
    const over = this.override(memberId, input.threadId);
    if (over && over.mutedUntil !== null && over.mutedUntil > input.at) {
      return { notify: false, showPreview: false, reason: "muted" };
    }
    const base = this.defaults(memberId);
    const notifyOn = over?.notifyOn ?? base.notifyOn;
    const showPreview = over?.showPreview ?? base.showPreview;
    if (notifyOn === "none") return { notify: false, showPreview: false, reason: "notify-none" };
    if (notifyOn === "mentions" && input.mention !== true) {
      return { notify: false, showPreview: false, reason: "no-mention" };
    }
    if (input.proxiedBy) {
      const key = `${this.#localServerId} ${memberId} ${input.threadId} ${input.messageId}`;
      if (this.#seenProxy.has(key)) return { notify: false, showPreview: false, reason: "duplicate-proxy" };
      this.#seenProxy.add(key);
    }
    return { notify: true, showPreview, reason: "ok" };
  }
}
