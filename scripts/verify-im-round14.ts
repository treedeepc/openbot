import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  IM_CHANNELS_ADMIN_CAPABILITY,
  IM_DELIVERY_CAPABILITY,
  IM_ROUTES_BY_CAPABILITY,
} from "../packages/contracts/src/team-protocol/im-v1";
import { ImDeactivateService } from "../src/backend/im/deactivate";
import { ImDeliveryService } from "../src/backend/im/delivery";
import { ImDeviceStore } from "../src/backend/im/device-store";
import { createImIdentity, ImDeviceRegistry } from "../src/backend/im/identity";
import * as sm from "../src/backend/im/server-mode";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { IM_HANDLED_PATHS } from "../src/main/team-api/route-im";
import { itemAt } from "./verify-im-helpers";

const routesByCapability = new Map<string, readonly string[]>(Object.entries(IM_ROUTES_BY_CAPABILITY));
const routesOf = (capability: string): readonly string[] => routesByCapability.get(capability) ?? [];

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

const root = await mkdtemp(join(tmpdir(), "im-r14-"));
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
db.exec("PRAGMA foreign_keys = ON");

const presence = new sm.ImPresenceStore(db);
presence.update({ ...peer, state: "online", hidden: false, at });
presence.hide(peer, true, at + 10);
check("① 内部立即：隐藏写库即生效", presence.current(peer).hidden === true, "");
check(
  "① 内部立即：current 立刻看到隐藏",
  presence.current(peer).hidden === true,
  JSON.stringify(presence.current(peer)),
);
const exposedAfterToggle = presence.visible(scope, peer, at + 20);
check(
  "① 对外平滑：切换瞬间读回仍是旧值",
  exposedAfterToggle.hidden === false && exposedAfterToggle.state === "online",
  JSON.stringify(exposedAfterToggle),
);
const later = presence.visible(scope, peer, at + 30_000);
check("① 对外平滑：30 秒窗口后才暴露", later.hidden === true && later.state === "offline", JSON.stringify(later));
check("① 防追踪：转换时刻不可观测（只在窗口边界变化）", exposedAfterToggle.hidden !== later.hidden, "");
presence.update({ ...peer, state: "away", hidden: true, at: at + 31_000 });
check("对照组：纯状态更新也按窗口平滑", presence.visible(scope, peer, at + 31_100).state === "offline", "");
check("对照组：内部真值仍立即更新", presence.current(peer).state === "offline", "");
check(
  "① 隐私：读回仍不带最后上线时间",
  !("updatedAt" in later) && Object.keys(later).sort().join(",") === "hidden,peerAgentId,peerServerId,state",
  "",
);

const delivery = new ImDeliveryService(db, "srv-1");
db.prepare(
  "INSERT INTO im_messages (local_server_id, local_member_id, local_message_id, thread_id, remote_message_id, peer_server_id, peer_agent_id, sender_kind, sender_agent_id, device_id, body, causal_chain_id, proxied_by, proxy_visibility, nonce, signature, verified, sent_at, expires_at) VALUES ('srv-1','me','lm-1','th-1','rm-1','srv-2','agent-peer','self',NULL,NULL,'hi',NULL,NULL,NULL,'n','s',1,?,?)",
).run(at, at + 86_400_000);
db.prepare(
  "INSERT INTO im_deliveries (local_server_id, local_member_id, delivery_id, local_message_id, peer_server_id, peer_agent_id, state, attempts, created_at, acked_at) VALUES ('srv-1','me','dl-1','lm-1','srv-2','agent-peer','persisted',0,?,NULL)",
).run(at);
check(
  "③ delivery.list 读回路由有数据",
  delivery.list("me").items.length === 1 && itemAt(delivery.list("me").items, 0).deliveryId === "dl-1",
  "",
);
check(
  "③ delivery.list 可按线程过滤",
  delivery.list("me", { threadId: "th-1" }).items.length === 1 &&
    delivery.list("me", { threadId: "th-9" }).items.length === 0,
  "",
);
check("③ ack 推进状态机", delivery.ack("me", { deliveryId: "dl-1", at: at + 1 }).state === "acked", "");
threw("③ 已 acked 不能再重发", () => delivery.resend("me", { deliveryId: "dl-1", at: at + 2 }), "ImNotResendable");
db.prepare(
  "INSERT INTO im_messages (local_server_id, local_member_id, local_message_id, thread_id, remote_message_id, peer_server_id, peer_agent_id, sender_kind, sender_agent_id, device_id, body, causal_chain_id, proxied_by, proxy_visibility, nonce, signature, verified, sent_at, expires_at) VALUES ('srv-1','me','lm-2','th-1','rm-2','srv-2','agent-peer','self',NULL,NULL,'hi2',NULL,NULL,NULL,'n2','s',1,?,?)",
).run(at + 3, at + 86_400_000);
db.prepare(
  "INSERT INTO im_deliveries (local_server_id, local_member_id, delivery_id, local_message_id, peer_server_id, peer_agent_id, state, attempts, created_at, acked_at) VALUES ('srv-1','me','dl-2','lm-2','srv-2','agent-peer','failed',1,?,NULL)",
).run(at + 3);
check("③ resend 计数并回到 submitted", delivery.resend("me", { deliveryId: "dl-2", at: at + 4 }).attempts === 2, "");
const read = delivery.markRead("me", { threadId: "th-1", localMessageId: "lm-1", at: at + 5 });
check("③ 已读写 read_state", read.lastReadLocalMessageId === "lm-1" && delivery.lastRead("me", "th-1") === "lm-1", "");
check("③ 已读把投递推到 read", delivery.read("dl-1")?.state === "read", String(delivery.read("dl-1")?.state));
delivery.markRead("me", { threadId: "th-1", localMessageId: "lm-2", at: at + 5 });
threw(
  "③ 跨成员/跨线程的已读被拒",
  () => delivery.markRead("me", { threadId: "th-9", localMessageId: "lm-1", at: at + 6 }),
  "ImDeliveryMissing",
);
threw("③ 跨成员的 ack 被拒", () => delivery.ack("other", { deliveryId: "dl-2", at: at + 7 }), "ImDeliveryMissing");

