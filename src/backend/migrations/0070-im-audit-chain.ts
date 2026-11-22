import type { DatabaseSync } from "node:sqlite";
import type { OpenBotMigration } from "./migration";
import { isDynamicRecord, isString } from "./runtime-values";

export const IM_AUDIT_CHAIN_TABLE = "audit_log";
export const IM_AUDIT_CHAIN_COLUMN_SQL = "causal_chain_id TEXT";

function columnNames(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .flatMap((column) => (isDynamicRecord(column) && isString(column.name) ? [column.name] : [])),
  );
}

export function addImAuditChainColumn(db: DatabaseSync): void {
  if (columnNames(db, IM_AUDIT_CHAIN_TABLE).has("causal_chain_id")) return;
  db.exec(`ALTER TABLE ${IM_AUDIT_CHAIN_TABLE} ADD COLUMN ${IM_AUDIT_CHAIN_COLUMN_SQL}`);
}

export const migration: OpenBotMigration = {
  version: 70,
  name: "im-audit-chain",
  up: addImAuditChainColumn,
};
