import type { DatabaseSync } from "node:sqlite";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { databaseRows } from "../database/database-rows";
import { ImDeliveryDelivered, ImMessageStore } from "./messages";

export const IM_LAN_PEER_OFFLINE = "im.peerOffline";
export const IM_LAN_RETRY_BACKOFF_MS = 30_000;

export interface ImLanDraft {
  deliveryId: string;
  localMessageId: string;
  threadId: string;
  peerServerId: string;
  peerAgentId: string;
  body: string;
  attempts: number;
  error: string | null;
  createdAt: number;
  nextRetryAt: number | null;
}

export interface ImLanDeliverInput {
  deliveryId: string;
  memberId: string;
  remoteMessageId: string;
  threadId: string;
  peerServerId: string;
  peerAgentId: string;
  body: string;
  nonce: string;
  sentAt: number;
}

export type ImLanDeliverPort = (input: ImLanDeliverInput) => void | Promise<void>;

export type ImLanResendOutcome = "delivered" | "still-undelivered" | "skipped-delivered" | "skipped-withdrawn";

export interface ImLanResendResult {
  deliveryId: string;
  localMessageId: string;
  peerServerId: string;
  peerAgentId: string;
  outcome: ImLanResendOutcome;
  state: string;
  attempts: number;
  error: string | null;
}

export class ImLanUndelivered extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "ImLanUndelivered";
    this.reason = reason;
  }
}

interface ImLanOutboxRow {
  localMemberId: string;
  deliveryId: string;
  localMessageId: string;
  remoteMessageId: string;
  threadId: string;
  peerServerId: string;
  peerAgentId: string;
  body: string;
  nonce: string;
  sentAt: number;
  withdrawnAt: number | null;
  attempts: number;
  error: string | null;
  createdAt: number;
  nextRetryAt: number | null;
}

const IM_LAN_OUTBOX_COLUMNS = `d.delivery_id, d.local_message_id, d.peer_server_id, d.peer_agent_id,
  d.attempts, d.error, d.created_at, d.next_retry_at, m.remote_message_id,
  m.local_member_id, m.thread_id, m.body, m.nonce, m.sent_at, m.withdrawn_at`;

const IM_LAN_WITHDRAWN = `m.withdrawn_at IS NOT NULL OR EXISTS (
  SELECT 1 FROM withdrawn_messages w
   WHERE w.local_server_id = m.local_server_id AND w.local_member_id = m.local_member_id
     AND w.local_message_id = m.local_message_id)`;

function readRow(row: DynamicRecord): ImLanOutboxRow {
  return {
    localMemberId: String(row.local_member_id),
    deliveryId: String(row.delivery_id),
    localMessageId: String(row.local_message_id),
    remoteMessageId: String(row.remote_message_id),
    threadId: String(row.thread_id),
    peerServerId: String(row.peer_server_id),
    peerAgentId: String(row.peer_agent_id),
    body: String(row.body),
    nonce: String(row.nonce),
    sentAt: Number(row.sent_at),
    withdrawnAt: row.withdrawn_at === null || row.withdrawn_at === undefined ? null : Number(row.withdrawn_at),
    attempts: Number(row.attempts ?? 0),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: Number(row.created_at),
    nextRetryAt: row.next_retry_at === null || row.next_retry_at === undefined ? null : Number(row.next_retry_at),
  };
}

function toDraft(row: ImLanOutboxRow): ImLanDraft {
  return {
    deliveryId: row.deliveryId,
    localMessageId: row.localMessageId,
    threadId: row.threadId,
    peerServerId: row.peerServerId,
    peerAgentId: row.peerAgentId,
    body: row.body,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.createdAt,
    nextRetryAt: row.nextRetryAt,
  };
}

export class ImLanOutbox {
  readonly #db: DatabaseSync;
  readonly #localServerId: string;
  readonly #messages: ImMessageStore;
  readonly #deliver: ImLanDeliverPort;

  constructor(db: DatabaseSync, localServerId: string, deliver: ImLanDeliverPort) {
    this.#db = db;
    this.#localServerId = localServerId;
    this.#messages = new ImMessageStore(db);
    this.#deliver = deliver;
  }

