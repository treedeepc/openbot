import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImDuplicateMessage, ImMessageStore, type ImStoredMessage } from "../src/backend/im/messages";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-messages-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: "2026-11-21T00:00:00.000Z" });
const store = new ImMessageStore(db);

const base = {
  localServerId: "srv-1",
  localMemberId: "me",
  peerServerId: "srv-2",
  peerAgentId: "agent-peer",
};
const message: ImStoredMessage = {
  ...base,
  localMessageId: "lm-1",
  threadId: "th-1",
  remoteMessageId: "rm-1",
  senderKind: "self",
  senderAgentId: null,
  deviceId: "device-a",
  body: "hello",
  causalChainId: "chain-1",
  proxiedBy: null,
  proxyVisibility: null,
  nonce: "n-1",
  signature: "sig-1",
  verified: true,
  sentAt: 1,
  expiresAt: 2,
};

db.exec("PRAGMA foreign_keys = OFF");
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state) VALUES (?, ?, ?, ?, ?, 'open')",
).run("srv-1", "me", "th-1", "srv-2", "agent-peer");
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state) VALUES (?, ?, ?, ?, ?, 'open')",
).run("srv-1", "me", "th-other", "srv-3", "agent-other");
db.exec("PRAGMA foreign_keys = ON");
store.insertMessage(message);
const read = store.readMessage(base.localServerId, base.localMemberId, "lm-1");
check(
  "A16a im_messages 写入后读回一致",
  read?.body === "hello" && read?.remoteMessageId === "rm-1",
  JSON.stringify(read?.body),
);
check("A16a 读回保留因果链与签名", read?.causalChainId === "chain-1" && read?.signature === "sig-1", "");
check("A16a 读回保留发送者与设备", read?.senderKind === "self" && read?.deviceId === "device-a", "");
check("A16a 列表按线程读取", store.listMessages(base.localServerId, base.localMemberId, "th-1").length === 1, "");
check("A16a 跨线程隔离", store.listMessages(base.localServerId, base.localMemberId, "th-other").length === 0, "");

store.insertDelivery({
  ...base,
  deliveryId: "dl-1",
  localMessageId: "lm-1",
  createdAt: 1,
});
const submitted = store.readDelivery("dl-1");
check("A16a 状态机 1 本地已提交", submitted?.state === "submitted", submitted?.state);

store.setDeliveryState("dl-1", "persisted", 2);
const persisted = store.readDelivery("dl-1");
check("A16a 状态机 2 服务端已持久化", persisted?.state === "persisted", persisted?.state);

store.setDeliveryState("dl-1", "acked", 3);
const acked = store.readDelivery("dl-1");
check("A16a 状态机 3 对端已收下", acked?.state === "acked" && acked?.ackedAt === 3, JSON.stringify(acked?.state));

store.setDeliveryState("dl-1", "persisted", 4);
check("A16b 已收下不回退到已持久化", store.readDelivery("dl-1")?.state === "acked", store.readDelivery("dl-1")?.state);

const dedup = {
  ...base,
  remoteMessageId: "rm-2",
  deviceId: "device-a",
  nonce: "n-2",
  receivedAt: 5,
};
check("A16b 去重表初判非重复", store.hasDuplicate(dedup) === false, "");
store.markDuplicate(dedup);
check("A16b 去重表写入后判重复", store.hasDuplicate(dedup) === true, "");

let duplicateRefused = false;
try {
  store.markDuplicate(dedup);
} catch (error) {
  duplicateRefused =
    error instanceof ImDuplicateMessage || (error instanceof Error && error.name === "ImDuplicateMessage");
}
check("A16b 重复投递被拒（im.duplicateMessage）", duplicateRefused, "");

const sameRemoteDifferentNonce = { ...dedup, nonce: "n-3" };
check("A16b 同 remoteMessageId 不同 nonce 不算重复", store.hasDuplicate(sameRemoteDifferentNonce) === false, "");
store.markDuplicate(sameRemoteDifferentNonce);

const sameRemoteDifferentDevice = { ...dedup, deviceId: "device-b" };
check("A16b 同 remoteMessageId 不同设备不算重复", store.hasDuplicate(sameRemoteDifferentDevice) === false, "");
store.markDuplicate(sameRemoteDifferentDevice);

const sameRemoteDifferentPeer = { ...dedup, peerAgentId: "agent-other" };
check("A16b 不同发送方同 remoteMessageId 互不影响", store.hasDuplicate(sameRemoteDifferentPeer) === false, "");

const otherMember = { ...dedup, localMemberId: "other" };
check("A16b 不同成员作用域互不影响", store.hasDuplicate(otherMember) === false, "");

const roundTrip = store.readMessage(base.localServerId, base.localMemberId, "lm-1");
check("A16a 去重与状态机之后消息仍在", roundTrip?.localMessageId === "lm-1", "");

check("A16b 迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");

db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
