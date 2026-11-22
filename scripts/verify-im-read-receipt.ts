import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImDeliveryService } from "../src/backend/im/delivery";
import { ImNotificationService } from "../src/backend/im/notifications";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-receipt-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
const at = 1_700_000_000_000;
const threadSeeds: { threadId: string; peerId: string }[] = [
  { threadId: "th-1", peerId: "agent-peer" },
  { threadId: "th-2", peerId: "agent-b" },
  { threadId: "th-3", peerId: "agent-c" },
];
for (const seed of threadSeeds) {
  db.prepare(
    "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1','me',?,'srv-2',?,'open',NULL)",
  ).run(seed.threadId, seed.peerId);
}
const messageSeeds: { id: string; threadId: string; peerId: string }[] = [
  { id: "lm-1", threadId: "th-1", peerId: "agent-peer" },
  { id: "lm-2", threadId: "th-2", peerId: "agent-b" },
  { id: "lm-3", threadId: "th-3", peerId: "agent-c" },
];
for (const seed of messageSeeds) {
  db.prepare(
    "INSERT INTO im_messages (local_server_id, local_member_id, local_message_id, thread_id, remote_message_id, peer_server_id, peer_agent_id, sender_kind, sender_agent_id, device_id, body, causal_chain_id, proxied_by, proxy_visibility, nonce, signature, verified, sent_at, expires_at) VALUES ('srv-1','me',?,?,'rm-x','srv-2',?,'self',NULL,NULL,'hi',NULL,NULL,NULL,'n','s',1,?,?)",
  ).run(seed.id, seed.threadId, seed.peerId, at, at + 86_400_000);
  db.prepare(
    "INSERT INTO im_deliveries (local_server_id, local_member_id, delivery_id, local_message_id, peer_server_id, peer_agent_id, state, attempts, created_at, acked_at) VALUES ('srv-1','me',?,?,'srv-2',?,'persisted',0,?,NULL)",
  ).run(`dl-${seed.id}`, seed.id, seed.peerId, at);
}
db.exec("PRAGMA foreign_keys = ON");

const notes = new ImNotificationService(db, "srv-1");
const delivery = new ImDeliveryService(db, "srv-1");

check("默认：已读回执开启", notes.readReceiptsEnabled("me", "th-1") === true, "");
const on = delivery.markRead("me", { threadId: "th-1", localMessageId: "lm-1", at: at + 10 });
check(
  "开启时：markRead 写 read 态并回报已发",
  on.receiptSent === true && delivery.read("dl-lm-1")?.state === "read",
  JSON.stringify(on),
);
check("开启时：已读水位可读回", delivery.lastRead("me", "th-1") === "lm-1", "");

notes.setOverride("me", {
  threadId: "th-2",
  mutedUntil: null,
  notifyOn: null,
  showPreview: null,
  sendReadReceipts: false,
});
check("关闭后：readReceiptsEnabled 为假", notes.readReceiptsEnabled("me", "th-2") === false, "");
const off = delivery.markRead("me", { threadId: "th-2", localMessageId: "lm-2", at: at + 20 });
check(
  "关闭后：markRead 不写 read 态",
  delivery.read("dl-lm-2")?.state === "persisted",
  String(delivery.read("dl-lm-2")?.state),
);
check("关闭后：不向对方发已读回执", off.receiptSent === false, JSON.stringify(off));
check("关闭后：本地已读水位仍推进（只是不外发）", delivery.lastRead("me", "th-2") === "lm-2", "");
check("对照：别的会话不受影响（th-3 仍默认开）", notes.readReceiptsEnabled("me", "th-3") === true, "");
const onAgain = delivery.markRead("me", { threadId: "th-3", localMessageId: "lm-3", at: at + 30 });
check("对照：默认开会话照常发回执", onAgain.receiptSent === true && delivery.read("dl-lm-3")?.state === "read", "");

notes.setOverride("me", {
  threadId: "th-2",
  mutedUntil: null,
  notifyOn: null,
  showPreview: null,
  sendReadReceipts: true,
});
check("重开开关后恢复发送回执", notes.readReceiptsEnabled("me", "th-2") === true, "");
check("设置跨实例读回（落库）", new ImNotificationService(db, "srv-1").readReceiptsEnabled("me", "th-2") === true, "");

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");
db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
