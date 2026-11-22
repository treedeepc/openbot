import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImDeactivateService } from "../src/backend/im/deactivate";
import { ImHostApi } from "../src/backend/im/host-api";
import { ImRelayService } from "../src/backend/im/relay";
import * as sm from "../src/backend/im/server-mode";
import { IM_WIRE_TYPES } from "../src/backend/im/wire";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { bytes, itemAt, record } from "./verify-im-helpers";

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

const root = await mkdtemp(join(tmpdir(), "im-r17-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
const scope = { localServerId: "srv-1", localMemberId: "me" };
const peer = { peerServerId: "srv-2", peerAgentId: "agent-peer" };
const at = 1_700_000_000_000;
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1','me','th-1','srv-2','agent-peer','open',NULL)",
).run();
db.prepare(
  "INSERT INTO contacts (local_server_id, local_member_id, contact_id, peer_server_id, peer_agent_id, alias, state, added_at, source, updated_at) VALUES ('srv-1','me','c-1','srv-2','agent-peer',NULL,'accepted',1,NULL,1)",
).run();
for (const device of ["device-revoked", "device-ok", "device-late", "device-revoked-2"]) {
  db.prepare(
    "INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status, cert_ref, enrolled_at, revoked_at, pairing_expires_at, pairing_code) VALUES ('srv-1','me',?,?,'active',NULL,1,NULL,NULL,NULL)",
  ).run(device, `pk-${device}`);
}
db.exec("PRAGMA foreign_keys = ON");

const queue = new sm.ImOfflineQueue(db);
const queueSeeds: { queueId: string; deviceId: string; remote: string }[] = [
  { queueId: "q-1", deviceId: "device-revoked", remote: "rm-1" },
  { queueId: "q-2", deviceId: "device-ok", remote: "rm-1" },
  { queueId: "q-3", deviceId: "device-late", remote: "rm-2" },
  { queueId: "q-4", deviceId: "device-revoked-2", remote: "rm-3" },
];
for (const seed of queueSeeds) {
  queue.enqueue(scope, {
    queueId: seed.queueId,
    peer,
    recipientDeviceId: seed.deviceId,
    remoteMessageId: seed.remote,
    sealedPayload: new Uint8Array([1, 2, 3]),
    at: at + 10,
  });
  queue.snapshot(scope, { peer, remoteMessageId: seed.remote, recipientDeviceIds: [seed.deviceId], at: at + 10 });
}
check(
  "缺陷A 前置：三台设备各有队列行",
  queue.pending(scope, "device-revoked").length === 1 &&
    queue.pending(scope, "device-ok").length === 1 &&
    queue.pending(scope, "device-late").length === 1,
  "",
);

queue.exclude(scope, {
  peer,
  remoteMessageId: "rm-1",
  recipientDeviceId: "device-revoked",
  at: at + 20,
  auditId: "audit-1",
});
check(
  "缺陷A 修复：excluded 同时清掉队列行",
  record(db.prepare("SELECT COUNT(*) AS n FROM offline_queue WHERE recipient_device_id = 'device-revoked'").get()).n ===
    0,
  "",
);
check(
  "缺陷A 修复：pending 不再返回被排除设备",
  queue.pending(scope, "device-revoked").length === 0,
  JSON.stringify(queue.pending(scope, "device-revoked").length),
);
check("隐私对照：未被撤销的设备照常取到", queue.pending(scope, "device-ok").length === 1, "");
check("隐私对照：另一台未排除设备不受影响", queue.pending(scope, "device-late").length === 1, "");
check("缺陷A 修复：excluded 目标不能再确认取件", queue.confirm(scope, { queueId: "q-1", at: at + 30 }) === false, "");
check(
  "缺陷A 修复：目标三字段仍在",
  String(
    record(db.prepare("SELECT state FROM offline_targets WHERE recipient_device_id = 'device-revoked'").get()).state,
  ) === "excluded",
  "",
);

queue.exclude(scope, {
  peer,
  remoteMessageId: "rm-3",
  recipientDeviceId: "device-revoked-2",
  at: at + 21,
  auditId: "audit-2",
});
check(
  "全ACK才删：只数非 excluded 目标（唯一目标被排除则已结算）",
  queue.settled(scope, { peer, remoteMessageId: "rm-3" }) === true,
  JSON.stringify(queue.settled(scope, { peer, remoteMessageId: "rm-3" })),
);
check("对照：同消息还有未 ack 目标时不算结算", queue.settled(scope, { peer, remoteMessageId: "rm-1" }) === false, "");
check(
  "全ACK才删：有未 ack 的非 excluded 目标时未结算",
  queue.settled(scope, { peer, remoteMessageId: "rm-2" }) === false,
  "",
);
queue.confirm(scope, { queueId: "q-3", at: at + 40 });
check("全ACK才删：全部 ack 后结算为真", queue.settled(scope, { peer, remoteMessageId: "rm-2" }) === true, "");

check(
  "注销对照：整表 DELETE 行为不变",
  (() => {
    const deactivate = new ImDeactivateService(db, "srv-1", { deactivate: () => {} });
    const result = deactivate.deactivate("me", { at: at + 50 });
    return result.devicesRevoked === 4 && deactivate.queueCount("me") === 0;
  })(),
  "",
);

const host = new ImHostApi(db, "srv-1");
const presence = host.readPresence("me", [peer], at + 60);
check(
  "presence 路由：读回四项字段",
  Object.keys(itemAt(presence.items, 0)).sort().join(",") === "hidden,peerAgentId,peerServerId,state",
  Object.keys(itemAt(presence.items, 0)).join(","),
);
check(
  "presence 路由：不含最后上线时间",
  !("lastSeenAt" in itemAt(presence.items, 0)) && !("updatedAt" in itemAt(presence.items, 0)),
  "",
);
check("presence 路由：可设隐身", host.setHidden("me", { hidden: true, at: at + 70 }).hidden === true, "");
check("presence 路由：内部立即生效", host.setHidden("me", { hidden: false, at: at + 80 }).hidden === false, "");

const relay = new ImRelayService(db, "srv-1");
check("T12e 默认关闭", relay.settings("me").enabled === false, "");
threw(
  "T12e 启用须明示暴露面（空则拒）",
  () => relay.enable("me", { exposedSurface: [], at: at + 90 }),
  "ImRelaySurfaceRequired",
);
check(
  "T12e 明示暴露面后可启用",
  relay.enable("me", { exposedSurface: ["im.messages"], at: at + 100 }).enabled === true,
  JSON.stringify(relay.settings("me").exposedSurface),
);
check(
  "T12e 新消息类型已加",
  IM_WIRE_TYPES.some((item) => item === "relay"),
  IM_WIRE_TYPES.join(","),
);
const relayed = relay.relay("me", {
  frame: {
    type: "relay",
    fromServerId: "srv-9",
    fromAgentId: "agent-x",
    toServerId: "srv-1",
    toAgentId: "me",
    sealed: "ciphertext-zzz",
    nonce: "n-relay",
    sentAt: at + 110,
  },
  deviceIds: ["device-ok"],
  at: at + 110,
  expiresAt: at + 900_000,
});
check(
  "T12e 只转发密文",
  relayed.forwarded === 1 &&
    new TextDecoder().decode(
      bytes(
        record(db.prepare("SELECT sealed_payload FROM offline_queue WHERE remote_message_id = 'n-relay'").get())
          .sealed_payload,
      ),
    ) === "ciphertext-zzz",
  JSON.stringify(relayed.exposedSurface),
);
relay.disable("me", { at: at + 120 });
threw(
  "T12e 关闭后拒绝中转",
  () =>
    relay.relay("me", {
      frame: {
        type: "relay",
        fromServerId: "srv-9",
        fromAgentId: "x",
        toServerId: "srv-1",
        toAgentId: "me",
        sealed: "c",
        nonce: "n2",
        sentAt: at,
      },
      deviceIds: [],
      at: at + 130,
      expiresAt: at + 900_000,
    }),
  "ImRelayNotEnabled",
);

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");
db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
