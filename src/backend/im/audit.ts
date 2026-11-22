import type { DatabaseSync } from "node:sqlite";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { databaseRow, databaseRows } from "../database/database-rows";

export interface ImAuditEntry {
  id: string;
  actorId: string;
  sourceTrustDomain: string;
  action: string;
  targetId: string;
  result: string;
  correlationId: string;
  causalChainId?: string | null;
  before: unknown;
  after: unknown;
  at: number;
  detail?: unknown;
}

export interface ImAuditRow {
  id: string;
  actorId: string;
  sourceTrustDomain: string;
  action: string;
  targetId: string;
  result: string;
  correlationId: string;
  causalChainId: string | null;
  before: string | null;
  after: string | null;
  at: number;
  redactedDetail: string | null;
}

export type ImRedactedValue = string | number | boolean | null | ImRedactedValue[] | ImRedactedObject;

export interface ImRedactedObject {
  readonly [key: string]: ImRedactedValue;
}

const SECRET_KEY = /(key|token|secret|password|passphrase|private|signature|seed)/i;
const SECRET_VALUE = /\b[A-Za-z0-9+/=_-]{24,}\b/;

export function redactImValue(value: unknown, depth = 0): ImRedactedValue {
  if (depth > 6) return "[redacted]";
  if (value === null || value === undefined) return null;
  if (isString(value)) return SECRET_VALUE.test(value) ? "[redacted]" : value;
  if (isNumber(value) || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactImValue(item, depth + 1));
  if (isDynamicRecord(value)) {
    const out: Record<string, ImRedactedValue> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactImValue(item, depth + 1);
    }
    return out;
  }
  return "[redacted]";
}

export function redactImText(text: string): string {
  return SECRET_VALUE.test(text) ? "[redacted]" : text;
}

function readRow(row: DynamicRecord): ImAuditRow {
  return {
    id: String(row.id),
    actorId: String(row.actor_id),
    sourceTrustDomain: String(row.source_trust_domain),
    action: String(row.action),
    targetId: String(row.target_id),
    result: String(row.result),
    correlationId: String(row.correlation_id),
    causalChainId: row.causal_chain_id === null ? null : String(row.causal_chain_id),
    before: row.before === null ? null : String(row.before),
    after: row.after === null ? null : String(row.after),
    at: Number(row.at),
    redactedDetail: row.redacted_detail === null ? null : String(row.redacted_detail),
  };
}

export class ImAuditLog {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  record(scope: { localServerId: string; localMemberId: string }, entry: ImAuditEntry): ImAuditRow {
    const row: ImAuditRow = {
      id: entry.id,
      actorId: redactImText(entry.actorId),
      sourceTrustDomain: redactImText(entry.sourceTrustDomain),
      action: redactImText(entry.action),
      targetId: redactImText(entry.targetId),
      result: redactImText(entry.result),
      correlationId: redactImText(entry.correlationId),
      causalChainId: entry.causalChainId ?? null,
      before: entry.before === undefined ? null : JSON.stringify(redactImValue(entry.before)),
      after: entry.after === undefined ? null : JSON.stringify(redactImValue(entry.after)),
      at: entry.at,
      redactedDetail: entry.detail === undefined ? null : JSON.stringify(redactImValue(entry.detail)),
    };
    this.#db
      .prepare(
        `INSERT INTO audit_log (local_server_id, local_member_id, id, actor_id, source_trust_domain, action,
          target_id, result, correlation_id, causal_chain_id, before, after, at, redacted_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope.localServerId,
        scope.localMemberId,
        row.id,
        row.actorId,
        row.sourceTrustDomain,
        row.action,
        row.targetId,
        row.result,
        row.correlationId,
        row.causalChainId,
        row.before,
        row.after,
        row.at,
        row.redactedDetail,
      );
    return row;
  }

  read(scope: { localServerId: string; localMemberId: string }, id: string): ImAuditRow | null {
    const row = databaseRow(
      this.#db
        .prepare("SELECT * FROM audit_log WHERE local_server_id = ? AND local_member_id = ? AND id = ?")
        .get(scope.localServerId, scope.localMemberId, id),
    );
    return row ? readRow(row) : null;
  }

  list(scope: { localServerId: string; localMemberId: string }): ImAuditRow[] {
    return databaseRows(
      this.#db
        .prepare("SELECT * FROM audit_log WHERE local_server_id = ? AND local_member_id = ? ORDER BY at, id")
        .all(scope.localServerId, scope.localMemberId),
    ).map(readRow);
  }

  byCorrelation(scope: { localServerId: string; localMemberId: string }, correlationId: string): ImAuditRow[] {
    return databaseRows(
      this.#db
        .prepare(
          "SELECT * FROM audit_log WHERE local_server_id = ? AND local_member_id = ? AND correlation_id = ? ORDER BY at, id",
        )
        .all(scope.localServerId, scope.localMemberId, correlationId),
    ).map(readRow);
  }
}

export function isImAuditRow(value: unknown): value is ImAuditRow {
  return isDynamicRecord(value) && isString(value.id) && isString(value.action) && isNumber(value.at);
}
