import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IM_SCHEMA_SQL } from "../src/backend/migrations/0068-im";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { record, text } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-migration-"));
const path = join(root, "openbot.db");
const db = new DatabaseSync(path);
db.exec("PRAGMA foreign_keys = ON");

migrateOpenBotDatabase(db);
const fkAfterCreate = db.prepare("PRAGMA foreign_key_check").all();
check("新建库：foreign_key_check 为空", fkAfterCreate.length === 0, JSON.stringify(fkAfterCreate.slice(0, 3)));

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row) => row.name);
const imTables = [
  "audit_aggregates",
  "audit_log",
  "block_rules",
  "causal_chains",
  "contact_requests",
  "contacts",
  "directory_profiles",
  "im_attachments",
  "im_deliveries",
  "im_messages",
  "im_reports",
  "im_thread_assignees",
  "im_threads",
  "local_devices",
  "message_dedup",
  "notification_defaults",
  "notification_overrides",
  "offline_queue",
  "offline_targets",
  "peers",
  "peers_devices",
  "presence",
  "read_state",
  "withdrawn_messages",
];
check(
  "IM 全部 24 张表已建",
  imTables.every((name) => tables.includes(name)),
  `${imTables.filter((name) => !tables.includes(name)).join(",") || "all present"}`,
);

const indexes = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row) => text(row.name));
check(
  "三条必需索引在（完成查询 / expires_at 清理 / message_dedup 唯一键）",
  indexes.includes("offline_targets_done") &&
    indexes.includes("offline_queue_expiry") &&
    indexes.includes("im_thread_primary_uq"),
  indexes.filter((name) => name.startsWith("offline") || name.includes("dedup") || name.includes("primary")).join(","),
);
const dedup = record(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='message_dedup'").get());
check("message_dedup 唯一键已建", String(dedup?.sql).includes("UNIQUE (local_server_id"), "");

const insert = (sql: string) => db.prepare(sql).run();
insert(`INSERT INTO peers (peer_server_id, peer_agent_id, public_key, display_name, first_seen_at)
  VALUES ('srv-a', 'agent-1', 'pk-1', 'Peer One', 1)`);
insert(`INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status)
  VALUES ('srv-local', 'me', 'dev-1', 'lpk-1', 'active')`);
insert(`INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state)
  VALUES ('srv-local', 'me', 'th-1', 'srv-a', 'agent-1', 'open')`);
insert(`INSERT INTO im_messages (local_server_id, local_member_id, local_message_id, thread_id, remote_message_id,
  peer_server_id, peer_agent_id, sender_kind, body, nonce, signature, verified, sent_at, expires_at)
  VALUES ('srv-local', 'me', 'lm-1', 'th-1', 'rm-1', 'srv-a', 'agent-1', 'peer', 'hello', 'n-1', 's-1', 1, 1, 2)`);
insert(`INSERT INTO im_deliveries (local_server_id, local_member_id, delivery_id, local_message_id,
  peer_server_id, peer_agent_id, state, created_at)
  VALUES ('srv-local', 'me', 'dl-1', 'lm-1', 'srv-a', 'agent-1', 'submitted', 1)`);
insert(`INSERT INTO message_dedup (local_server_id, local_member_id, peer_server_id, peer_agent_id,
  remote_message_id, device_id, nonce, received_at)
  VALUES ('srv-local', 'me', 'srv-a', 'agent-1', 'rm-1', 'dev-1', 'n-1', 1)`);
insert(`INSERT INTO offline_targets (local_server_id, local_member_id, peer_server_id, peer_agent_id,
  remote_message_id, recipient_device_id, snapshot_at, state)
  VALUES ('srv-local', 'me', 'srv-a', 'agent-1', 'rm-1', 'dev-1', 1, 'pending')`);
insert(`INSERT INTO offline_queue (local_server_id, local_member_id, queue_id, peer_server_id, peer_agent_id,
  recipient_device_id, remote_message_id, sealed_payload, seq, expires_at)
  VALUES ('srv-local', 'me', 'q-1', 'srv-a', 'agent-1', 'dev-1', 'rm-1', x'00', 1, 2)`);
insert(`INSERT INTO audit_log (local_server_id, local_member_id, id, actor_id, source_trust_domain,
  action, target_id, result, correlation_id, at) VALUES ('srv-local', 'me', 'a-1', 'me', 'local',
  'im.message.send', 'lm-1', 'ok', 'c-1', 1)`);
const countRows = () =>
  [
    "peers",
    "local_devices",
    "im_threads",
    "im_messages",
    "im_deliveries",
    "message_dedup",
    "offline_targets",
    "offline_queue",
    "audit_log",
  ]
    .map((table) => `${table}=${record(db.prepare(`SELECT COUNT(*) c FROM ${table}`).get()).c}`)
    .join(" ");
const before = countRows();
check("fixtures 已写入", before.includes("im_messages=1"), before);

migrateOpenBotDatabase(db);
const fkAfterUpgrade = db.prepare("PRAGMA foreign_key_check").all();
check("二次迁移：foreign_key_check 为空", fkAfterUpgrade.length === 0, JSON.stringify(fkAfterUpgrade.slice(0, 3)));
check("二次迁移：fixtures 行数保持", countRows() === before, `${before} -> ${countRows()}`);

db.exec(IM_SCHEMA_SQL);
check("再跑同一段 schema（新建库尾部路径）：行数保持", countRows() === before, countRows());
check("再跑同一段 schema：foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");

const schemaAfter = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
db.close();
const reopened = new DatabaseSync(path);
reopened.exec("PRAGMA foreign_keys = ON");
migrateOpenBotDatabase(reopened);
const schemaAgain = reopened.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
check(
  "重开后再迁移：schema 无变化",
  JSON.stringify(schemaAfter) === JSON.stringify(schemaAgain),
  `${schemaAfter.length} objects`,
);
check("重开后：foreign_key_check 为空", reopened.prepare("PRAGMA foreign_key_check").all().length === 0, "");
reopened.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
