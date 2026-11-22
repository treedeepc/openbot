import type { DatabaseSync } from "node:sqlite";
import type { OpenBotMigration } from "./migration";
import { isDynamicRecord, isString } from "./runtime-values";

export const IM_PAIRING_CODE_TABLE = "local_devices";
export const IM_PAIRING_CODE_COLUMN_SQL = "pairing_code TEXT";

function columnNames(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .flatMap((column) => (isDynamicRecord(column) && isString(column.name) ? [column.name] : [])),
  );
}

export function addImPairingCodeColumn(db: DatabaseSync): void {
  if (columnNames(db, IM_PAIRING_CODE_TABLE).has("pairing_code")) return;
  db.exec(`ALTER TABLE ${IM_PAIRING_CODE_TABLE} ADD COLUMN ${IM_PAIRING_CODE_COLUMN_SQL}`);
}

export const migration: OpenBotMigration = {
  version: 69,
  name: "im-pairing-code",
  up: addImPairingCodeColumn,
};
