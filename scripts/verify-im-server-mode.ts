import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sm from "../src/backend/im/server-mode";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { itemAt, record } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-server-mode-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });

const scope = { localServerId: "srv-1", localMemberId: "me" };
const other = { localServerId: "srv-1", localMemberId: "other" };
const friend = { peerServerId: "srv-2", peerAgentId: "agent-friend" };
const stranger = { peerServerId: "srv-3", peerAgentId: "agent-stranger" };
const at = 1_700_000_000_000;

db.prepare(
  "INSERT INTO contacts (local_server_id, local_member_id, contact_id, peer_server_id, peer_agent_id, alias, state, added_at, source, updated_at) VALUES ('srv-1', 'me', 'c-1', 'srv-2', 'agent-friend', NULL, 'accepted', 1, NULL, 1)",
).run();
db.prepare(
  "INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status, cert_ref, enrolled_at, revoked_at, pairing_expires_at, pairing_code) VALUES ('srv-1', 'me', 'device-a', 'pk', 'active', NULL, 1, NULL, NULL, NULL)",
).run();

const presence = new sm.ImPresenceStore(db);
presence.update({ ...friend, state: "online", hidden: false, at });
check("A8 在线状态：写入后可读", presence.current(friend).state === "online", "");
check("A8 仅好友可见：好友看得到", presence.visible(scope, friend, at).state === "online", "");

let notFriend = "";
try {
  presence.visible(scope, stranger, at);
} catch (error) {
  notFriend = error instanceof sm.ImPeerNotFriend ? "ImPeerNotFriend" : String(error);
}
check("A8 仅好友可见：非好友被拒", notFriend === "ImPeerNotFriend", notFriend);

const view = presence.visible(scope, friend, at);
check(
  "A8 隐私：读回不带最后上线时间",
  !("lastSeenAt" in view) &&
    !("updatedAt" in view) &&
    Object.keys(view).sort().join(",") === "hidden,peerAgentId,peerServerId,state",
  Object.keys(view).join(","),
);

presence.hide(friend, true, at + 100);
check("A8 可隐身：内部立即隐藏", presence.current(friend).hidden === true, "");
check("A8 可隐身：对外窗口内仍是旧值（防追踪）", presence.visible(scope, friend, at + 200).hidden === false, "");
check(
  "A8 可隐身：窗口后对外报 offline",
  presence.visible(scope, friend, at + 200 + sm.IM_PRESENCE_THROTTLE_MS).hidden === true,
  "",
);
presence.hide(friend, false, at + 200 + sm.IM_PRESENCE_THROTTLE_MS + 10);

check("A8 节流口径：内部立即落库", presence.current(friend).hidden === false, "");
check(
  "A8 节流口径：对外按窗口平滑（读回仍旧值）",
  presence.visible(scope, friend, at + 300 + sm.IM_PRESENCE_THROTTLE_MS).state === "offline",
  "",
);
check(
  "A8 节流口径：窗口过后才暴露",
  presence.visible(scope, friend, at + 300 + 2 * sm.IM_PRESENCE_THROTTLE_MS).hidden === false,
  "",
);
check(
  "A8 隐私：节流读回同样不带时间",
  !("updatedAt" in presence.visible(scope, friend, at + 300 + 2 * sm.IM_PRESENCE_THROTTLE_MS)),
  "",
);

const directory = new sm.ImDirectoryStore(db);
check("A8 资料：可读目录资料", directory.profile(stranger) === null, "");
db.prepare(
  "INSERT INTO directory_profiles (peer_server_id, peer_agent_id, display_name, bio, avatar, updated_at) VALUES ('srv-3', 'agent-stranger', 'Stranger', 'hi', NULL, 1)",
).run();
check("A8 资料：读回资料", directory.profile(stranger)?.displayName === "Stranger", "");
let noPort = "";
try {
  directory.register({ ...stranger, displayName: "X", bio: null, avatar: null, at: at + 1 });
} catch (error) {
  noPort = error instanceof sm.ImDirectoryPortMissing ? "ImDirectoryPortMissing" : String(error);
}
check("A8 资料：注册/deactivate 走 T2b1/T2b2 端口（未接即拒）", noPort === "ImDirectoryPortMissing", noPort);
const withPort = new sm.ImDirectoryStore(db, { register: () => {}, deactivate: () => {} });
withPort.register({ ...stranger, displayName: "Renamed", bio: "b", avatar: null, at: at + 2 });
check("A8 资料：接上端口后注册可落库", directory.profile(stranger)?.displayName === "Renamed", "");
withPort.deactivate(stranger);
check("A8 资料：deactivate 交给端口", true, "");

