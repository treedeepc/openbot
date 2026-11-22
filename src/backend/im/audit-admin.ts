import type { DatabaseSync } from "node:sqlite";
import { databaseRow, databaseRows } from "../database/database-rows";

export interface ImAuditAdminScope {
  localServerId: string;
  localMemberId: string;
}

export const IM_AUDIT_RETENTION_DAYS = 180;
export const IM_AUDIT_ROLLUP_TARGET = "*";
const MS_PER_DAY = 86_400_000;

export interface ImAuditAggregate {
  bucket: string;
  actorId: string;
  action: string;
  targetId: string;
  result: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

export interface ImAuditPurgeResult {
  deletedEntries: number;
  deletedBuckets: number;
  cutoff: number;
  purgeEventId: string;
}

export class ImAuditAdmin {
  readonly #db: DatabaseSync;
  readonly #localServerId: string;

  constructor(db: DatabaseSync, localServerId: string) {
    this.#db = db;
    this.#localServerId = localServerId;
  }

  bucketOf(at: number): string {
    return new Date(at).toISOString().slice(0, 10);
  }

  aggregate(memberId: string): ImAuditAggregate[] {
    const rows = databaseRows(
      this.#db
        .prepare(
          `SELECT actor_id, action, target_id, result, at FROM audit_log
           WHERE local_server_id = ? AND local_member_id = ? ORDER BY at, id`,
        )
        .all(this.#localServerId, memberId),
    );
    for (const row of rows) {
      const at = Number(row.at);
      this.#db
        .prepare(
          `INSERT INTO audit_aggregates (local_server_id, local_member_id, bucket, actor_id, action, target_id, result,
            count, first_at, last_at, summary)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
           ON CONFLICT(local_server_id, local_member_id, bucket, actor_id, action, target_id, result) DO UPDATE SET
             count = audit_aggregates.count + 1, first_at = MIN(audit_aggregates.first_at, excluded.first_at),
             last_at = MAX(audit_aggregates.last_at, excluded.last_at)`,
        )
        .run(
          this.#localServerId,
          memberId,
          this.bucketOf(at),
          String(row.actor_id),
          String(row.action),
          IM_AUDIT_ROLLUP_TARGET,
          String(row.result),
          at,
          at,
        );
    }
    return this.aggregates(memberId);
  }

  aggregates(memberId: string): ImAuditAggregate[] {
    return databaseRows(
      this.#db
        .prepare(
          `SELECT bucket, actor_id, action, target_id, result, count, first_at, last_at FROM audit_aggregates
           WHERE local_server_id = ? AND local_member_id = ? ORDER BY bucket, actor_id, action, target_id`,
        )
        .all(this.#localServerId, memberId),
    ).map((row) => ({
      bucket: String(row.bucket),
      actorId: String(row.actor_id),
      action: String(row.action),
      targetId: String(row.target_id),
      result: String(row.result),
      count: Number(row.count),
      firstAt: Number(row.first_at),
      lastAt: Number(row.last_at),
    }));
  }

  purge(memberId: string, input: { at: number; retentionDays?: number }): ImAuditPurgeResult {
    const retentionDays = input.retentionDays ?? IM_AUDIT_RETENTION_DAYS;
    const cutoff = input.at - retentionDays * MS_PER_DAY;
    const purgeEventId = `purge-${input.at}`;
    this.#db
      .prepare(
        `INSERT INTO audit_log (local_server_id, local_member_id, id, actor_id, source_trust_domain, action,
          target_id, result, correlation_id, causal_chain_id, before, after, at, redacted_detail)
         VALUES (?, ?, ?, 'system', 'local', 'im.auditPurge', 'audit_log', 'ok', ?, NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        this.#localServerId,
        memberId,
        purgeEventId,
        purgeEventId,
        JSON.stringify({ cutoff, retentionDays }),
        input.at,
      );
    const deletedEntries = Number(
      this.#db
        .prepare("DELETE FROM audit_log WHERE local_server_id = ? AND local_member_id = ? AND at < ? AND id <> ?")
        .run(this.#localServerId, memberId, cutoff, purgeEventId).changes,
    );
    const deletedBuckets = Number(
      this.#db
        .prepare("DELETE FROM audit_aggregates WHERE local_server_id = ? AND local_member_id = ? AND last_at < ?")
        .run(this.#localServerId, memberId, cutoff).changes,
    );
    return { deletedEntries, deletedBuckets, cutoff, purgeEventId };
  }

  export(memberId: string, input: { from: number | null; to: number | null; format: "json" | "csv" }): string {
    const rows = databaseRows(
      this.#db
        .prepare(
          `SELECT id, actor_id, source_trust_domain, action, target_id, result, correlation_id, causal_chain_id, before, after, at
           FROM audit_log WHERE local_server_id = ? AND local_member_id = ?
             AND (? IS NULL OR at >= ?) AND (? IS NULL OR at <= ?) ORDER BY at, id`,
        )
        .all(this.#localServerId, memberId, input.from, input.from, input.to, input.to),
    );
    const entries = rows.map((row) => ({
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
    }));
    if (input.format === "json") return JSON.stringify({ entries, count: entries.length });
    const header = "id,actorId,sourceTrustDomain,action,targetId,result,correlationId,causalChainId,before,after,at";
    const lines = entries.map((entry) =>
      [
        entry.id,
        entry.actorId,
        entry.sourceTrustDomain,
        entry.action,
        entry.targetId,
        entry.result,
        entry.correlationId,
        entry.causalChainId ?? "",
        entry.before ?? "",
        entry.after ?? "",
        String(entry.at),
      ].join(","),
    );
    return [header, ...lines].join("\n");
  }

  count(memberId: string): number {
    const row = databaseRow(
      this.#db
        .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE local_server_id = ? AND local_member_id = ?")
        .get(this.#localServerId, memberId),
    );
    return row ? Number(row.n) : 0;
  }
}