const identity = createImIdentity();
const registry = new ImDeviceRegistry(identity, new ImDeviceStore(db), scope);
registry.enrollBegin({
  ...scope,
  deviceId: "device-b",
  publicKey: createImIdentity().publicKey,
  now: at,
  ttlMs: 900_000,
});
db.prepare(
  "INSERT INTO offline_queue (local_server_id, local_member_id, queue_id, peer_server_id, peer_agent_id, recipient_device_id, remote_message_id, sealed_payload, seq, expires_at, acked_at) VALUES ('srv-1','me','q-1','srv-2','agent-peer','device-a','rm-1',?,1,?,NULL)",
).run(new Uint8Array([1]), at + 900_000);
db.prepare(
  "INSERT INTO offline_targets (local_server_id, local_member_id, peer_server_id, peer_agent_id, remote_message_id, recipient_device_id, snapshot_at, state, acked_at, excluded_at, audit_id) VALUES ('srv-1','me','srv-2','agent-peer','rm-1','device-a',?,'pending',NULL,NULL,NULL)",
).run(at);

const deactivate = new ImDeactivateService(db, "srv-1", { deactivate: () => {} });
const result = deactivate.deactivate("me", { at: at + 20 });
check("④ 注销：清队列", result.queueCleared === 1 && deactivate.queueCount("me") === 0, JSON.stringify(result));
check("④ 注销：清目标快照", result.targetsCleared === 1, "");
check(
  "④ 注销：撤销设备证书",
  result.devicesRevoked === 2 && deactivate.activeDevices("me") === 0,
  String(result.devicesRevoked),
);
check("④ 注销：目录资料也注销", result.profileDeactivated === true, "");
const revoked = new ImDeviceStore(db).list("srv-1", "me").map((r) => r.status);
check(
  "④ 注销：设备状态全是 revoked",
  revoked.every((s) => s === "revoked"),
  revoked.join(","),
);
check(
  "④ 注销：证书已失效",
  new ImDeviceStore(db).list("srv-1", "me").every((r) => r.cert === null || r.cert.expiresAt === 0),
  "",
);
threw(
  "④ 未接目录端口时注销不伪造成功",
  () => new ImDeactivateService(db, "srv-1").deactivate("me", { at: at + 21 }),
  "ImDirectoryPortMissing",
);

for (const capability of [IM_CHANNELS_ADMIN_CAPABILITY, IM_DELIVERY_CAPABILITY]) {
  const missing = routesOf(capability).filter((route) => !IM_HANDLED_PATHS.has(route));
  check(`② route 全通：${capability}`, missing.length === 0, missing.join(",") || `${routesOf(capability).length} 条`);
}

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");
db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
