import type { DatabaseSync } from "node:sqlite";
import type { OpenBotMigration } from "./migration";

export const IM_RELAY_SETTINGS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS im_relay_settings (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    exposed_surface TEXT NOT NULL DEFAULT '',
    enabled_at INTEGER, updated_at INTEGER NOT NULL,
    PRIMARY KEY (local_server_id, local_member_id)
  );
`;

export function addImRelaySettingsTable(db: DatabaseSync): void {
  db.exec(IM_RELAY_SETTINGS_SCHEMA_SQL);
}

export const migration: OpenBotMigration = {
  version: 73,
  name: "im-relay-settings",
  up: addImRelaySettingsTable,
};
