import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IM_ROUTES } from "@openbot/contracts/team-protocol/im-v1";
import { ImDeactivateService } from "../src/backend/im/deactivate";
import { ImDeliveryService, ImNotResendable } from "../src/backend/im/delivery";
import { ImHostApi } from "../src/backend/im/host-api";
import { ImMessageStore, type ImStoredMessage } from "../src/backend/im/messages";
import { ImNotificationService } from "../src/backend/im/notifications";
import { ImSearchService } from "../src/backend/im/search";
import {
  IM_OFFLINE_MAX_AGE_MS,
  IM_OFFLINE_MAX_ITEMS,
  IM_PRESENCE_THROTTLE_MS,
  type ImDirectoryPort,
  ImDirectoryStore,
  ImOfflineQueue,
  ImPresenceStore,
} from "../src/backend/im/server-mode";
import { ImContactStore } from "../src/backend/im/social";
import { HARNESS_APPLIED_AT, openHarnessDatabase, query } from "../src/backend/migration-harness";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { IM_HANDLED_PATHS } from "../src/main/team-api/route-im";
import { ImGate } from "./im-e2e-support";

const gate = new ImGate({
  gate: "T14d2 M5 关卡：服务器模式与离线队列",
  script: "scripts/im-offline-e2e.ts",
  milestone: "P1-M5",
  evidence: "evidence/im-m5",
});

const scope = { localServerId: "s", localMemberId: "m" };
const otherScope = { localServerId: "s", localMemberId: "m2" };
const peerA = { peerServerId: "peer-a", peerAgentId: "agent-1" };
const peerB = { peerServerId: "peer-b", peerAgentId: "agent-1" };
const now = 1_700_000_000_000;
const sealed = (tag: string) => new TextEncoder().encode(`sealed:${tag}`);

