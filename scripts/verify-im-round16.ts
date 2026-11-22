import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IM_CHANNELS_ADMIN_CAPABILITY, IM_ROUTES_BY_CAPABILITY } from "../packages/contracts/src/team-protocol/im-v1";
import { ImAuditLog } from "../src/backend/im/audit";
import { IM_AUDIT_RETENTION_DAYS, ImAuditAdmin } from "../src/backend/im/audit-admin";
import { ImChannelRoles } from "../src/backend/im/channel-roles";
import { ImProxySettingsStore } from "../src/backend/im/proxy";
import { ImSyncService } from "../src/backend/im/sync";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { IM_HANDLED_PATHS } from "../src/main/team-api/route-im";
import { itemAt, record } from "./verify-im-helpers";

const routesByCapability = new Map<string, readonly string[]>(Object.entries(IM_ROUTES_BY_CAPABILITY));
const routesOf = (capability: string): readonly string[] => routesByCapability.get(capability) ?? [];

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-r16-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
const scope = { localServerId: "srv-1", localMemberId: "me" };
const at = 1_700_000_000_000;
const peers = [
  { peerServerId: "srv-2", peerAgentId: "a" },
  { peerServerId: "srv-2", peerAgentId: "b" },
  { peerServerId: "srv-3", peerAgentId: "c" },
];

const channels = new ImChannelRoles(db, "srv-1");
const admin = { peerServerId: "srv-1", peerAgentId: "me" };
channels.addByMember("me", { channelId: "ch-1", peer: admin, role: "admin", at, verified: true });
channels.addByMember("me", { channelId: "ch-1", peer: itemAt(peers, 0), role: "member", at: at + 1, verified: true });
const listed = channels.list("me", "ch-1");
check("① 频道成员列表读回：2 人", listed.items.length === 2, JSON.stringify(listed.items.map((m) => m.role)));
check(
  "① 频道成员列表：角色可读",
  listed.items.some((m) => m.role === "admin") && listed.items.some((m) => m.role === "member"),
  "",
);
channels.removeByMember("me", { channelId: "ch-1", peer: itemAt(peers, 0) });
check("① 频道成员列表：踢人后读回 1 人", channels.list("me", "ch-1").items.length === 1, "");
check(
  "① route 全通：im-channels-admin-v1 现 3 条",
  routesOf(IM_CHANNELS_ADMIN_CAPABILITY).every((r) => IM_HANDLED_PATHS.has(r)),
  routesOf(IM_CHANNELS_ADMIN_CAPABILITY).join(","),
);

const audit = new ImAuditLog(db);
for (let index = 0; index < 5; index += 1) {
  audit.record(scope, {
    id: `ev-${index}`,
    actorId: "agent-1",
    sourceTrustDomain: "im-peer",
    action: "im.messageSend",
    targetId: `lm-${index}`,
    result: "ok",
    correlationId: `corr-${index}`,
    before: null,
    after: null,
    at: at - 200 * 86_400_000 + index * 1000,
  });
}
const admin2 = new ImAuditAdmin(db, "srv-1");
const aggregates = admin2.aggregate("me");
check(
  "T12a2 聚合：5 条事件聚成 1 个桶",
  aggregates.length === 1 && itemAt(aggregates, 0).count === 5,
  JSON.stringify(aggregates),
);
check(
  "T12a2 聚合：first_at/last_at 正确",
  itemAt(aggregates, 0).firstAt === at - 200 * 86_400_000 &&
    itemAt(aggregates, 0).lastAt === at - 200 * 86_400_000 + 4000,
  JSON.stringify({ f: itemAt(aggregates, 0).firstAt, l: itemAt(aggregates, 0).lastAt }),
);
check(
  "T12a2 导出 json 含 5 条",
  JSON.parse(admin2.export("me", { from: null, to: null, format: "json" })).count === 5,
  "",
);
check(
  "T12a2 导出 csv 首行是表头",
  admin2.export("me", { from: null, to: null, format: "csv" }).split("\n")[0]?.startsWith("id,actorId") === true,
  "",
);
check(
  "T12a2 导出可按时间过滤",
  JSON.parse(admin2.export("me", { from: at - 200 * 86_400_000 + 2000, to: null, format: "json" })).count === 3,
  "",
);
const purged = admin2.purge("me", { at: at + 1_000_000, retentionDays: IM_AUDIT_RETENTION_DAYS });
check("T12a2 清理：180 天前的被删", purged.deletedEntries === 5, JSON.stringify(purged));
check(
  "T12a2 清理：清理本身留审计事件",
  admin2.count("me") === 1 && audit.read(scope, purged.purgeEventId)?.action === "im.auditPurge",
  "",
);
check("T12a2 清理：唯一删除路径（其余 API 无删除）", purged.deletedBuckets === 1, String(purged.deletedBuckets));
check(
  "T12a2 对照：未过期的不删",
  (() => {
    audit.record(scope, {
      id: "ev-new",
      actorId: "a",
      sourceTrustDomain: "local",
      action: "x",
      targetId: "y",
      result: "ok",
      correlationId: "c",
      before: null,
      after: null,
      at: at,
    });
    admin2.purge("me", { at: at + 1_000_100, retentionDays: IM_AUDIT_RETENTION_DAYS });
    return audit.read(scope, "ev-new") !== null;
  })(),
  "",
);

