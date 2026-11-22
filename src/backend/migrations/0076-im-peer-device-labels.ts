import type { DatabaseSync } from "node:sqlite";
import type { OpenBotMigration } from "./migration";
import { isDynamicRecord, isString } from "./runtime-values";

export const IM_PEER_DEVICE_NAME_SQL = "name TEXT";
export const IM_PEER_DEVICE_ENROLLED_AT_SQL = "enrolled_at INTEGER";

function columnNames(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .flatMap((column) => (isDynamicRecord(column) && isString(column.name) ? [column.name] : [])),
  );
}

export function addImPeerDeviceLabels(db: DatabaseSync): void {
  const names = columnNames(db, "peers_devices");
  if (!names.has("name")) db.exec(`ALTER TABLE peers_devices ADD COLUMN ${IM_PEER_DEVICE_NAME_SQL}`);
  if (!names.has("enrolled_at")) db.exec(`ALTER TABLE peers_devices ADD COLUMN ${IM_PEER_DEVICE_ENROLLED_AT_SQL}`);
}

export const migration: OpenBotMigration = {
  version: 76,
  name: "im-peer-device-labels",
  up: addImPeerDeviceLabels,
};
