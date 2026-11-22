import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as roles from "../src/backend/im/channel-roles";
import { ImNotificationService } from "../src/backend/im/notifications";
import * as proxy from "../src/backend/im/proxy";
import { ImOfflineQueue } from "../src/backend/im/server-mode";
import { IM_WITHDRAW_WINDOW_MS, ImWithdrawService } from "../src/backend/im/withdraw";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { record } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
function threw(name: string, run: () => unknown, expected: string): void {
  let code = "";
  try {
    run();
  } catch (error) {
    code = error instanceof Error ? error.name : String(error);
  }
  check(name, code === expected, code || "没有报错");
}

const root = await mkdtemp(join(tmpdir(), "im-r13-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
const scope = { localServerId: "srv-1", localMemberId: "me" };
const peer = { peerServerId: "srv-2", peerAgentId: "agent-peer" };
const admin = { peerServerId: "srv-1", peerAgentId: "admin" };
const outsider = { peerServerId: "srv-3", peerAgentId: "agent-out" };
const at = 1_700_000_000_000;
const threadSeeds: { threadId: string; serverId: string; agentId: string }[] = [
  { threadId: "th-1", serverId: "srv-2", agentId: "agent-peer" },
  { threadId: "th-2", serverId: "srv-4", agentId: "agent-b" },
];
for (const seed of threadSeeds) {
  db.prepare(
    "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1', 'me', ?, ?, ?, 'open', NULL)",
  ).run(seed.threadId, seed.serverId, seed.agentId);
}
db.prepare(
  "INSERT INTO peers (peer_server_id, peer_agent_id, public_key, display_name, verified_at, first_seen_at, last_seen_at) VALUES ('srv-2', 'agent-peer', 'pk', 'Mira', 1, 1, 1)",
).run();
db.prepare(
  "INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status, cert_ref, enrolled_at, revoked_at, pairing_expires_at, pairing_code) VALUES ('srv-1', 'me', 'device-a', 'pk', 'active', NULL, 1, NULL, NULL, NULL)",
).run();
db.exec("PRAGMA foreign_keys = ON");

const channels = new roles.ImChannelRoles(db, "srv-1");
channels.add("me", { channelId: "ch-1", peer: admin, role: "admin", addedBy: admin, at, verified: true });
check("T10 频道：建管理员", channels.roleOf("me", "ch-1", admin) === "admin", "");
channels.add("me", { channelId: "ch-1", peer, role: "member", addedBy: admin, at: at + 1, verified: true });
check("T10 频道：管理员可加人", channels.roleOf("me", "ch-1", peer) === "member", "");
check(
  "T10 频道：三角色可读",
  channels
    .list("me", "ch-1")
    .items.map((m) => m.role)
    .sort()
    .join(",") === "admin,member",
  "",
);
threw(
  "T10 频道：外部成员不能拉人",
  () =>
    channels.add("me", {
      channelId: "ch-1",
      peer: outsider,
      role: "member",
      addedBy: peer,
      at: at + 2,
      verified: true,
    }),
  "ImExternalCannotInvite",
);
channels.add("me", { channelId: "ch-1", peer: outsider, role: "readonly", addedBy: admin, at: at + 3, verified: true });
threw(
  "T10 频道：readonly 不能拉人",
  () =>
    channels.add("me", {
      channelId: "ch-1",
      peer: { peerServerId: "srv-9", peerAgentId: "agent-x" },
      role: "member",
      addedBy: outsider,
      at: at + 3,
      verified: true,
    }),
  "ImExternalCannotInvite",
);
const unverified = { peerServerId: "srv-5", peerAgentId: "agent-new" };
threw(
  "M2-02 未验证不能进频道",
  () =>
    channels.add("me", {
      channelId: "ch-1",
      peer: unverified,
      role: "member",
      addedBy: admin,
      at: at + 4,
      verified: false,
    }),
  "ImPeerUnverified",
);
check(
  "对照组：同一个人验证后可进",
  channels.add("me", {
    channelId: "ch-1",
    peer: unverified,
    role: "member",
    addedBy: admin,
    at: at + 5,
    verified: true,
  }).role === "member",
  "",
);
threw(
  "T10 频道：改角色要 admin",
  () => channels.changeRole("me", { channelId: "ch-1", peer, role: "readonly", by: peer }),
  "ImChannelForbidden",
);
check(
  "T10 频道：admin 改角色",
  channels.changeRole("me", { channelId: "ch-1", peer, role: "readonly", by: admin }).role === "readonly",
  "",
);
check(
  "T10 频道：三角色齐（admin/member/readonly）",
  channels.list("me", "ch-1").items.some((m) => m.role === "readonly"),
  "",
);
check("T10 频道：踢人", channels.remove("me", { channelId: "ch-1", peer: outsider, by: admin }) === true, "");
threw(
  "T10 频道：最后一个 admin 不能被降级",
  () => channels.changeRole("me", { channelId: "ch-1", peer: admin, role: "member", by: admin }),
  "ImChannelForbidden",
);
threw(
  "T10 频道：最后一个 admin 不能被踢",
  () => channels.remove("me", { channelId: "ch-1", peer: admin, by: admin }),
  "ImChannelForbidden",
);

const withdraw = new ImWithdrawService(db, "srv-1");
db.prepare(
  "INSERT INTO im_messages (local_server_id, local_member_id, local_message_id, thread_id, remote_message_id, peer_server_id, peer_agent_id, sender_kind, sender_agent_id, device_id, body, causal_chain_id, proxied_by, proxy_visibility, nonce, signature, verified, sent_at, expires_at) VALUES ('srv-1','me','lm-1','th-1','rm-1','srv-2','agent-peer','self',NULL,NULL,'hello',NULL,NULL,NULL,'n','s',1,?,?)",
).run(at, at + 86_400_000);
const withdrawn = withdraw.withdraw("me", {
  threadId: "th-1",
  localMessageId: "lm-1",
  at: at + 60_000,
  scene: "online",
});
check(
  "T4c 撤回：窗口内可撤",
  withdrawn.tombstone === "im.messageWithdrawn" && withdrawn.notifiedRecipient === true,
  JSON.stringify(withdrawn.scene),
);
check(
  "T4c 墓碑：内容换成墓碑",
  String(record(db.prepare("SELECT body FROM im_messages WHERE local_message_id = 'lm-1'").get()).body) ===
    "im.messageWithdrawn",
  "",
);
check("T4c 墓碑：withdrawn_at 落库", withdraw.tombstone("me", "lm-1")?.withdrawnAt === at + 60_000, "");
db.prepare(
  "INSERT INTO im_messages (local_server_id, local_member_id, local_message_id, thread_id, remote_message_id, peer_server_id, peer_agent_id, sender_kind, sender_agent_id, device_id, body, causal_chain_id, proxied_by, proxy_visibility, nonce, signature, verified, sent_at, expires_at) VALUES ('srv-1','me','lm-2','th-1','rm-2','srv-2','agent-peer','self',NULL,NULL,'edge',NULL,NULL,NULL,'n','s',1,?,?)",
).run(at + 200_000, at + 286_400_000);
check(
  "A5 边界：正好 2:00 可撤",
  withdraw.withdraw("me", {
    threadId: "th-1",
    localMessageId: "lm-2",
    at: at + 200_000 + IM_WITHDRAW_WINDOW_MS,
    scene: "online",
  }).tombstone === "im.messageWithdrawn",
  "",
);
db.prepare(
  "INSERT INTO im_messages (local_server_id, local_member_id, local_message_id, thread_id, remote_message_id, peer_server_id, peer_agent_id, sender_kind, sender_agent_id, device_id, body, causal_chain_id, proxied_by, proxy_visibility, nonce, signature, verified, sent_at, expires_at) VALUES ('srv-1','me','lm-3','th-1','rm-3','srv-2','agent-peer','self',NULL,NULL,'late',NULL,NULL,NULL,'n','s',1,?,?)",
).run(at + 400_000, at + 486_400_000);
threw(
  "A5 边界：2:00+ε 不可撤",
  () =>
    withdraw.withdraw("me", {
      threadId: "th-1",
      localMessageId: "lm-3",
      at: at + 400_000 + IM_WITHDRAW_WINDOW_MS + 1,
      scene: "online",
    }),
  "ImWithdrawExpired",
);
check(
  "对照组：超时那条没被改动",
  String(record(db.prepare("SELECT body FROM im_messages WHERE local_message_id = 'lm-3'").get()).body) === "late",
  "",
);
threw(
  "T4c 撤回：不存在的消息拒",
  () => withdraw.withdraw("me", { threadId: "th-1", localMessageId: "nope", at }),
  "ImMessageMissing",
);

db.prepare(
  "INSERT INTO im_messages (local_server_id, local_member_id, local_message_id, thread_id, remote_message_id, peer_server_id, peer_agent_id, sender_kind, sender_agent_id, device_id, body, causal_chain_id, proxied_by, proxy_visibility, nonce, signature, verified, sent_at, expires_at) VALUES ('srv-1','me','lm-q','th-2','rm-q','srv-4','agent-b','self',NULL,NULL,'queued',NULL,NULL,NULL,'n','s',1,?,?)",
).run(at + 600_000, at + 686_400_000);
db.prepare(
  "INSERT INTO offline_queue (local_server_id, local_member_id, queue_id, peer_server_id, peer_agent_id, recipient_device_id, remote_message_id, sealed_payload, seq, expires_at, acked_at) VALUES ('srv-1','me','q-1','srv-4','agent-b','device-a','lm-q',?,1,?,NULL)",
).run(new Uint8Array([1, 2, 3]), at + 900_000);
check(
  "T4c 四场景：离线队列里的撤回会清队列",
  withdraw.withdraw("me", { threadId: "th-2", localMessageId: "lm-q", at: at + 610_000 }).queueRemoved === true,
  "",
);
check(
  "T4c 四场景：队列里那条已删",
  record(db.prepare("SELECT COUNT(*) AS n FROM offline_queue WHERE queue_id = 'q-1'").get()).n === 0,
  "",
);

const notes = new ImNotificationService(db, "srv-1");
check(
  "T12b 通知：默认全开、不预览",
  notes.defaults("me").notifyOn === "all" && notes.defaults("me").showPreview === false,
  "",
);
notes.setDefaults("me", { notifyOn: "all", showPreview: true });
check("T12b 通知：默认可写可读", notes.defaults("me").showPreview === true, "");
check("T12b 通知：决定要发", notes.decide("me", { threadId: "th-1", at, messageId: "m-1" }).notify === true, "");
notes.setOverride("me", { threadId: "th-1", mutedUntil: at + 10_000, notifyOn: null, showPreview: null });
check(
  "T12b 免打扰：静默期内不发",
  notes.decide("me", { threadId: "th-1", at: at + 5_000, messageId: "m-2" }).reason === "muted",
  "",
);
check(
  "T12b 免打扰：静默期后恢复",
  notes.decide("me", { threadId: "th-1", at: at + 20_000, messageId: "m-3" }).notify === true,
  "",
);
notes.setOverride("me", { threadId: "th-1", mutedUntil: null, notifyOn: "mentions", showPreview: false });
check(
  "T12b 通知：mentions 挡掉非提及",
  notes.decide("me", { threadId: "th-1", at: at + 30_000, messageId: "m-4" }).reason === "no-mention",
  "",
);
check(
  "T12b 通知：提及照发",
  notes.decide("me", { threadId: "th-1", at: at + 30_001, messageId: "m-5", mention: true }).notify === true,
  "",
);
notes.setOverride("me", { threadId: "th-2", mutedUntil: null, notifyOn: "none", showPreview: null });
check(
  "T12b 通知：整线程关闭",
  notes.decide("me", { threadId: "th-2", at: at + 40_000, messageId: "m-6" }).reason === "notify-none",
  "",
);
check(
  "T12b 代聊去重：同一条只通知一次",
  notes.decide("me", { threadId: "th-1", at: at + 50_000, messageId: "m-7", mention: true, proxiedBy: "agent-a" })
    .notify === true &&
    notes.decide("me", { threadId: "th-1", at: at + 50_001, messageId: "m-7", mention: true, proxiedBy: "agent-a" })
      .reason === "duplicate-proxy",
  "",
);
check(
  "T12b 代聊去重：不同消息不受影响",
  notes.decide("me", { threadId: "th-1", at: at + 50_002, messageId: "m-8", mention: true, proxiedBy: "agent-a" })
    .notify === true,
  "",
);
check(
  "T12b 对照组：无代聊不走去重",
  notes.decide("me", { threadId: "th-1", at: at + 50_003, messageId: "m-8", mention: true }).notify === true,
  "",
);

const settings = new proxy.ImProxySettingsStore(db);
check("预算可设：默认 20 美元", settings.read(scope).monthlyBudgetUsd === 20, "");
check("预算可设：默认代聊关闭", settings.read(scope).enabled === false, "");
settings.write(scope, { enabled: true, visibility: "shown", monthlyBudgetUsd: 5, at });
check("预算可设：可写 5 美元", settings.read(scope).monthlyBudgetUsd === 5, "");
check("预算可设：跨实例读回（落库）", new proxy.ImProxySettingsStore(db).read(scope).monthlyBudgetUsd === 5, "");
const speaking = new proxy.ImProxySpeaking(db);
speaking.charge(scope, "srv-2/agent-peer", 400, at);
check(
  "预算可设：上限变成 5 美元生效",
  speaking.canSpeak(scope, "srv-2/agent-peer", 200, at) === false,
  JSON.stringify(speaking.budget(scope, "srv-2/agent-peer", at)),
);
threw(
  "预算可设：非法上限被拒",
  () => settings.write(scope, { enabled: true, visibility: "shown", monthlyBudgetUsd: -1, at }),
  "ImProxyBudgetLimit",
);

const queue = new ImOfflineQueue(db);
queue.enqueue(scope, {
  queueId: "q-x",
  peer,
  recipientDeviceId: "device-a",
  remoteMessageId: "rm-x",
  sealedPayload: new Uint8Array([9]),
  at: at + 700_000,
});
queue.snapshot(scope, { peer, remoteMessageId: "rm-x", recipientDeviceIds: ["device-a"], at: at + 700_000 });
check(
  "excluded 写入方：排除目标",
  queue.exclude(scope, {
    peer,
    remoteMessageId: "rm-x",
    recipientDeviceId: "device-a",
    at: at + 700_001,
    auditId: "audit-1",
  }) === true,
  "",
);
const target = db
  .prepare("SELECT state, excluded_at, audit_id FROM offline_targets WHERE remote_message_id = 'rm-x'")
  .get();
check(
  "excluded 写入方：state/excluded_at/audit_id 齐",
  String(target?.state) === "excluded" &&
    Number(target?.excluded_at) === at + 700_001 &&
    String(target?.audit_id) === "audit-1",
  JSON.stringify(target),
);

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");
db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
