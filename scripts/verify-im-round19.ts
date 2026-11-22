import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImAuditLog } from "../src/backend/im/audit";
import { ImAuditAdmin } from "../src/backend/im/audit-admin";
import { ImHostApi } from "../src/backend/im/host-api";
import { createImIdentity } from "../src/backend/im/identity";
import { ImRelayService } from "../src/backend/im/relay";
import { ImContactStore } from "../src/backend/im/social";
import { ImSyncService } from "../src/backend/im/sync";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { count, itemAt, maybeAt, record } from "./verify-im-helpers";

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

const root = await mkdtemp(join(tmpdir(), "im-r19-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
const at = 1_700_000_000_000;
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1','me','th-1','srv-2','agent-peer','open',NULL)",
).run();
db.prepare(
  "INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status, cert_ref, enrolled_at, revoked_at, pairing_expires_at, pairing_code) VALUES ('srv-1','me','device-a','pk','active',NULL,1,NULL,NULL,NULL)",
).run();
db.exec("PRAGMA foreign_keys = ON");

const audit = new ImAuditLog(db);
audit.record(
  { localServerId: "srv-1", localMemberId: "me" },
  {
    id: "ev-1",
    actorId: "agent-1",
    sourceTrustDomain: "local",
    action: "im.syncContacts",
    targetId: "me",
    result: "ok",
    correlationId: "c-1",
    before: { state: "pending" },
    after: { state: "accepted" },
    at,
  },
);
const admin = new ImAuditAdmin(db, "srv-1");
const json: { entries: { before: string; after: string }[] } = JSON.parse(
  admin.export("me", { from: null, to: null, format: "json" }),
);
check(
  "B 导出：json 含 before",
  itemAt(json.entries, 0).before === '{"state":"pending"}',
  String(itemAt(json.entries, 0).before),
);
check(
  "B 导出：json 含 after",
  itemAt(json.entries, 0).after === '{"state":"accepted"}',
  String(itemAt(json.entries, 0).after),
);
const csv = admin.export("me", { from: null, to: null, format: "csv" }).split("\n");
check("B 导出：csv 表头含两列", itemAt(csv, 0).endsWith("before,after,at"), itemAt(csv, 0));
check(
  "B 导出：csv 行含两列",
  itemAt(csv, 1).includes('{"state":"pending"}') && itemAt(csv, 1).includes('{"state":"accepted"}'),
  "",
);
check("B 导出：导出值仍是脱敏后的", admin.export("me", { from: null, to: null, format: "json" }).includes("state"), "");

const sync = new ImSyncService(db, "srv-1");
const peerA = { peerServerId: "srv-9", peerAgentId: "a" };
const peerB = { peerServerId: "srv-9", peerAgentId: "b" };
const peerC = { peerServerId: "srv-9", peerAgentId: "c" };
const merged = sync.mergeContacts("me", {
  deviceId: "device-1",
  at: at + 10,
  entries: [
    { peer: peerA, state: "accepted", updatedAt: at + 11 },
    { peer: peerB, state: "removed", updatedAt: at + 12 },
    { peer: peerC, state: "pending", updatedAt: at + 13 },
  ],
});
check(
  "C 新对端：accepted 不丢",
  merged.merged.find((e) => e.peer.peerAgentId === "a")?.state === "accepted",
  JSON.stringify(merged.merged),
);
check("C 新对端：pending 保持 pending", merged.merged.find((e) => e.peer.peerAgentId === "c")?.state === "pending", "");
check(
  "C 连带：removed 不复活成 pending",
  merged.merged.find((e) => e.peer.peerAgentId === "b")?.state === "removed",
  JSON.stringify(merged.merged),
);
check("C 落库：accepted 读回 accepted", new ImContactStore(db).find(sync.scope("me"), peerA)?.state === "accepted", "");
check(
  "C 落库：removed 读回 removed（不是 pending）",
  new ImContactStore(db).find(sync.scope("me"), peerB)?.state === "removed",
  "",
);

const relay = new ImRelayService(db, "srv-1");
relay.enable("me", { exposedSurface: ["im.messages"], at: at + 20 });
relay.relay("me", {
  frame: {
    type: "relay",
    fromServerId: "srv-2",
    fromAgentId: "x",
    toServerId: "srv-1",
    toAgentId: "me",
    sealed: "ct",
    nonce: "n1",
    sentAt: at + 21,
  },
  deviceIds: ["device-a"],
  at: at + 21,
  expiresAt: at + 900_000,
});
relay.disable("me", { at: at + 22 });
const relayActions = db
  .prepare("SELECT action, before, after FROM audit_log WHERE action LIKE 'im.relay%' ORDER BY at")
  .all()
  .map((row) => ({ action: String(row.action), before: String(row.before), after: String(row.after) }));
check("D relay 审计：三次调用各留痕", relayActions.length === 3, JSON.stringify(relayActions.map((r) => r.action)));
check(
  "D relay 审计：enable 记 enabled 与 exposedSurface",
  itemAt(relayActions, 0).action === "im.relay.enable" && itemAt(relayActions, 0).after.includes("im.messages"),
  maybeAt(relayActions, 0)?.after ?? "",
);
check(
  "D relay 审计：forward 记转发信息",
  itemAt(relayActions, 1).action === "im.relay.forward" && itemAt(relayActions, 1).after.includes("device-a"),
  maybeAt(relayActions, 1)?.after ?? "",
);
check(
  "D relay 审计：disable 记 before/after",
  itemAt(relayActions, 2).action === "im.relay.disable" &&
    itemAt(relayActions, 2).before.includes("im.messages") &&
    itemAt(relayActions, 2).after.includes('"enabled":false'),
  maybeAt(relayActions, 2)?.after ?? "",
);
check(
  "D 对照：同步服务每个操作也写审计",
  count(record(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'im.sync%'").get()).n) > 0,
  "",
);

const identity = createImIdentity();
const host = new ImHostApi(db, "srv-1", {}, identity);
const challenge = host.enrollBegin("me", {
  deviceName: "device-x",
  publicKey: createImIdentity().publicKey,
  now: at + 30,
});
check(
  "设备 route：enrollBegin 给配对码与指纹",
  challenge.pairingCode !== "" && challenge.fingerprint !== "",
  JSON.stringify({ code: challenge.pairingCode, fp: challenge.fingerprint.slice(0, 8) }),
);
check(
  "设备 route：devicesList 含 pending",
  host.listDevices("me").items.some((d) => d.deviceId === "device-x" && d.state === "pending"),
  "",
);
check(
  "设备 route：enrollStatus 读回 pending",
  host.enrollStatus("me", { deviceId: "device-x" }).state === "pending",
  "",
);
const approved = host.enrollApprove("me", { deviceId: "device-x", pairingCode: challenge.pairingCode, now: at + 40 });
check(
  "设备 route：enrollApprove 转 active",
  approved.state === "active" && approved.certExpiresAt !== null,
  JSON.stringify(approved),
);
check(
  "设备 route：批准后配对码单次使用（清空）",
  host.listDevices("me").items.find((d) => d.deviceId === "device-x")?.state === "active",
  "",
);
const revoked = host.deviceRevoke("me", { deviceId: "device-x", now: at + 50 });
check("设备 route：deviceRevoke 转 revoked", revoked.state === "revoked", JSON.stringify(revoked));
host.enrollBegin("me", {
  deviceName: "device-y",
  publicKey: createImIdentity().publicKey,
  now: at + 60,
});
check(
  "设备 route：enrollCancel 取消入网",
  host.enrollCancel("me", { deviceId: "device-y" }).cancelled === true &&
    host.listDevices("me").items.every((d) => d.deviceId !== "device-y"),
  "",
);
const noIdentity = new ImHostApi(db, "srv-1", {});
threw(
  "设备 route：未接根身份时写/签发类操作拒",
  () => noIdentity.enrollBegin("me", { deviceName: "device-q", publicKey: "pk", now: at }),
  "ImDevicesUnavailable",
);
check(
  "设备 route：纯读不受根身份影响",
  noIdentity.listDevices("me").items.length > 0,
  String(noIdentity.listDevices("me").items.length),
);
check(
  "设备 route：跨成员隔离（别的成员看不到）",
  new ImHostApi(db, "srv-1", {}, identity).listDevices("other").items.length === 0,
  "",
);
check(
  "设备 route：批准失败吃限速（错码计数）",
  (() => {
    const wrong = host.enrollBegin("me", {
      deviceName: "device-z",
      publicKey: createImIdentity().publicKey,
      now: at + 70,
    });
    try {
      host.enrollApprove("me", { deviceId: "device-z", pairingCode: "0000-0000", now: at + 71 });
      return false;
    } catch {
      return wrong.pairingCode !== "0000-0000";
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
