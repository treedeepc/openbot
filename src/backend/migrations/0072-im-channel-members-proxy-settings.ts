import type { DatabaseSync } from "node:sqlite";
import type { OpenBotMigration } from "./migration";

export const IM_CHANNEL_AND_PROXY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS im_channel_members (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL,
    channel_id TEXT NOT NULL, peer_server_id TEXT NOT NULL, peer_agent_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','member','readonly')),
    added_by TEXT NOT NULL, added_at INTEGER NOT NULL,
    PRIMARY KEY (local_server_id, local_member_id, channel_id, peer_server_id, peer_agent_id)
  );
  CREATE TABLE IF NOT EXISTS im_proxy_settings (
    local_server_id TEXT NOT NULL, local_member_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL CHECK (visibility IN ('shown','hidden')),
    monthly_budget_usd INTEGER NOT NULL CHECK (monthly_budget_usd >= 0 AND monthly_budget_usd <= 1000),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (local_server_id, local_member_id)
  );
`;

export function addImChannelAndProxyTables(db: DatabaseSync): void {
  db.exec(IM_CHANNEL_AND_PROXY_SCHEMA_SQL);
}

export const migration: OpenBotMigration = {
  version: 72,
  name: "im-channel-members-proxy-settings",
  up: addImChannelAndProxyTables,
};