  drafts(memberId: string, input: { threadId?: string } = {}): ImLanDraft[] {
    return this.#rows(
      `d.local_member_id = ?${input.threadId === undefined ? "" : " AND m.thread_id = ?"}`,
      [memberId, ...(input.threadId === undefined ? [] : [input.threadId])],
      true,
    ).map(toDraft);
  }

  async markUndelivered(
    memberId: string,
    input: { deliveryId: string; at: number; error?: string },
  ): Promise<ImLanDraft | null> {
    const row = this.#find(memberId, input.deliveryId);
    if (!row) return null;
    const error = input.error ?? IM_LAN_PEER_OFFLINE;
    if (!this.#fail(row, input.at, error)) throw new ImDeliveryDelivered();
    return toDraft(this.#find(memberId, input.deliveryId) ?? row);
  }

  async resend(memberId: string, input: { deliveryId: string; at: number }): Promise<ImLanResendResult> {
    const row = this.#find(memberId, input.deliveryId);
    if (!row) throw new ImLanUndelivered("im.notDelivered");
    return this.#attempt(row, input.at);
  }

  async onPeerOnline(input: { peerServerId: string; peerAgentId: string; at: number }): Promise<ImLanResendResult[]> {
    const rows = this.#rows(
      `d.peer_server_id = ? AND d.peer_agent_id = ?`,
      [input.peerServerId, input.peerAgentId],
      true,
    );
    const results: ImLanResendResult[] = [];
    for (const row of rows) results.push(await this.#attempt(row, input.at));
    return results;
  }

  async #attempt(row: ImLanOutboxRow, at: number): Promise<ImLanResendResult> {
    const delivery = this.#messages.readDelivery(row.deliveryId);
    const state = delivery ? delivery.state : "submitted";
    if (delivery && (state === "persisted" || state === "acked" || state === "read")) {
      return this.#after(row, "skipped-delivered");
    }
    if (row.withdrawnAt !== null) {
      this.#messages.discardDelivery(row.deliveryId, "im.messageWithdrawn");
      return this.#after(row, "skipped-withdrawn");
    }
    try {
      await this.#deliver({
        deliveryId: row.deliveryId,
        memberId: row.localMemberId,
        remoteMessageId: row.remoteMessageId,
        threadId: row.threadId,
        peerServerId: row.peerServerId,
        peerAgentId: row.peerAgentId,
        body: row.body,
        nonce: row.nonce,
        sentAt: row.sentAt,
      });
    } catch (error) {
      const reason = error instanceof ImLanUndelivered ? error.reason : imErrorOf(error);
      if (!this.#fail(row, at, reason)) return this.#after(row, "skipped-delivered");
      return this.#after(row, "still-undelivered");
    }
    this.#messages.bumpAttempts(row.deliveryId);
    this.#messages.setDeliveryState(row.deliveryId, "submitted", at);
    this.#messages.setDeliveryState(row.deliveryId, "persisted", at);
    return this.#after(row, "delivered");
  }

  #find(memberId: string, deliveryId: string): ImLanOutboxRow | undefined {
    return this.#rows(`d.local_member_id = ? AND d.delivery_id = ?`, [memberId, deliveryId], false)[0];
  }

  #fail(row: ImLanOutboxRow, at: number, error: string): boolean {
    const marked = this.#messages.markUndelivered(row.deliveryId, {
      error,
      nextRetryAt: at + IM_LAN_RETRY_BACKOFF_MS,
    });
    if (!marked) return false;
    this.#messages.bumpAttempts(row.deliveryId);
    return true;
  }

  #after(row: ImLanOutboxRow, outcome: ImLanResendOutcome): ImLanResendResult {
    const delivery = this.#messages.readDelivery(row.deliveryId);
    return {
      deliveryId: row.deliveryId,
      localMessageId: row.localMessageId,
      peerServerId: row.peerServerId,
      peerAgentId: row.peerAgentId,
      outcome,
      state: delivery ? delivery.state : "submitted",
      attempts: delivery ? delivery.attempts : row.attempts,
      error: delivery ? delivery.error : null,
    };
  }

  #rows(where: string, params: (string | number)[], pendingOnly: boolean): ImLanOutboxRow[] {
    const pending = `d.state = 'failed' AND NOT (${IM_LAN_WITHDRAWN})`;
    return databaseRows(
      this.#db
        .prepare(
          `SELECT ${IM_LAN_OUTBOX_COLUMNS}
           FROM im_deliveries d
           JOIN im_messages m
             ON m.local_message_id = d.local_message_id AND m.local_server_id = d.local_server_id
            AND m.local_member_id = d.local_member_id
           WHERE d.local_server_id = ?${pendingOnly ? ` AND ${pending}` : ""} AND ${where}
           ORDER BY d.created_at, d.delivery_id`,
        )
        .all(this.#localServerId, ...params),
    ).map(readRow);
  }
}

function imErrorOf(error: unknown): string {
  return error instanceof Error && error.message.startsWith("im.") ? error.message : IM_LAN_PEER_OFFLINE;
}