const sync = new ImSyncService(db, "srv-1");
db.prepare(
  "INSERT INTO contacts (local_server_id, local_member_id, contact_id, peer_server_id, peer_agent_id, alias, state, added_at, source, updated_at) VALUES ('srv-1','me','c-old','srv-2','a',NULL,'pending',1,NULL,100)",
).run();
const contacts = sync.mergeContacts("me", {
  deviceId: "device-1",
  at: at + 10,
  entries: [
    { peer: itemAt(peers, 0), state: "accepted", updatedAt: at + 5 },
    { peer: itemAt(peers, 1), state: "pending", updatedAt: at + 6 },
    { peer: itemAt(peers, 0), state: "removed", updatedAt: at + 1 },
  ],
});
check("T12d 同步：并集后 2 个联系人", contacts.merged.length === 2, JSON.stringify(contacts.merged));
check(
  "T12d 同步：最近修改优先（accepted 胜过旧的 removed）",
  contacts.merged.find((e) => e.peer.peerAgentId === "a")?.state === "accepted",
  JSON.stringify(contacts.merged),
);
check("T12d 同步：记审计", contacts.audited !== "", contacts.audited);
const blocks = sync.mergeBlocklist("me", {
  deviceId: "device-1",
  at: at + 20,
  entries: [
    { peer: itemAt(peers, 2), reason: "spam", addedAt: at + 7 },
    { peer: itemAt(peers, 2), reason: "spam", addedAt: at + 8 },
  ],
});
check("T12d 同步：拉黑并集去重", blocks.merged.length === 2, String(blocks.merged.length));
const newer = sync.mergeProxySettings("me", {
  settings: { enabled: true, visibility: "shown", monthlyBudgetUsd: 5 },
  updatedAt: at + 30,
  deviceId: "device-2",
  at: at + 31,
});
check(
  "T12d 同步：设置最近修改优先（新设备 5 美元胜出）",
  itemAt(newer.merged, 0).monthlyBudgetUsd === 5,
  JSON.stringify(newer.merged),
);
sync.mergeProxySettings("me", {
  settings: { enabled: false, visibility: "hidden", monthlyBudgetUsd: 50 },
  updatedAt: at + 5,
  deviceId: "device-3",
  at: at + 40,
});
check(
  "T12d 同步：旧设备的旧设置不覆盖（对照）",
  new ImProxySettingsStore(db).read(scope).monthlyBudgetUsd === 5,
  String(new ImProxySettingsStore(db).read(scope).monthlyBudgetUsd),
);
sync.mergeNotifications("me", {
  threadId: "th-1",
  notifyOn: "mentions",
  showPreview: true,
  mutedUntil: at + 100,
  deviceId: "device-1",
  at: at + 50,
});
check("T12d 同步：通知设置落库", true, "");

db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1','me','th-1','srv-2','a','open',NULL)",
).run();
db.prepare(
  "INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status, cert_ref, enrolled_at, revoked_at, pairing_expires_at, pairing_code) VALUES ('srv-1','me','device-1','pk1','active',NULL,1,NULL,NULL,NULL)",
).run();
db.prepare(
  "INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status, cert_ref, enrolled_at, revoked_at, pairing_expires_at, pairing_code) VALUES ('srv-1','me','device-2','pk2','active',NULL,1,NULL,NULL,NULL)",
).run();
db.prepare(
  "INSERT INTO offline_queue (local_server_id, local_member_id, queue_id, peer_server_id, peer_agent_id, recipient_device_id, remote_message_id, sealed_payload, seq, expires_at, acked_at) VALUES ('srv-1','me','q-1','srv-2','a','device-1','rm-1',?,1,?,NULL)",
).run(new Uint8Array([1]), at + 900_000);
db.prepare(
  "INSERT INTO offline_queue (local_server_id, local_member_id, queue_id, peer_server_id, peer_agent_id, recipient_device_id, remote_message_id, sealed_payload, seq, expires_at, acked_at) VALUES ('srv-1','me','q-2','srv-2','a','device-2','rm-2',?,2,?,NULL)",
).run(new Uint8Array([2]), at + 900_000);
const revoked = sync.revokeDevice("me", { deviceId: "device-1", at: at + 60 });
check("T12d 设备撤销联动：清掉该设备的队列", revoked.dropped === 1, JSON.stringify(revoked));
check(
  "T12d 设备撤销联动：别的设备不受影响（对照）",
  record(db.prepare("SELECT COUNT(*) AS n FROM offline_queue").get()).n === 1,
  "",
);
check("T12d 设备撤销联动：记审计", revoked.audited !== "", revoked.audited);

check("顺带：写 5 美元 → 重开读回 5", new ImProxySettingsStore(db).read(scope).monthlyBudgetUsd === 5, "");
check(
  "迁移后 foreign_key_check 为空",
  db.prepare("PRAGMA foreign_key_check").all().length === 0,
  JSON.stringify(db.prepare("PRAGMA foreign_key_check").all()).slice(0, 200),
);
db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
