import type { DatabaseSync } from "node:sqlite";
import type { OpenBotMigration } from "./migration";
import { isDynamicRecord, isString } from "./runtime-values";

export const IM_PRESENCE_EXPOSED_COLUMNS: readonly (readonly [string, string])[] = [
  ["exposed_state", "TEXT"],
  ["exposed_hidden", "INTEGER"],
  ["exposed_at", "INTEGER"],
];

function columnNames(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .flatMap((column) => (isDynamicRecord(column) && isString(column.name) ? [column.name] : [])),
  );
}

export function addImPresenceExposedColumns(db: DatabaseSync): void {
  const names = columnNames(db, "presence");
  for (const [column, type] of IM_PRESENCE_EXPOSED_COLUMNS) {
    if (names.has(column)) continue;
    db.exec(`ALTER TABLE presence ADD COLUMN ${column} ${type}`);
  }
}

export const migration: OpenBotMigration = {
  version: 73,
  name: "im-presence-exposed",
  up: addImPresenceExposedColumns,
};
