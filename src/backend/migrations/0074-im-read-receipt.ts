import type { DatabaseSync } from "node:sqlite";
import type { OpenBotMigration } from "./migration";
import { isDynamicRecord, isString } from "./runtime-values";

export const IM_READ_RECEIPT_COLUMN_SQL = "send_read_receipts INTEGER";

function columnNames(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .flatMap((column) => (isDynamicRecord(column) && isString(column.name) ? [column.name] : [])),
  );
}

export function addImReadReceiptColumn(db: DatabaseSync): void {
  if (columnNames(db, "notification_overrides").has("send_read_receipts")) return;
  db.exec(`ALTER TABLE notification_overrides ADD COLUMN ${IM_READ_RECEIPT_COLUMN_SQL}`);
}

export const migration: OpenBotMigration = {
  version: 74,
  name: "im-read-receipt",
  up: addImReadReceiptColumn,
};