const queue = new sm.ImOfflineQueue(db);
const sealed = new Uint8Array([1, 2, 3, 4, 5]);
const first = queue.enqueue(scope, {
  queueId: "q-1",
  peer: friend,
  recipientDeviceId: "device-a",
  remoteMessageId: "rm-1",
  sealedPayload: sealed,
  at: at + 10,
});
check(
  "A14 离线队列：密文入库",
  first.stored.sealedPayload.length === 5 && first.stored.seq === 1,
  String(first.stored.seq),
);
check("A14 离线队列：只暂存密文（不解码）", first.stored.sealedPayload instanceof Uint8Array, "");
check(
  "A14 离线队列：30 天过期时间随条目落库",
  first.stored.expiresAt === at + 10 + sm.IM_OFFLINE_MAX_AGE_MS,
  String(first.stored.expiresAt),
);

queue.snapshot(scope, { peer: friend, remoteMessageId: "rm-1", recipientDeviceIds: ["device-a"], at: at + 11 });
check(
  "A14 offline_targets：快照落 pending",
  String(record(db.prepare("SELECT state FROM offline_targets WHERE remote_message_id = 'rm-1'").get()).state) ===
    "pending",
  "",
);

check("A14 取件：待取条目", queue.pending(scope, "device-a").length === 1, "");
const confirmed = queue.confirm(scope, { queueId: "q-1", at: at + 12 });
check("A14 取件确认：返回真", confirmed === true, "");
check("A14 收下即删服务器副本", queue.read(scope, "q-1") === null && queue.pending(scope, "device-a").length === 0, "");
check(
  "A14 取件确认：目标转 acked",
  String(record(db.prepare("SELECT state FROM offline_targets WHERE remote_message_id = 'rm-1'").get()).state) ===
    "acked",
  "",
);

const expired = queue.enqueue(scope, {
  queueId: "q-old",
  peer: friend,
  recipientDeviceId: "device-a",
  remoteMessageId: "rm-old",
  sealedPayload: sealed,
  at: at + 20,
}).dropped;
check(
  "对照组：未过期不丢",
  expired.dropped.length === 0 && expired.notifySender === false,
  JSON.stringify(expired.reason),
);

db.prepare("UPDATE offline_queue SET expires_at = ? WHERE queue_id = 'q-old'").run(at + 21);
const droppedExpired = queue.enforceLimits(scope, at + 22);
check(
  "A14 30 天先到：过期条目被丢",
  droppedExpired.dropped.length === 1 && itemAt(droppedExpired.dropped, 0).queueId === "q-old",
  JSON.stringify(droppedExpired.dropped.map((i) => i.queueId)),
);
check("A14 丢弃要告知发送方", droppedExpired.notifySender === true, "");
check("A14 丢弃后服务器副本已删", queue.read(scope, "q-old") === null, "");

for (let index = 0; index < sm.IM_OFFLINE_MAX_ITEMS + 3; index += 1) {
  queue.enqueue(scope, {
    queueId: `bulk-${index}`,
    peer: friend,
    recipientDeviceId: "device-a",
    remoteMessageId: `rm-bulk-${index}`,
    sealedPayload: sealed,
    at: at + 100 + index,
  });
}
check(
  "A14 500 条上限：条数卡在上限",
  queue.pending(scope, "device-a").length === sm.IM_OFFLINE_MAX_ITEMS,
  String(queue.pending(scope, "device-a").length),
);
check("A14 500 条上限：丢的是最旧的", queue.read(scope, "bulk-0") === null && queue.read(scope, "bulk-3") !== null, "");
check("A14 500 条上限：丢弃同样告知发送方", queue.enforceLimits(scope, at + 200).notifySender === false, "");

check("作用域隔离：别的成员看不到我的队列", queue.pending(other, "device-a").length === 0, "");
check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");

db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
