import type { DatabaseSync } from "node:sqlite";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { databaseRow } from "../database/database-rows";
import type { CausalChain } from "./causal-chain";
import { imExecutionDecision } from "./proxy";

export interface ImWireScope {
  localServerId: string;
  localMemberId: string;
}

export const IM_WIRE_TYPES = ["forward", "ack", "presence", "enroll", "receipt", "relay"] as const;
export type ImWireType = (typeof IM_WIRE_TYPES)[number];

export interface ImWirePayload {
  kind: string;
  body: unknown;
}

export function isWirePayload(value: unknown): value is ImWirePayload {
  return isDynamicRecord(value) && typeof value.kind === "string" && value.body !== undefined;
}

export type ImFrameNonce = string;
export type SealedTextBytes = Uint8Array;

export function sealedTextBytes(sealed: string): SealedTextBytes {
  return new TextEncoder().encode(sealed);
}

export function sealedText(bytes: SealedTextBytes): string {
  return new TextDecoder().decode(bytes);
}

export interface ImQueuedFrameRow {
  frameNonce: ImFrameNonce;
  sealedTextBytes: SealedTextBytes;
}

export function queuedFrameRow(row: DynamicRecord): ImQueuedFrameRow {
  return {
    frameNonce: String(row.remote_message_id),
    sealedTextBytes: row.sealed_payload instanceof Uint8Array ? row.sealed_payload : new Uint8Array(),
  };
}

export interface ImWireFrame {
  type: ImWireType;
  fromServerId: string;
  fromAgentId: string;
  toServerId: string;
  toAgentId: string;
  sealed: string;
  nonce: ImFrameNonce;
  remoteMessageId: string;
  sentAt: number;
}

export class ImWireRejected extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "ImWireRejected";
    this.reason = reason;
  }
}

export interface ImForwardOutcome {
  deviceId: string;
  queued: boolean;
  queueId: string;
}

function isWireType(value: unknown): value is ImWireType {
  return typeof value === "string" && IM_WIRE_TYPES.some((type) => type === value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

const IM_WIRE_FRAME_FIELDS = [
  "type",
  "fromServerId",
  "fromAgentId",
  "toServerId",
  "toAgentId",
  "sealed",
  "nonce",
  "remoteMessageId",
  "sentAt",
] as const;

export function decodeImWireFrame(value: unknown): ImWireFrame {
  if (!isDynamicRecord(value)) throw new ImWireRejected("im.protocolError");
  const entry: DynamicRecord = value;
  for (const key of Object.keys(entry)) {
    if (!IM_WIRE_FRAME_FIELDS.some((field) => field === key)) throw new ImWireRejected("im.protocolError");
  }
  if (!isWireType(entry.type)) throw new ImWireRejected("im.protocolError");
  if (!isIdentifier(entry.fromServerId) || !isIdentifier(entry.fromAgentId))
    throw new ImWireRejected("im.protocolError");
  if (!isIdentifier(entry.toServerId) || !isIdentifier(entry.toAgentId)) throw new ImWireRejected("im.protocolError");
  if (typeof entry.sealed !== "string" || entry.sealed.length === 0) throw new ImWireRejected("im.protocolError");
  if (typeof entry.nonce !== "string" || entry.nonce.length === 0) throw new ImWireRejected("im.protocolError");
  if (typeof entry.sentAt !== "number" || !Number.isFinite(entry.sentAt)) throw new ImWireRejected("im.protocolError");
  const remoteMessageId =
    entry.remoteMessageId === undefined
      ? entry.nonce
      : typeof entry.remoteMessageId === "string" && entry.remoteMessageId.length > 0
        ? entry.remoteMessageId
        : null;
  if (remoteMessageId === null) throw new ImWireRejected("im.protocolError");
  return {
    type: entry.type,
    fromServerId: entry.fromServerId,
    fromAgentId: entry.fromAgentId,
    toServerId: entry.toServerId,
    toAgentId: entry.toAgentId,
    sealed: entry.sealed,
    nonce: entry.nonce,
    remoteMessageId,
    sentAt: entry.sentAt,
  };
}

export class ImWireForwarder {
  readonly #db: DatabaseSync;
  readonly #localServerId: string;

  constructor(db: DatabaseSync, localServerId: string) {
    this.#db = db;
    this.#localServerId = localServerId;
  }

  forward(
    memberId: string,
    input: {
      frame: unknown;
      deviceIds: readonly string[];
      at: number;
      expiresAt: number;
      chain?: CausalChain | null;
    },
  ): { outcomes: ImForwardOutcome[]; mayExecuteTools: boolean } {
    const frame = decodeImWireFrame(input.frame);
    const decision = imExecutionDecision(input.chain ?? null);
    const outcomes: ImForwardOutcome[] = [];
    for (const deviceId of input.deviceIds) {
      const queueId = `wq-${frame.nonce}-${deviceId}`;
      this.#db
        .prepare(
          `INSERT INTO offline_queue (local_server_id, local_member_id, queue_id, peer_server_id, peer_agent_id,
            recipient_device_id, remote_message_id, sealed_payload, seq, expires_at, acked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(local_server_id, local_member_id, queue_id) DO NOTHING`,
        )
        .run(
          this.#localServerId,
          memberId,
          queueId,
          frame.fromServerId,
          frame.fromAgentId,
          deviceId,
          frame.remoteMessageId,
          sealedTextBytes(frame.sealed),
          this.#nextSeq(memberId),
          input.expiresAt,
        );
      outcomes.push({ deviceId, queued: true, queueId });
    }
    return { outcomes, mayExecuteTools: decision.mayExecuteTools };
  }

  receive(value: unknown): ImWireFrame {
    return decodeImWireFrame(value);
  }

  accept(memberId: string, frame: ImWireFrame, payload: ImWirePayload): { kind: string; accepted: true } {
    if (!isWirePayload(payload)) throw new ImWireRejected("im.protocolError");
    if (frame.toServerId !== this.#localServerId || frame.toAgentId !== memberId)
      throw new ImWireRejected("im.unauthorized");
    return { kind: payload.kind, accepted: true };
  }

  confirm(memberId: string, input: { queueId: string; at: number }): boolean {
    return (
      this.#db
        .prepare(
          "UPDATE offline_queue SET acked_at = ? WHERE local_server_id = ? AND local_member_id = ? AND queue_id = ?",
        )
        .run(input.at, this.#localServerId, memberId, input.queueId).changes > 0
    );
  }

  #nextSeq(memberId: string): number {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM offline_queue WHERE local_server_id = ? AND local_member_id = ?",
        )
        .get(this.#localServerId, memberId),
    );
    return row ? Number(row.next) : 1;
  }
}

export function isSealedEnvelope(value: unknown): value is { sealed: string; nonce: string } {
  return isDynamicRecord(value) && typeof value.sealed === "string" && typeof value.nonce === "string";
}
