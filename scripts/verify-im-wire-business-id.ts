import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImService } from "../src/backend/im/im-service";
import { decodeImWireFrame, ImWireForwarder, type ImWireFrame, ImWireRejected } from "../src/backend/im/wire";
import { ImWithdrawService } from "../src/backend/im/withdraw";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { count, itemAt, record, text } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

function rejects(name: string, run: () => unknown): void {
  let reason = "";
  try {
    run();
  } catch (error) {
    reason = error instanceof ImWireRejected ? error.reason : error instanceof Error ? error.name : String(error);
  }
  check(name, reason === "im.protocolError", reason || "没有报错");
}

const at = 1_700_000_000_000;
const root = await mkdtemp(join(tmpdir(), "im-wire-biz-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1','me','th-1','srv-2','agent-peer','open',NULL)",
).run();
db.prepare(
  "INSERT INTO peers (peer_server_id, peer_agent_id, public_key, display_name, verified_at, first_seen_at, last_seen_at) VALUES ('srv-2','agent-peer','pk-peer','Peer',NULL,1,NULL)",
).run();
db.prepare(
  "INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status, cert_ref, enrolled_at, revoked_at, pairing_expires_at, pairing_code) VALUES ('srv-1','me','device-a','pk','active',NULL,1,NULL,NULL,NULL)",
).run();
db.exec("PRAGMA foreign_keys = ON");

const service = new ImService(db, "srv-1");
const sent = service.sendFromClient("me", {
  threadId: "th-1",
  remoteMessageId: "rm-biz-1",
  body: "body-1",
  attachments: [],
  replyTo: null,
  proxiedBy: null,
  proxyVisibility: null,
  at,
});
const stored = record(
  db
    .prepare(
      "SELECT remote_message_id, nonce FROM im_messages WHERE local_server_id = ? AND local_member_id = ? AND local_message_id = ?",
    )
    .get("srv-1", "me", sent.localMessageId),
);
const businessId = text(stored.remote_message_id);
const frameNonce = text(stored.nonce);

process.stdout.write(`\n== 对照 1：旧帧（只有 nonce）仍能解且能投 ==\n`);
const legacyFrame = {
  type: "forward",
  fromServerId: "srv-2",
  fromAgentId: "agent-peer",
  toServerId: "srv-1",
  toAgentId: "me",
  sealed: "ciphertext-old",
  nonce: frameNonce,
  sentAt: at,
};
const legacyDecoded = decodeImWireFrame(legacyFrame);
check(
  "对照1 旧帧真走一遍解码：不带 remoteMessageId 的帧不被拒",
  legacyDecoded.sealed === "ciphertext-old" && legacyDecoded.nonce === frameNonce,
  `${legacyDecoded.sealed} / ${legacyDecoded.nonce}`,
);
check(
  "对照1 旧帧回落到 nonce 做业务 id",
  legacyDecoded.remoteMessageId === frameNonce,
  `remoteMessageId=${legacyDecoded.remoteMessageId} nonce=${frameNonce}`,
);

const forwarder = new ImWireForwarder(db, "srv-1");
const legacyOut = forwarder.forward("me", {
  frame: legacyFrame,
  deviceIds: ["device-a"],
  at,
  expiresAt: at + 86_400_000,
  chain: null,
});
const legacyQueueId = itemAt(legacyOut.outcomes, 0).queueId;
check("对照1 旧帧仍能投：真的入队了", itemAt(legacyOut.outcomes, 0).queued === true, legacyQueueId);
const legacyRow = record(
  db.prepare("SELECT remote_message_id FROM offline_queue WHERE queue_id = ?").get(legacyQueueId),
);
check(
  "对照1 旧帧队列行存的是 nonce",
  text(legacyRow.remote_message_id) === frameNonce,
  `remote_message_id=${text(legacyRow.remote_message_id)}`,
);

process.stdout.write(`\n== 对照 2：新帧带业务 id，队列行存的是业务 id ==\n`);
const newFrame: ImWireFrame = {
  type: "forward",
  fromServerId: "srv-2",
  fromAgentId: "agent-peer",
  toServerId: "srv-1",
  toAgentId: "me",
  sealed: "ciphertext-new",
  nonce: `${frameNonce}-retry`,
  remoteMessageId: businessId,
  sentAt: at,
};
const newDecoded = decodeImWireFrame(newFrame);
check(
  "对照2 新帧解出的就是业务 id，不是 nonce",
  newDecoded.remoteMessageId === businessId && newDecoded.nonce === `${frameNonce}-retry`,
  `remoteMessageId=${newDecoded.remoteMessageId} nonce=${newDecoded.nonce}`,
);
const newOut = forwarder.forward("me", {
  frame: newFrame,
  deviceIds: ["device-a"],
  at,
  expiresAt: at + 86_400_000,
  chain: null,
});
const newQueueId = itemAt(newOut.outcomes, 0).queueId;
const newRow = record(db.prepare("SELECT remote_message_id FROM offline_queue WHERE queue_id = ?").get(newQueueId));
check(
  "对照2 新帧队列行存的是业务 id",
  text(newRow.remote_message_id) === businessId,
  `remote_message_id=${text(newRow.remote_message_id)}`,
);
check(
  "对照2 两种队列行此刻都在库里",
  count(record(db.prepare("SELECT COUNT(*) AS n FROM offline_queue").get()).n) === 2,
  "",
);

process.stdout.write(`\n== 对照 3：撤回对两种队列行都清 ==\n`);
const withdraw = new ImWithdrawService(db, "srv-1");
const result = withdraw.withdraw("me", {
  threadId: "th-1",
  localMessageId: sent.localMessageId,
  at: at + 10,
});
const remaining = count(record(db.prepare("SELECT COUNT(*) AS n FROM offline_queue").get()).n);
check("对照3 撤回说清了队列", result.queueRemoved === true, String(result.queueRemoved));
check(
  "对照3 新帧那行（业务 id）被清",
  remaining === 0 && !db.prepare("SELECT queue_id FROM offline_queue WHERE queue_id = ?").get(newQueueId),
  `剩余 ${remaining} 行`,
);
check(
  "对照3 旧帧那行（只有 nonce）也被清，不是只清新帧",
  !db.prepare("SELECT queue_id FROM offline_queue WHERE queue_id = ?").get(legacyQueueId),
  `剩余 ${remaining} 行`,
);

process.stdout.write(`\n== 对照 4：多塞未知字段仍拒（fail-closed 没被放松）==\n`);
rejects("对照4 塞未知字段拒", () => decodeImWireFrame({ ...newFrame, extra: 1 }));
rejects("对照4 旧帧塞未知字段也拒", () => decodeImWireFrame({ ...legacyFrame, extra: "x" }));
rejects("对照4 remoteMessageId 空串拒", () => decodeImWireFrame({ ...newFrame, remoteMessageId: "" }));
rejects("对照4 remoteMessageId 非字符串拒", () => decodeImWireFrame({ ...newFrame, remoteMessageId: 42 }));
rejects("对照4 帧里塞 remote_message_id 蛇形字段拒", () =>
  decodeImWireFrame({ ...newFrame, remote_message_id: businessId }),
);
check(
  "对照4 加了 remoteMessageId 之后，旧字段校验一个没少",
  (() => {
    try {
      decodeImWireFrame({ ...newFrame, nonce: "" });
      return false;
    } catch (error) {
      return error instanceof ImWireRejected;
    }
  })(),
  "",
);

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");
db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
