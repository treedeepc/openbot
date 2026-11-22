import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImHostApi } from "../src/backend/im/host-api";
import * as proxy from "../src/backend/im/proxy";
import * as sm from "../src/backend/im/server-mode";
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

const root = await mkdtemp(join(tmpdir(), "im-r15-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
const scope = { localServerId: "srv-1", localMemberId: "me" };
const peer = { peerServerId: "srv-2", peerAgentId: "agent-peer" };
const at = 1_700_000_000_000;
db.prepare(
  "INSERT INTO contacts (local_server_id, local_member_id, contact_id, peer_server_id, peer_agent_id, alias, state, added_at, source, updated_at) VALUES ('srv-1','me','c-1','srv-2','agent-peer',NULL,'accepted',1,NULL,1)",
).run();
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1','me','th-1','srv-2','agent-peer','open',NULL)",
).run();
db.prepare(
  "INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status, cert_ref, enrolled_at, revoked_at, pairing_expires_at, pairing_code) VALUES ('srv-1','me','device-a','pk','active',NULL,1,NULL,NULL,NULL)",
).run();
db.prepare(
  "INSERT INTO im_messages (local_server_id, local_member_id, local_message_id, thread_id, remote_message_id, peer_server_id, peer_agent_id, sender_kind, sender_agent_id, device_id, body, causal_chain_id, proxied_by, proxy_visibility, nonce, signature, verified, sent_at, expires_at) VALUES ('srv-1','me','lm-q','th-1','rm-q','srv-2','agent-peer','self',NULL,NULL,'queued',NULL,NULL,NULL,'n','s',1,?,?)",
).run(at, at + 86_400_000);
db.prepare(
  "INSERT INTO offline_queue (local_server_id, local_member_id, queue_id, peer_server_id, peer_agent_id, recipient_device_id, remote_message_id, sealed_payload, seq, expires_at, acked_at) VALUES ('srv-1','me','q-1','srv-2','agent-peer','device-a','rm-q',?,1,?,NULL)",
).run(new Uint8Array([1, 2]), at + 900_000);
db.prepare(
  "INSERT INTO im_messages (local_server_id, local_member_id, local_message_id, thread_id, remote_message_id, peer_server_id, peer_agent_id, sender_kind, sender_agent_id, device_id, body, causal_chain_id, proxied_by, proxy_visibility, nonce, signature, verified, sent_at, expires_at) VALUES ('srv-1','me','lm-1','th-1','rm-1','srv-2','agent-peer','self',NULL,NULL,'hello',NULL,NULL,NULL,'n','s',1,?,?)",
).run(at + 1_000, at + 86_400_000);
db.exec("PRAGMA foreign_keys = ON");

const withdraw = new ImWithdrawService(db, "srv-1");
const queued = withdraw.withdraw("me", {
  threadId: "th-1",
  localMessageId: "lm-q",
  at: at + 2_000,
  scene: "offline-queue",
});
check("M6-02 撤回·离线队列：清队列生效", queued.queueRemoved === true, JSON.stringify(queued));
check(
  "M6-02 撤回·离线队列：那条已从队列消失",
  record(db.prepare("SELECT COUNT(*) AS n FROM offline_queue WHERE queue_id = 'q-1'").get()).n === 0,
  "",
);
check("M6-02 撤回·离线队列：墓碑已落", withdraw.tombstone("me", "lm-q")?.tombstone === "im.messageWithdrawn", "");
check(
  "对照组：非队列场景撤回行为不变",
  withdraw.withdraw("me", { threadId: "th-1", localMessageId: "lm-1", at: at + 2_001, scene: "online" })
    .queueRemoved === false,
  "",
);
check(
  "对照组：非队列场景不影响别的队列行",
  record(db.prepare("SELECT COUNT(*) AS n FROM offline_queue").get()).n === 0,
  "",
);
threw(
  "对照组：2:00+ε 仍拒",
  () =>
    withdraw.withdraw("me", { threadId: "th-1", localMessageId: "lm-1", at: at + 1_000 + IM_WITHDRAW_WINDOW_MS + 1 }),
  "ImWithdrawExpired",
);

const settings = new proxy.ImProxySettingsStore(db);
check("M4-07 默认 20 美元", settings.read(scope).monthlyBudgetUsd === 20, "");
const written = settings.write(scope, { monthlyBudgetUsd: 5, at: at + 10 });
check("M4-07 只传预算也能写（部分更新）", written.monthlyBudgetUsd === 5, JSON.stringify(written));
check(
  "M4-07 write 后 read 回 5",
  settings.read(scope).monthlyBudgetUsd === 5,
  String(settings.read(scope).monthlyBudgetUsd),
);
check(
  "M4-07 未传字段保留原值",
  settings.read(scope).enabled === false && settings.read(scope).visibility === "shown",
  JSON.stringify(settings.read(scope)),
);
check("M4-07 生效：上限变成 5", new proxy.ImProxySpeaking(db).limitUsd(scope) === 5, "");
const speaking = new proxy.ImProxySpeaking(db);
speaking.charge(scope, "srv-2/agent-peer", 400, at);
check("M4-07 生效：已消耗不回退（spent 仍 4）", speaking.budget(scope, "srv-2/agent-peer", at).spentUsd === 4, "");
check(
  "M4-07 生效：改小上限后剩余额度为 0",
  speaking.budget(scope, "srv-2/agent-peer", at).remainingUsd === 1,
  String(speaking.budget(scope, "srv-2/agent-peer", at).remainingUsd),
);
check("M4-07 生效：后续代聊按新上限判", speaking.canSpeak(scope, "srv-2/agent-peer", 200, at) === false, "");
settings.write(scope, { monthlyBudgetUsd: 50, at: at + 20 });
check("M4-07 生效：调大上限后续可代聊", speaking.canSpeak(scope, "srv-2/agent-peer", 200, at) === true, "");
threw("M4-07 非法上限仍拒", () => settings.write(scope, { monthlyBudgetUsd: -1, at: at + 30 }), "ImProxyBudgetLimit");

const host = new ImHostApi(db, "srv-1", { deactivate: () => {} });
host.writeProxy("me", { monthlyBudgetUsd: 7, at: at + 40 });
check(
  "④ proxySet→proxyGet 读回 7",
  host.readProxy("me").monthlyBudgetUsd === 7,
  String(host.readProxy("me").monthlyBudgetUsd),
);
host.writeNotifications("me", { threadId: "th-1", notifyOn: "mentions", showPreview: true, mutedUntil: at + 100_000 });
const notes = host.readNotifications("me", "th-1");
check(
  "④ notificationsSet→Get 读回",
  notes.threadId === "th-1" &&
    notes.notifyOn === "mentions" &&
    notes.showPreview === true &&
    notes.mutedUntil === at + 100_000,
  JSON.stringify(notes),
);
check("④ notifications 按线程隔离", host.readNotifications("me", "th-2").mutedUntil === null, "");
host.writeNotifications("me", { threadId: null, notifyOn: "none", showPreview: false, mutedUntil: null });
check("④ notifications 全局默认可写（threadId=null）", host.readNotifications("me", null).notifyOn === "none", "");
const profile = host.updateProfile("me", { displayName: "Me", bio: "hello", avatar: null, searchable: true });
check(
  "④ profileUpdate→Get 读回",
  profile.displayName === "Me" && profile.bio === "hello" && profile.searchable === true,
  JSON.stringify(profile),
);
check("④ profile 默认不可被搜索", new ImHostApi(db, "srv-1").readProfile("other-member").searchable === false, "");
host.deactivate("me", at + 50);
check("④ profileDeactivate 清队列并撤证书", host.readProfile("me").displayName === "Me", "");

const presence = new sm.ImPresenceStore(db);
presence.update({ ...peer, state: "online", hidden: false, at: at + 100_000 });
presence.hide(peer, true, at + 100_100);
check("M5-11 同一时钟基准：窗口内仍旧值", presence.visible(scope, peer, at + 100_200).hidden === false, "");
check(
  "M5-11 同一时钟基准：窗口后报 offline",
  presence.visible(scope, peer, at + 100_200 + sm.IM_PRESENCE_THROTTLE_MS).hidden === true,
  "",
);
presence.update({ ...peer, state: "online", hidden: false, at: at + 500_000 });
presence.hide(peer, true, at + 500_010);
presence.visible(scope, peer, at + 500_015);
check("M5-11 修复后：栅格内仍不暴露（防追踪）", presence.visible(scope, peer, at + 500_020).hidden === false, "");
check(
  "M5-11 修复后：中途读过一次，30 秒后仍按栅格刷新",
  presence.visible(scope, peer, at + 500_010 + sm.IM_PRESENCE_THROTTLE_MS).hidden === true,
  "",
);

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");
db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
