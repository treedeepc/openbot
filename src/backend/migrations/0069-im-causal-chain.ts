import type { DatabaseSync } from "node:sqlite";
import type { OpenBotMigration } from "./migration";
import { isDynamicRecord, isString } from "./runtime-values";

export const IM_CAUSAL_CHAIN_COLUMN_SQL = "causal_chain_id TEXT";

const IM_CAUSAL_CHAIN_TABLES = [
  "projection_agent_threads",
  "projection_channel_tasks",
  "workflow_runs",
  "workflow_steps",
  "projection_deliveries",
] as const;

export const IM_CAUSAL_CHAIN_TABLE_NAMES: readonly string[] = IM_CAUSAL_CHAIN_TABLES;

function columnNames(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .flatMap((column) => (isDynamicRecord(column) && isString(column.name) ? [column.name] : [])),
  );
}

export function addImCausalChainColumns(db: DatabaseSync): void {
  for (const table of IM_CAUSAL_CHAIN_TABLES) {
    if (columnNames(db, table).has("causal_chain_id")) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${IM_CAUSAL_CHAIN_COLUMN_SQL}`);
  }
}

export const migration: OpenBotMigration = {
  version: 69,
  name: "im-causal-chain",
  up: addImCausalChainColumns,
};