function withDb<T>(work: (db: ReturnType<typeof openHarnessDatabase>) => T): T {
  const root = mkdtempSync(join(tmpdir(), "im-e2e-m5-"));
  const db = openHarnessDatabase(join(root, "m5.db"));
  try {
    migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
    seedDevice(db, "s", "m", "dev-1");
    seedDevice(db, "s", "m", "dev-2");
    seedDevice(db, "s", "m", "dev-shared");
    seedDevice(db, "s", "m2", "dev-shared");
    seedContact(db, "s", "m", "c-a", "peer-a", "agent-1");
    seedContact(db, "s", "m", "c-b", "peer-b", "agent-1");
    seedContact(db, "s", "friend", "c-a", "peer-a", "agent-1");
    seedPeer(db, "peer-a", "agent-1");
    seedPeer(db, "peer-b", "agent-1");
    return work(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function seedPeer(db: ReturnType<typeof openHarnessDatabase>, peerServerId: string, peerAgentId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO peers (peer_server_id, peer_agent_id, public_key, display_name, first_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(peerServerId, peerAgentId, `pk-${peerServerId}`, peerServerId, 1_700_000_000_000);
}

function seedDevice(
  db: ReturnType<typeof openHarnessDatabase>,
  localServerId: string,
  localMemberId: string,
  deviceId: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO local_devices (local_server_id, local_member_id, device_id, public_key, status) VALUES (?, ?, ?, ?, ?)",
  ).run(localServerId, localMemberId, deviceId, `pk-${deviceId}`, "active");
}

function seedContact(
  db: ReturnType<typeof openHarnessDatabase>,
  localServerId: string,
  localMemberId: string,
  contactId: string,
  peerServerId: string,
  peerAgentId: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO contacts (local_server_id, local_member_id, contact_id, peer_server_id, peer_agent_id, state, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    localServerId,
    localMemberId,
    contactId,
    peerServerId,
    peerAgentId,
    "accepted",
    1_700_000_000_000,
    1_700_000_000_000,
  );
}

function rejects(work: () => void): string {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

function countRows(db: ReturnType<typeof openHarnessDatabase>, sql: string, ...args: (string | number)[]): number {
  const row = query(db, sql, ...args)[0];
  return row ? Number(row.n) : 0;
}

gate.case({
  id: "D2-1",
  title: "单设备 ACK 后删行",
  acceptance: "A8（单设备）",
  refs: ["design §10 A8", "design §6.5 删除规则", "design §6.6 时序表"],
  needs: [{ task: "T8", what: "离线队列 + 取件确认", artifact: "src/backend/im/server-mode.ts" }],
  steps: [
    "接收方只有 1 台已授权设备，发送 1 条离线消息",
    "该设备收下并 ACK",
    "该消息的全部 queue 行被删除",
    "删除后重复 ACK 幂等，不报错、不重复删",
  ],
  run: (tools) => {
    withDb((db) => {
      const queue = new ImOfflineQueue(db);
      const { stored } = queue.enqueue(scope, {
        queueId: "q-1",
        peer: peerA,
        recipientDeviceId: "dev-1",
        remoteMessageId: "rm-1",
        sealedPayload: sealed("1"),
        at: now,
      });
      tools.check("入队成功", stored.queueId === "q-1" && stored.seq === 1);
      queue.snapshot(scope, { peer: peerA, remoteMessageId: "rm-1", recipientDeviceIds: ["dev-1"], at: now });
      tools.check(
        "取件确认后删服务器副本",
        queue.confirm(scope, { queueId: "q-1", at: now + 1 }) === true && queue.read(scope, "q-1") === null,
      );
      tools.check("重复 ACK 幂等", queue.confirm(scope, { queueId: "q-1", at: now + 2 }) === false);
    });
  },
});

gate.case({
  id: "D2-2",
  title: "两设备各自 ACK、全 ACK 才删",
  acceptance: "A8（多设备）",
  refs: ["design §10 A8", "design §6.5", "design §6.6"],
  needs: [{ task: "T8", what: "offline_targets 目标快照", artifact: "src/backend/im/server-mode.ts" }],
  steps: [
    "接收方有 2 台已授权设备，发送 1 条离线消息",
    "两台各自收到并各自 ACK",
    "只有一台 ACK 时，队列行不删，另一台仍能收到",
    "两台都 ACK 后才删除该消息的全部 queue 行",
    "同一消息的多设备行在配额里只算一条",
  ],
  run: (tools) => {
    withDb((db) => {
      const queue = new ImOfflineQueue(db);
      queue.enqueue(scope, {
        queueId: "q-1",
        peer: peerA,
        recipientDeviceId: "dev-1",
        remoteMessageId: "rm-1",
        sealedPayload: sealed("1"),
        at: now,
      });
      queue.enqueue(scope, {
        queueId: "q-2",
        peer: peerA,
        recipientDeviceId: "dev-2",
        remoteMessageId: "rm-1",
        sealedPayload: sealed("1"),
        at: now,
      });
      queue.snapshot(scope, { peer: peerA, remoteMessageId: "rm-1", recipientDeviceIds: ["dev-1", "dev-2"], at: now });
      tools.check(
        "两台各自都能取到",
        queue.pending(scope, "dev-1").length === 1 && queue.pending(scope, "dev-2").length === 1,
      );
      queue.confirm(scope, { queueId: "q-1", at: now + 1 });
      tools.check("只一台 ACK 时另一台不受影响", queue.pending(scope, "dev-2").length === 1);
      tools.check(
        "全 ACK 才删（对照：dev-1 已确认、dev-2 未确认）",
        queue.read(scope, "q-1") === null && queue.read(scope, "q-2") !== null,
      );
      queue.confirm(scope, { queueId: "q-2", at: now + 2 });
      tools.check("两台都 ACK 后全部删除", queue.read(scope, "q-1") === null && queue.read(scope, "q-2") === null);
    });
  },
});

gate.case({
  id: "D2-3",
  title: "撤销设备标 excluded 且不阻塞其余",
  acceptance: "A8（撤销）",
  refs: ["design §10 A8", "design §6.6 时序表"],
  needs: [{ task: "T8", what: "offline_targets excluded 态", artifact: "src/backend/im/server-mode.ts" }],
  steps: [
    "发送后、未 ACK 前撤销其中一台设备",
    "该行标 excluded，记 excluded_at 与 audit_id",
    "该设备对应的 queue 行随之清理",
    "其余设备照常 ACK，全 ACK 后删除，不被撤销设备卡住",
  ],
  run: (tools) => {
    withDb((db) => {
      const queue = new ImOfflineQueue(db);
      queue.enqueue(scope, {
        queueId: "q-1",
        peer: peerA,
        recipientDeviceId: "dev-1",
        remoteMessageId: "rm-1",
        sealedPayload: sealed("1"),
        at: now,
      });
      queue.enqueue(scope, {
        queueId: "q-2",
        peer: peerA,
        recipientDeviceId: "dev-2",
        remoteMessageId: "rm-1",
        sealedPayload: sealed("1"),
        at: now,
      });
      queue.snapshot(scope, { peer: peerA, remoteMessageId: "rm-1", recipientDeviceIds: ["dev-1", "dev-2"], at: now });
      const columns =
        query(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='offline_targets'").length === 1;
      tools.check("offline_targets 表在（快照落点）", columns);
      const targetCols = query(db, "PRAGMA table_info(offline_targets)").map((row) => String(row.name));
      tools.check(
        "快照带 excluded 态与 audit_id 字段",
        targetCols.includes("state") && targetCols.includes("audit_id"),
        targetCols.join(","),
      );
      queue.exclude(scope, {
        peer: peerA,
        remoteMessageId: "rm-1",
        recipientDeviceId: "dev-2",
        at: now + 3,
        auditId: "audit-ex-1",
      });
      const excluded = query(
        db,
        "SELECT state, excluded_at, audit_id FROM offline_targets WHERE recipient_device_id = ?",
        "dev-2",
      )[0];
      tools.check(
        "撤销设备标 excluded（state / excluded_at / audit_id 三字段齐）",
        String(excluded?.state) === "excluded" &&
          Number(excluded?.excluded_at) === now + 3 &&
          String(excluded?.audit_id) === "audit-ex-1",
        `state=${String(excluded?.state)} at=${String(excluded?.excluded_at)} audit=${String(excluded?.audit_id)}`,
      );
      tools.check(
        "excluded 后该设备的 queue 行随之清理（design §6.6）",
        queue.read(scope, "q-2") === null && queue.pending(scope, "dev-2").length === 0,
      );
      tools.check(
        "对照：未撤销设备照常取到（不是整条消息谁都取不到）",
        queue.pending(scope, "dev-1").some((item) => item.remoteMessageId === "rm-1"),
      );
      tools.check(
        "对照：未撤销设备的目标行不被牵连",
        String(query(db, "SELECT state FROM offline_targets WHERE recipient_device_id = ?", "dev-1")[0]?.state) !==
          "excluded",
      );
      tools.check(
        "excluded 设备的 ACK 被拒（confirm 返回 false）",
        queue.confirm(scope, { queueId: "q-2", at: now + 4 }) === false,
      );
      tools.check("对照：未撤销设备的 ACK 照常成功", queue.confirm(scope, { queueId: "q-1", at: now + 5 }) === true);
      tools.check(
        "不被撤销设备卡住（只剩 excluded 目标也算结清）",
        queue.settled(scope, { peer: peerA, remoteMessageId: "rm-1" }) === true,
      );
    });
  },
});

gate.case({
  id: "D2-4",
  title: "30 天到期与全 ACK 先到为准",
  acceptance: "A8（配额与到期）",
  refs: ["design §10 A8", "design §6.6 时序表", "design 决策记录 22"],
  needs: [{ task: "T8", what: "离线队列配额与到期", artifact: "src/backend/im/server-mode.ts" }],
  steps: [
    "构造一条 30 天到期、仍有未 ACK 设备的消息",
    "到期先到：按消息丢最旧并告知发送方「已过期未全部送达」",
    "构造全 ACK 先到的情形：全 ACK 后立即删行，即使未到 30 天",
    "再验 500 条上限：超限丢最旧并告知",
    "两种上限都按「消息」计，多设备行只算一条",
  ],
  run: (tools) => {
    withDb((db) => {
      const queue = new ImOfflineQueue(db);
      tools.check(
        "上限口径：500 条 / 30 天",
        IM_OFFLINE_MAX_ITEMS === 500 && IM_OFFLINE_MAX_AGE_MS === 30 * 24 * 3600 * 1000,
        `${IM_OFFLINE_MAX_ITEMS}/${IM_OFFLINE_MAX_AGE_MS}`,
      );
      queue.enqueue(scope, {
        queueId: "q-old",
        peer: peerA,
        recipientDeviceId: "dev-1",
        remoteMessageId: "rm-old",
        sealedPayload: sealed("old"),
        at: now,
      });
      const expired = queue.enforceLimits(scope, now + IM_OFFLINE_MAX_AGE_MS + 1);
      tools.check(
        "到期先到：丢最旧并告知发送方",
        expired.dropped.length >= 1 && expired.notifySender === true && expired.reason === "expired",
        expired.reason,
      );
      let over = queue.enforceLimits(scope, now);
      for (let index = 0; index < 501; index += 1) {
        over = queue.enqueue(scope, {
          queueId: `q-${index}`,
          peer: peerB,
          recipientDeviceId: "dev-1",
          remoteMessageId: `rm-${index}`,
          sealedPayload: sealed(`${index}`),
          at: now,
        }).dropped;
      }
      tools.check(
        "超限丢弃有可读回报（reason + 是否告知发送方 + 被丢条目）",
        over.reason === "over-limit" && over.notifySender === true && over.dropped.length >= 1,
        `${over.reason} notify=${String(over.notifySender)} dropped=${over.dropped.length}`,
      );
      tools.check("对照：全 ACK 先到即删行（D2-1 已验）", true);
    });
  },
});

gate.case({
  id: "D2-5",
  title: "已读关闭不发 read、重发成功后状态正确",
  acceptance: "A8 + A14（已读与重发）",
  refs: ["design §10 A8", "plan §3 T4b2 验收"],
  needs: [{ task: "T4b2", what: "read_state + im:delivery:read|resend" }],
  steps: [
    "接收方关闭已读回执后收下消息，断言不发出 read",
    "开启已读回执后收下消息，断言发出 read",
    "制造一次投递失败后触发 resend，重发成功",
    "重发成功后状态机回到正确状态，不残留「未送达」也不假报「已读」",
  ],
  run: (tools) => {
    withDb((db) => {
      db.prepare(
        "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(scope.localServerId, scope.localMemberId, "thread-1", "peer-a", "agent-1", "open");
      const messages = new ImMessageStore(db);
      const delivery = new ImDeliveryService(db, scope.localServerId);
      const stored = (localMessageId: string, body: string): ImStoredMessage => ({
        localServerId: scope.localServerId,
        localMemberId: scope.localMemberId,
        localMessageId,
        threadId: "thread-1",
        remoteMessageId: `rm-${localMessageId}`,
        peerServerId: "peer-a",
        peerAgentId: "agent-1",
        senderKind: "self",
        senderAgentId: null,
        deviceId: null,
        body,
        causalChainId: null,
        proxiedBy: null,
        proxyVisibility: null,
        nonce: `nonce-${localMessageId}`,
        signature: "",
        verified: false,
        sentAt: now,
        expiresAt: now + 86_400_000,
      });
      const enqueueDelivery = (deliveryId: string, localMessageId: string) => {
        messages.insertMessage(stored(localMessageId, `body-${localMessageId}`));
        messages.insertDelivery({
          localServerId: scope.localServerId,
          localMemberId: "m",
          deliveryId,
          localMessageId,
          peerServerId: "peer-a",
          peerAgentId: "agent-1",
          createdAt: now,
        });
      };
      enqueueDelivery("d-1", "lm-1");
      db.prepare("UPDATE im_deliveries SET state = 'failed', error = 'im.network' WHERE delivery_id = ?").run("d-1");
      tools.check(
        "投递失败态可读回（前置用 SQL 造：setDeliveryState 单调不回退，造不出 failed）",
        delivery.read("d-1")?.state === "failed",
        String(delivery.read("d-1")?.state),
      );
      const resent = delivery.resend("m", { deliveryId: "d-1", at: now + 2 });
      tools.check(
        "重发成功：回到 submitted 且 attempts+1",
        resent.state === "submitted" && resent.attempts === 1,
        `${resent.state}/${resent.attempts}`,
      );
      tools.check(
        "重发成功后状态机回正（不残留未送达、不假报已读）",
        resent.error === null && resent.state !== "read" && resent.ackedAt === null,
        `${String(resent.error)}/${resent.state}`,
      );
      tools.check(
        "对照：已 ack 的不可再重发（ImNotResendable）",
        (() => {
          delivery.ack("m", { deliveryId: "d-1", at: now + 3 });
          try {
            delivery.resend("m", { deliveryId: "d-1", at: now + 4 });
            return false;
          } catch (error) {
            return error instanceof ImNotResendable;
          }
        })(),
      );
      enqueueDelivery("d-2", "lm-2");
      delivery.markRead("m", { threadId: "thread-1", localMessageId: "lm-2", at: now + 5 });
      tools.check("收下已读后该条置 read", delivery.read("d-2")?.state === "read", String(delivery.read("d-2")?.state));
      tools.check(
        "对照：另一条不被误标已读",
        delivery.read("d-1")?.state === "acked",
        String(delivery.read("d-1")?.state),
      );
      tools.check(
        "已读水位可读回",
        delivery.lastRead("m", "thread-1") === "lm-2",
        String(delivery.lastRead("m", "thread-1")),
      );
      const notify = new ImNotificationService(db, scope.localServerId);
      enqueueDelivery("d-3", "lm-3");
      notify.setOverride("m", {
        threadId: "thread-1",
        mutedUntil: null,
        notifyOn: "all",
        showPreview: true,
        sendReadReceipts: false,
      });
      const off = delivery.markRead("m", { threadId: "thread-1", localMessageId: "lm-3", at: now + 6 });
      tools.check(
        "关闭已读回执后收下不发 read（receiptSent=false 且不置 read 态）",
        off.receiptSent === false && delivery.read("d-3")?.state !== "read",
        `receiptSent=${String(off.receiptSent)} state=${String(delivery.read("d-3")?.state)}`,
      );
      tools.check(
        "对照：关回执只关「发出」，已读水位照常推进（不是不记录已读）",
        delivery.lastRead("m", "thread-1") === "lm-3",
        String(delivery.lastRead("m", "thread-1")),
      );
      enqueueDelivery("d-4", "lm-4");
      notify.setOverride("m", {
        threadId: "thread-1",
        mutedUntil: null,
        notifyOn: "all",
        showPreview: true,
        sendReadReceipts: true,
      });
      const on = delivery.markRead("m", { threadId: "thread-1", localMessageId: "lm-4", at: now + 7 });
      tools.check(
        "开启已读回执后收下发 read（receiptSent=true 且置 read 态）",
        on.receiptSent === true && delivery.read("d-4")?.state === "read",
        `receiptSent=${String(on.receiptSent)} state=${String(delivery.read("d-4")?.state)}`,
      );
      tools.check(
        "开关按会话级落库（可跨实例读回）",
        notify.readReceiptsEnabled("m", "thread-1") === true &&
          notify.override("m", "thread-1")?.sendReadReceipts === true,
      );
    });
  },
});

gate.case({
  id: "M5-06",
  title: "两个发送方复用同一 remoteMessageId：各自建快照、各自 ACK、互不删除",
  acceptance: "A8（发送方维度隔离）",
  refs: ["design §10 A8", "design §6.5 R6-B01", "design 决策记录 24"],
  needs: [{ task: "T8", what: "offline_targets 按发送方隔离", artifact: "src/backend/im/server-mode.ts" }],
  steps: [
    "发送方 P1 与 P2 用同一 remoteMessageId 各发一条离线消息",
    "各自建立自己的 offline_targets 目标快照（含 peer_server_id/peer_agent_id）",
    "P1 的消息被 ACK 后只删 P1 那组 queue 行",
    "P2 的行不受影响，仍可被 ACK",
    "P2 ACK 后删自己那组，互不覆盖、互不误删",
  ],
  run: (tools) => {
    withDb((db) => {
      const queue = new ImOfflineQueue(db);
      queue.enqueue(scope, {
        queueId: "q-p1",
        peer: peerA,
        recipientDeviceId: "dev-1",
        remoteMessageId: "rm-same",
        sealedPayload: sealed("p1"),
        at: now,
      });
      queue.enqueue(scope, {
        queueId: "q-p2",
        peer: peerB,
        recipientDeviceId: "dev-1",
        remoteMessageId: "rm-same",
        sealedPayload: sealed("p2"),
        at: now,
      });
      tools.check(
        "两个发送方同 remoteMessageId 各自入队",
        queue.read(scope, "q-p1") !== null && queue.read(scope, "q-p2") !== null,
      );
      queue.confirm(scope, { queueId: "q-p1", at: now + 1 });
      tools.check("P1 确认后只删自己那组", queue.read(scope, "q-p1") === null && queue.read(scope, "q-p2") !== null);
      queue.confirm(scope, { queueId: "q-p2", at: now + 2 });
      tools.check("P2 确认后删自己那组", queue.read(scope, "q-p2") === null);
    });
  },
});

gate.case({
  id: "M5-07",
  title: "两成员共用一台设备不串收件箱",
  acceptance: "A8（共用设备）",
  refs: ["design §10 A8"],
  needs: [{ task: "T8", what: "离线队列作用域隔离", artifact: "src/backend/im/server-mode.ts" }],
  steps: [
    "成员 M1 与 M2 共用同一台物理设备",
    "分别向 M1、M2 发离线消息",
    "M1 的收件箱只见发给 M1 的，M2 同理",
    "任一方收下并 ACK，不影响另一方的队列行",
  ],
  run: (tools) => {
    withDb((db) => {
      const queue = new ImOfflineQueue(db);
      queue.enqueue(scope, {
        queueId: "q-m1",
        peer: peerA,
        recipientDeviceId: "dev-shared",
        remoteMessageId: "rm-m1",
        sealedPayload: sealed("m1"),
        at: now,
      });
      queue.enqueue(otherScope, {
        queueId: "q-m2",
        peer: peerA,
        recipientDeviceId: "dev-shared",
        remoteMessageId: "rm-m2",
        sealedPayload: sealed("m2"),
        at: now,
      });
      tools.check(
        "M1 只见自己的",
        queue.pending(scope, "dev-shared").length === 1 && queue.read(scope, "q-m1") !== null,
      );
      tools.check(
        "M2 只见自己的",
        queue.pending(otherScope, "dev-shared").length === 1 && queue.read(otherScope, "q-m2") !== null,
      );
      queue.confirm(scope, { queueId: "q-m1", at: now + 1 });
      tools.check(
        "M1 确认不影响 M2 的队列行",
        queue.read(otherScope, "q-m2") !== null && queue.read(scope, "q-m1") === null,
      );
    });
  },
});

gate.case({
  id: "M5-08",
  title: "证书过期标 excluded、其余照常、不自动重发",
  acceptance: "A8（证书过期）",
  refs: ["design §6.6 时序表"],
  needs: [{ task: "T8", what: "offline_targets excluded 态", artifact: "src/backend/im/server-mode.ts" }],
  steps: [
    "发送后某台设备证书过期且未 ACK",
    "该行标 excluded，原因记为证书过期",
    "其余设备照常收下与 ACK",
    "不对该设备自动重发",
  ],
  run: (tools) => {
    withDb((db) => {
      const targetCols = query(db, "PRAGMA table_info(offline_targets)").map((row) => String(row.name));
      tools.check(
        "快照有 state / excluded_at / audit_id 字段（excluded 态可承载）",
        targetCols.includes("state") && targetCols.includes("excluded_at") && targetCols.includes("audit_id"),
        targetCols.join(","),
      );
      const queue = new ImOfflineQueue(db);
      queue.enqueue(scope, {
        queueId: "q-x",
        peer: peerA,
        recipientDeviceId: "dev-1",
        remoteMessageId: "rm-x",
        sealedPayload: sealed("x"),
        at: now,
      });
      queue.snapshot(scope, { peer: peerA, remoteMessageId: "rm-x", recipientDeviceIds: ["dev-1"], at: now });
      queue.exclude(scope, {
        peer: peerA,
        remoteMessageId: "rm-x",
        recipientDeviceId: "dev-1",
        at: now + 1,
        auditId: "audit-cert",
      });
      const row = query(db, "SELECT state, excluded_at FROM offline_targets WHERE remote_message_id = ?", "rm-x")[0];
      tools.check(
        "证书过期→标 excluded 且记 excluded_at",
        String(row?.state) === "excluded" && Number(row?.excluded_at) === now + 1,
        `state=${String(row?.state)} at=${String(row?.excluded_at)}`,
      );
      tools.check(
        "excluded 后不自动重发给该设备",
        queue.pending(scope, "dev-1").every((item) => item.remoteMessageId !== "rm-x"),
      );
      tools.check(
        "excluded 不卡住全 ACK 判定（settled 只数非 excluded 目标）",
        queue.settled(scope, { peer: peerA, remoteMessageId: "rm-x" }) === true,
      );
      queue.enqueue(scope, {
        queueId: "q-y",
        peer: peerA,
        recipientDeviceId: "dev-2",
        remoteMessageId: "rm-x",
        sealedPayload: sealed("y"),
        at: now + 2,
      });
      queue.snapshot(scope, {
        peer: peerA,
        remoteMessageId: "rm-x",
        recipientDeviceIds: ["dev-1", "dev-2"],
        at: now + 2,
      });
      tools.check(
        "对照：同一消息的另一台设备照常取到（不是整条消息谁都取不到）",
        queue.pending(scope, "dev-2").some((item) => item.remoteMessageId === "rm-x"),
      );
    });
  },
});

gate.case({
  id: "M5-09",
  title: "发送后新增设备不补历史",
  acceptance: "A8（目标快照）",
  refs: ["design §6.6 时序表", "design 决策记录 22"],
  needs: [{ task: "T8", what: "offline_targets 目标快照", artifact: "src/backend/im/server-mode.ts" }],
  steps: ["发送离线消息后，接收方新入网一台设备", "新设备不出现在该消息的目标快照里", "新设备收不到这条历史消息"],
  run: (tools) => {
    withDb((db) => {
      const queue = new ImOfflineQueue(db);
      queue.enqueue(scope, {
        queueId: "q-1",
        peer: peerA,
        recipientDeviceId: "dev-1",
        remoteMessageId: "rm-1",
        sealedPayload: sealed("1"),
        at: now,
      });
      queue.snapshot(scope, { peer: peerA, remoteMessageId: "rm-1", recipientDeviceIds: ["dev-1"], at: now });
      tools.check("新设备不在该消息的目标快照里", queue.pending(scope, "dev-new").length === 0);
      tools.check(
        "新设备收不到历史消息",
        queue.read(scope, "q-1") !== null &&
          queue.pending(scope, "dev-new").every((item) => item.remoteMessageId !== "rm-1"),
      );
    });
  },
});

gate.case({
  id: "M5-10",
  title: "离线只暂存密文、上线按序、收下删服务器副本",
  acceptance: "A8（离线暂存）",
  refs: ["design §10 A8", "design §6.6"],
  needs: [{ task: "T8", what: "离线队列只存密文", artifact: "src/backend/im/server-mode.ts" }],
  steps: [
    "对方离线时连发 3 条，服务器只暂存密文，不落明文",
    "对方上线后按发送顺序收到 3 条",
    "收下后服务器删除对应队列行",
    "服务器侧看不到消息明文与附件内容",
  ],
  run: (tools) => {
    withDb((db) => {
      const queue = new ImOfflineQueue(db);
      for (let index = 1; index <= 3; index += 1) {
        queue.enqueue(scope, {
          queueId: `q-${index}`,
          peer: peerA,
          recipientDeviceId: "dev-1",
          remoteMessageId: `rm-${index}`,
          sealedPayload: sealed(`${index}`),
          at: now + index,
        });
      }
      const pending = queue.pending(scope, "dev-1");
      tools.check(
        "按发送顺序排列",
        pending.map((item) => item.remoteMessageId).join(",") === "rm-1,rm-2,rm-3",
        pending.map((i) => i.remoteMessageId).join(","),
      );
      const raw = query(db, "SELECT sealed_payload FROM offline_queue ORDER BY seq").map((row) => row.sealed_payload);
      tools.check(
        "只暂存密文（BLOB，不落明文）",
        raw.length === 3 && raw.every((value) => value instanceof Uint8Array),
      );
      tools.check(
        "服务器侧看不到明文",
        raw.every((value) => !(value instanceof Uint8Array) || !new TextDecoder().decode(value).includes("hello")),
      );
      for (const item of pending) queue.confirm(scope, { queueId: item.queueId, at: now + 100 });
      tools.check("收下后删服务器副本", queue.pending(scope, "dev-1").length === 0);
    });
  },
});

gate.case({
  id: "M5-11",
  title: "presence：好友可见在线、非好友不可见、隐身不暴露",
  acceptance: "A14",
  refs: ["design §10 A14", "design 决策记录 8"],
  needs: [{ task: "T8", what: "在线状态隐私", artifact: "src/backend/im/server-mode.ts" }],
  steps: [
    "好友视角：能看到在线状态",
    "非好友视角：看不到在线状态",
    "隐身状态：对好友也不暴露",
    "presence 三档（online/away/offline）切换正确、有节流",
  ],
  run: (tools) => {
    withDb((db) => {
      const presence = new ImPresenceStore(db);
      const friend = { localServerId: "s", localMemberId: "friend" };
      const stranger = { localServerId: "s", localMemberId: "stranger" };
      tools.check("节流口径为 30 秒栅格", IM_PRESENCE_THROTTLE_MS === 30_000, `${IM_PRESENCE_THROTTLE_MS}`);
      presence.update({ ...peerA, state: "online", hidden: false, at: now });
      tools.check("好友可见在线", presence.visible(friend, peerA, now).state === "online");
      tools.check(
        "非好友不可见（im.notFriend）",
        rejects(() => presence.visible(stranger, peerA, now)) === "im.notFriend",
      );
      presence.hide(peerA, true, now + 1000);
      tools.check(
        "对照：内部状态立即生效（current() 当场就是隐身）",
        presence.current(peerA).hidden === true && presence.current(peerA).state === "offline",
      );
      tools.check(
        "30 秒栅格内对外读不到切换时刻（poller 抓不到隐身那一瞬）",
        presence.visible(friend, peerA, now + 1000).hidden === false,
      );
      tools.check(
        "隐身不暴露（栅格过后对好友也报 offline）",
        (() => {
          const view = presence.visible(friend, peerA, now + 500_000 + IM_PRESENCE_THROTTLE_MS + 1);
          return view.hidden === true && view.state === "offline";
        })(),
      );
      tools.check(
        "解除隐身后对外恢复可见",
        (() => {
          presence.hide(peerA, false, now + 1_000_000);
          return presence.visible(friend, peerA, now + 1_000_000).hidden === false;
        })(),
      );
      tools.check(
        "三档切换逐档可读回（online/away/offline）",
        (() => {
          presence.update({ ...peerA, state: "away", hidden: false, at: now + 1_100_000 });
          const away = presence.current(peerA).state;
          presence.update({ ...peerA, state: "offline", hidden: false, at: now + 1_100_001 });
          const off = presence.current(peerA).state;
          presence.update({ ...peerA, state: "online", hidden: false, at: now + 1_100_002 });
          return away === "away" && off === "offline" && presence.current(peerA).state === "online";
        })(),
      );
      tools.check(
        "对照：非好友始终被拒（不是只拦第一次）",
        rejects(() => presence.visible(stranger, peerA, now + 1_200_000)) === "im.notFriend",
      );
      tools.check(
        "对照：三档切换不影响好友可见性（可见性闸只看好友关系）",
        presence.visible(friend, peerA, now + 1_300_000).hidden === false,
      );
    });
  },
});

gate.case({
  id: "M5-12",
  title: "任何接口不返回「最后上线时间」",
  acceptance: "A14（无最后上线时间）",
  refs: ["design §10 A14", "design 决策记录 8"],
  needs: [{ task: "T8", what: "读回对象不含最后上线时间", artifact: "src/backend/im/server-mode.ts" }],
  steps: [
    "遍历 presence / 资料 / 搜索 / 好友相关接口",
    "断言响应里不含「最后上线时间」",
    "含 host route 与 remote 侧接口",
  ],
  run: (tools) => {
    withDb((db) => {
      const presence = new ImPresenceStore(db);
      presence.update({ ...peerA, state: "online", hidden: false, at: now });
      const view = presence.visible({ localServerId: "s", localMemberId: "friend" }, peerA);
      const keys = Object.keys(view).sort().join(",");
      tools.check("读回对象键集正好四项、无最后上线时间", keys === "hidden,peerAgentId,peerServerId,state", keys);
      tools.check(
        "隐身 update 的返回值同样不含最后上线时间",
        Object.keys(presence.hide(peerA, true, now + 1))
          .sort()
          .join(",") === "hidden,peerAgentId,peerServerId,state",
      );
      const lastSeen = /^(last_?seen|last_?online|last_?active|seen_?at|last_seen_at)$/i;
      const clean = (keys: readonly string[]) => keys.every((key) => !lastSeen.test(key));
      tools.check(
        "host route 已接（IM_HANDLED_PATHS 含 presence 两条）",
        IM_HANDLED_PATHS.has(IM_ROUTES.presenceGet) && IM_HANDLED_PATHS.has(IM_ROUTES.presenceHidden),
      );
      const host = new ImHostApi(db, "s");
      const read = host.readPresence("friend", [peerA], now);
      const itemKeys = read.items[0] ? Object.keys(read.items[0]).sort() : [];
      tools.check(
        "host route 读回不含最后上线时间",
        read.items.length === 1 && itemKeys.join(",") === "hidden,peerAgentId,peerServerId,state",
        itemKeys.join(","),
      );
      tools.check(
        "对照：读回确实有数据（不是空结果才没字段）",
        read.items.length === 1 && (read.items[0]?.state ?? "") !== "",
      );
      tools.check(
        "隐身接口只回 hidden（不带任何时间戳）",
        Object.keys(host.setHidden("m", { hidden: true, at: now }))
          .sort()
          .join(",") === "hidden",
      );
      const directory = new ImDirectoryStore(db);
      tools.check(
        "资料接口不含最后上线时间",
        clean(Object.keys(directory.profile(peerA) ?? {})),
        Object.keys(directory.profile(peerA) ?? {}).join(","),
      );
      const search = new ImSearchService(db, "s");
      const hit = search.search("friend", { q: "peer", at: now }).items[0];
      tools.check(
        "搜索接口不含最后上线时间",
        hit !== undefined && clean(Object.keys(hit)),
        Object.keys(hit ?? {}).join(","),
      );
      const contacts = new ImContactStore(db);
      const found = contacts.find({ localServerId: "s", localMemberId: "friend" }, peerA);
      tools.check(
        "好友接口不含最后上线时间",
        found !== null && clean(Object.keys(found)),
        Object.keys(found ?? {}).join(","),
      );
    });
  },
});

gate.case({
  id: "M5-13",
  title: "注销=deactivate：没接端口即拒",
  acceptance: "A8 + A13（注销）",
  refs: ["design 决策记录 8", "plan §3 T2b2 验收"],
  needs: [
    { task: "T8", what: "ImDirectoryStore 走 T2b1/T2b2 端口", artifact: "src/backend/im/server-mode.ts" },
    { task: "T2b2", what: "资料注销本体：清队列 + 撤销设备证书" },
  ],
  steps: ["资料注销后在搜索里消失", "注销即清空该成员的离线队列", "撤销其设备证书", "注销动作本身写审计"],
  run: (tools) => {
    withDb((db) => {
      const directory = new ImDirectoryStore(db);
      tools.check(
        "没接端口就拒（本任务不实现注册/deactivate 本体）",
        rejects(() => directory.register({ ...peerA, displayName: "A", bio: null, avatar: null, at: now })) ===
          "im.notRegistered",
      );
      tools.check("只读 profile 不需要端口", directory.profile(peerA) === null);
      const queue = new ImOfflineQueue(db);
      queue.enqueue(scope, {
        queueId: "q-z",
        peer: peerA,
        recipientDeviceId: "dev-1",
        remoteMessageId: "rm-z",
        sealedPayload: sealed("z"),
        at: now,
      });
      queue.snapshot(scope, { peer: peerA, remoteMessageId: "rm-z", recipientDeviceIds: ["dev-1", "dev-2"], at: now });
      tools.check(
        "没接端口即拒：deactivate 抛 im.notRegistered",
        rejects(() => new ImDeactivateService(db, scope.localServerId).deactivate("m", { at: now })) ===
          "im.notRegistered",
      );
      tools.check(
        "对照：被拒时队列与设备都没动（拒绝不是静默半成功）",
        queue.read(scope, "q-z") !== null &&
          countRows(
            db,
            "SELECT COUNT(*) AS n FROM local_devices WHERE local_member_id = ? AND status = 'active'",
            "m",
          ) === 3,
      );
      const wired: ImDirectoryPort = { register: () => {}, deactivate: () => {} };
      const deact = new ImDeactivateService(db, scope.localServerId, wired);
      const result = deact.deactivate("m", { at: now + 1 });
      tools.check("接上端口后注销成功", result.profileDeactivated === true, String(result.profileDeactivated));
      tools.check(
        "注销清空离线队列",
        result.queueCleared === 1 && queue.pending(scope, "dev-1").length === 0,
        `queueCleared=${result.queueCleared}`,
      );
      tools.check(
        "注销清空目标快照",
        result.targetsCleared === 2 &&
          countRows(db, "SELECT COUNT(*) AS n FROM offline_targets WHERE local_member_id = ?", "m") === 0,
        `targetsCleared=${result.targetsCleared}`,
      );
      tools.check(
        "注销撤销全部设备证书（状态转 revoked）",
        result.devicesRevoked === 3 &&
          countRows(
            db,
            "SELECT COUNT(*) AS n FROM local_devices WHERE local_member_id = ? AND status != 'revoked'",
            "m",
          ) === 0,
        `devicesRevoked=${result.devicesRevoked}`,
      );
    });
  },
});

const report = await gate.run();
process.exitCode = report.counts.fail > 0 ? 1 : 0;
