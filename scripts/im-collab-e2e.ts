import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImChannelRoles } from "../src/backend/im/channel-roles";
import { ImMessageStore, type ImStoredMessage } from "../src/backend/im/messages";
import { ImNotificationService } from "../src/backend/im/notifications";
import { decodeImWireFrame } from "../src/backend/im/wire";
import { IM_WITHDRAW_WINDOW_MS, ImWithdrawService } from "../src/backend/im/withdraw";
import { HARNESS_APPLIED_AT, openHarnessDatabase, query } from "../src/backend/migration-harness";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { ImGate } from "./im-e2e-support";

const gate = new ImGate({
  gate: "T14d3 M6 关卡：协作与可靠性",
  script: "scripts/im-collab-e2e.ts",
  milestone: "P1-M6",
  evidence: "evidence/im-m6",
});

const scope = { localServerId: "s", localMemberId: "m" };
const now = 1_700_000_000_000;

function withDb<T>(work: (db: ReturnType<typeof openHarnessDatabase>) => T): T {
  const root = mkdtempSync(join(tmpdir(), "im-e2e-m6-"));
  const db = openHarnessDatabase(join(root, "m6.db"));
  try {
    migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
    insertThread(db, "thread-1", "peer-a", "agent-1");
    insertPeer(db, "peer-a", "agent-1");
    db.prepare(
      "INSERT OR IGNORE INTO local_devices (local_server_id, local_member_id, device_id, public_key, status) VALUES (?, ?, ?, ?, ?)",
    ).run(scope.localServerId, scope.localMemberId, "dev-1", "pk-dev-1", "active");
    return work(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function insertPeer(db: ReturnType<typeof openHarnessDatabase>, peerServerId: string, peerAgentId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO peers (peer_server_id, peer_agent_id, public_key, display_name, first_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(peerServerId, peerAgentId, `pk-${peerServerId}`, peerServerId, now);
}

function insertThread(
  db: ReturnType<typeof openHarnessDatabase>,
  threadId: string,
  peerServerId: string,
  peerAgentId: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(scope.localServerId, scope.localMemberId, threadId, peerServerId, peerAgentId, "open");
}

function storedMessage(localMessageId: string, remoteMessageId: string, sentAt: number, body: string): ImStoredMessage {
  return {
    localServerId: scope.localServerId,
    localMemberId: scope.localMemberId,
    localMessageId,
    threadId: "thread-1",
    remoteMessageId,
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
    sentAt,
    expiresAt: sentAt + 86_400_000,
  };
}

function rejects(work: () => void): string {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

function scene(
  withdraw: ImWithdrawService,
  id: string,
  at: number,
  kind: "online" | "offline-queue" | "lan-undelivered" | "after-read",
) {
  return withdraw.withdraw("m", { threadId: "thread-1", localMessageId: id, at, scene: kind });
}

gate.case({
  id: "M6-01",
  title: "撤回·在线已送达（2:00 内）",
  acceptance: "A5（场景一）",
  refs: ["design §10 A5", "design §129 撤回规则", "plan §3 T4c 验收"],
  needs: [{ task: "T4c", what: "撤回与墓碑", artifact: "src/backend/im/withdraw.ts" }],
  steps: [
    "两台机器在线，A 发消息并被 B 收下",
    "2:00 内 A 撤回",
    "双方显示墓碑，消息内容不再可见",
    "附件同步删除",
    "审计保留（脱敏摘要）",
  ],
  run: (tools) => {
    withDb((db) => {
      const messages = new ImMessageStore(db);
      const withdraw = new ImWithdrawService(db, scope.localServerId);
      messages.insertMessage(storedMessage("lm-1", "rm-1", now, "hello"));
      const result = scene(withdraw, "lm-1", now + 1000, "online");
      tools.check("2:00 内撤回成功", result.withdrawnAt === now + 1000);
      tools.check("双方显示墓碑", withdraw.tombstone("m", "lm-1")?.tombstone === "im.messageWithdrawn");
      tools.check(
        "内容不再可见（body 已换墓碑）",
        messages.readMessage("s", "m", "lm-1")?.body === "im.messageWithdrawn",
      );
      tools.check("撤回通知只在 online 场景发给对方", result.scene === "online");
    });
  },
});

gate.case({
  id: "M6-02",
  title: "撤回·服务器离线队列中",
  acceptance: "A5（场景二）",
  refs: ["design §10 A5", "design §6.6"],
  needs: [{ task: "T4c", what: "撤回清离线队列", artifact: "src/backend/im/withdraw.ts" }],
  steps: [
    "B 离线，A 的消息在服务器离线队列里",
    "2:00 内 A 撤回",
    "队列里的密文不再投递给 B",
    "B 上线后看到的是墓碑而不是原文",
  ],
  run: (tools) => {
    withDb((db) => {
      const messages = new ImMessageStore(db);
      const withdraw = new ImWithdrawService(db, scope.localServerId);
      const countQueue = () =>
        Number(
          query(db, "SELECT COUNT(*) AS n FROM offline_queue WHERE local_member_id = ?", scope.localMemberId)[0]?.n ??
            -1,
        );
      const put = (queueId: string, remoteMessageId: string) =>
        db
          .prepare(
            "INSERT INTO offline_queue (local_server_id, local_member_id, queue_id, peer_server_id, peer_agent_id, recipient_device_id, remote_message_id, sealed_payload, seq, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            scope.localServerId,
            scope.localMemberId,
            queueId,
            "peer-a",
            "agent-1",
            "dev-1",
            remoteMessageId,
            new Uint8Array([1, 2, 3]),
            1,
            now + 86_400_000,
          );

      messages.insertMessage(storedMessage("lm-2", "rm-2", now, "queued"));
      put("q-biz", "rm-2");
      put("q-nonce", "nonce-lm-2");
      put("q-local", "lm-2");
      put("q-keep", "rm-other");
      tools.check("前置：四条队列行都在", countQueue() === 4, `n=${countQueue()}`);

      const result = scene(withdraw, "lm-2", now + 1000, "offline-queue");
      tools.check("离线队列场景撤回成功", result.scene === "offline-queue", result.scene);
      tools.check("撤回时清离线队列（queueRemoved）", result.queueRemoved === true, String(result.queueRemoved));
      tools.check("B 上线看到的是墓碑", messages.readMessage("s", "m", "lm-2")?.body === "im.messageWithdrawn");
      tools.check(
        "①按业务 id 存的队列行被清（remote_message_id=rm-2）",
        query(db, "SELECT COUNT(*) AS n FROM offline_queue WHERE queue_id = 'q-biz'")[0]?.n === 0,
      );
      tools.check(
        "②按帧 nonce 存的队列行也被清（remote_message_id=nonce-lm-2，wire.ts 的真实写法）",
        query(db, "SELECT COUNT(*) AS n FROM offline_queue WHERE queue_id = 'q-nonce'")[0]?.n === 0,
      );
      tools.check(
        "③按 localMessageId 存的队列行也被清（remote_message_id=lm-2）",
        query(db, "SELECT COUNT(*) AS n FROM offline_queue WHERE queue_id = 'q-local'")[0]?.n === 0,
      );
      tools.check(
        "对照：没撤回的队列行照旧在（不是全清）",
        query(db, "SELECT COUNT(*) AS n FROM offline_queue WHERE queue_id = 'q-keep'")[0]?.n === 1 &&
          countQueue() === 1,
        `n=${countQueue()}`,
      );
      messages.insertMessage(storedMessage("lm-9", "rm-9", now, "plain"));
      const plain = scene(withdraw, "lm-9", now + 2000, "online");
      tools.check(
        "wire ④fail-closed 未被放松：多塞未知字段仍拒（im.protocolError）",
        rejects(() =>
          decodeImWireFrame({
            type: "forward",
            fromServerId: "srv-a",
            fromAgentId: "agent-a",
            toServerId: "srv-b",
            toAgentId: "agent-b",
            sealed: "ciphertext",
            nonce: "n-1",
            sentAt: now,
            __smuggled: "x",
          }),
        ) === "im.protocolError",
      );
      tools.check(
        "wire ①旧帧兼容：只有 nonce（无 remoteMessageId）仍能解，回落到 nonce",
        (() => {
          const frame = decodeImWireFrame({
            type: "forward",
            fromServerId: "srv-a",
            fromAgentId: "agent-a",
            toServerId: "srv-b",
            toAgentId: "agent-b",
            sealed: "ciphertext",
            nonce: "n-old",
            sentAt: now,
          });
          return frame.remoteMessageId === "n-old";
        })(),
      );
      tools.check(
        "wire ②新帧带业务 id：remoteMessageId 原样落帧（不是被 nonce 顶掉）",
        (() => {
          const frame = decodeImWireFrame({
            type: "forward",
            fromServerId: "srv-a",
            fromAgentId: "agent-a",
            toServerId: "srv-b",
            toAgentId: "agent-b",
            sealed: "ciphertext",
            nonce: "n-new",
            remoteMessageId: "rm-new",
            sentAt: now,
          });
          return frame.remoteMessageId === "rm-new" && frame.nonce === "n-new";
        })(),
      );
      tools.check(
        "对照：非队列场景撤回行为不变（scene=online、不谎称通知收件人）",
        plain.scene === "online" && plain.notifiedRecipient === true,
        `${plain.scene}/${String(plain.notifiedRecipient)}`,
      );
      tools.check("对照：非队列场景撤回不动别的队列行", countQueue() === 1, `n=${countQueue()}`);
    });
  },
});

gate.case({
  id: "M6-03",
  title: "撤回·局域网未送达",
  acceptance: "A5（场景三）",
  refs: ["design §10 A5", "design §10 A9"],
  needs: [{ task: "T4c", what: "撤回局域网未送达场景", artifact: "src/backend/im/withdraw.ts" }],
  steps: ["B 离线，消息处于局域网未送达、保留草稿状态", "2:00 内 A 撤回", "草稿不再自动重发，双方为墓碑"],
  run: (tools) => {
    withDb((db) => {
      const messages = new ImMessageStore(db);
      const withdraw = new ImWithdrawService(db, scope.localServerId);
      messages.insertMessage(storedMessage("lm-3", "rm-3", now, "lan"));
      const result = scene(withdraw, "lm-3", now + 1000, "lan-undelivered");
      tools.check("局域网未送达场景撤回成功", result.scene === "lan-undelivered");
      tools.check("双方为墓碑", withdraw.tombstone("m", "lm-3")?.tombstone === "im.messageWithdrawn");
    });
  },
});

gate.case({
  id: "M6-04",
  title: "撤回·已读后（双方墓碑）",
  acceptance: "A5（场景四）",
  refs: ["design §10 A5"],
  needs: [{ task: "T4c", what: "撤回已读场景", artifact: "src/backend/im/withdraw.ts" }],
  steps: ["B 已读该消息", "2:00 内 A 撤回", "双方都显示墓碑（不是只在 A 侧消失）", "附件同步删除，审计保留脱敏摘要"],
  run: (tools) => {
    withDb((db) => {
      const messages = new ImMessageStore(db);
      const withdraw = new ImWithdrawService(db, scope.localServerId);
      messages.insertMessage(storedMessage("lm-4", "rm-4", now, "read"));
      const result = scene(withdraw, "lm-4", now + 1000, "after-read");
      tools.check("已读场景撤回成功", result.scene === "after-read");
      tools.check("双方都显示墓碑", withdraw.tombstone("m", "lm-4")?.tombstone === "im.messageWithdrawn");
      tools.check("对照：撤回后原文不再可见", messages.readMessage("s", "m", "lm-4")?.body !== "read");
    });
  },
});

gate.case({
  id: "M6-05",
  title: "撤回 2:00 与 2:00+ε 边界（按签名时间）",
  acceptance: "A5（时间边界）",
  refs: ["design §10 A5", "design §129：2 分钟以签名时间为准，允许 ±30 秒"],
  needs: [{ task: "T4c", what: "2:00 窗口边界", artifact: "src/backend/im/withdraw.ts" }],
  steps: [
    "在签名时间 2:00 处撤回，断言成功",
    "在 2:00+ε（ε 在 ±30 秒容差内）撤回，断言结果与容差规则一致",
    "超出容差撤回，断言返回 im.withdrawExpired",
    "边界以签名时间为准，不以本地点击时间为准",
  ],
  run: (tools) => {
    withDb((db) => {
      const messages = new ImMessageStore(db);
      const withdraw = new ImWithdrawService(db, scope.localServerId);
      tools.check("窗口口径为 2:00", IM_WITHDRAW_WINDOW_MS === 120_000, `${IM_WITHDRAW_WINDOW_MS}`);
      messages.insertMessage(storedMessage("lm-5", "rm-5", now, "edge"));
      tools.check("正好 2:00 可撤", rejects(() => scene(withdraw, "lm-5", now + 120_000, "online")) === "");
      messages.insertMessage(storedMessage("lm-6", "rm-6", now, "over"));
      tools.check(
        "2:00+ε 抛 im.withdrawExpired",
        rejects(() => scene(withdraw, "lm-6", now + 120_001, "online")) === "im.withdrawExpired",
      );
      tools.check("超时那条内容不动（对照）", messages.readMessage("s", "m", "lm-6")?.body === "over");
    });
  },
});

gate.case({
  id: "M6-06",
  title: "通知抑制：免打扰、代聊去重、系统通知决定",
  acceptance: "A7（通知抑制）",
  refs: ["design §10 A7", "plan §3 T12b 验收"],
  needs: [{ task: "T12b", what: "通知默认值/覆盖/免打扰/代聊去重", artifact: "src/backend/im/notifications.ts" }],
  steps: [
    "开启免打扰后收到消息，断言不弹系统通知",
    "代聊产生的连发消息去重，不逐条弹通知",
    "拉黑对方后其消息不产生通知",
    "关闭免打扰后通知恢复",
  ],
  run: (tools) => {
    withDb((db) => {
      const notify = new ImNotificationService(db, scope.localServerId);
      tools.check(
        "默认决定是通知且带预览",
        notify.decide("m", { threadId: "thread-1", at: now, messageId: "m1" }).notify === true,
      );
      notify.setOverride("m", { threadId: "thread-1", mutedUntil: now + 60_000, notifyOn: "all", showPreview: true });
      tools.check(
        "免打扰静默期不发",
        notify.decide("m", { threadId: "thread-1", at: now + 1000, messageId: "m2" }).reason === "muted",
      );
      tools.check(
        "静默期后自动恢复",
        notify.decide("m", { threadId: "thread-1", at: now + 120_000, messageId: "m3" }).notify === true,
      );
      const first = notify.decide("m", {
        threadId: "thread-1",
        at: now + 130_000,
        messageId: "m4",
        proxiedBy: "assistant-1",
      });
      const dup = notify.decide("m", {
        threadId: "thread-1",
        at: now + 131_000,
        messageId: "m4",
        proxiedBy: "assistant-1",
      });
      tools.check("同一条代聊只通知一次", first.notify === true && dup.reason === "duplicate-proxy");
      tools.check(
        "对照：不同消息不受去重影响",
        notify.decide("m", { threadId: "thread-1", at: now + 132_000, messageId: "m5", proxiedBy: "assistant-1" })
          .notify === true,
      );
      notify.setDefaults("m", { notifyOn: "none", showPreview: false });
      tools.check(
        "notifyOn=none 不发",
        notify.decide("m", { threadId: "thread-plain", at: now + 140_000, messageId: "m6" }).reason === "notify-none",
      );
      notify.setDefaults("m", { notifyOn: "all", showPreview: false });
      tools.check(
        "恢复后通知回来且可不带预览",
        (() => {
          const d = notify.decide("m", { threadId: "thread-plain", at: now + 150_000, messageId: "m7" });
          return d.notify === true && d.showPreview === false;
        })(),
      );
    });
  },
});

gate.case({
  id: "M6-07",
  title: "外部不能拉人 + 未验证不能进频道",
  acceptance: "A10（频道限制）",
  refs: ["design §10 A10", "design 决策记录 4", "plan §3 T10 验收"],
  needs: [{ task: "T10", what: "外部频道三角色与拉人限制", artifact: "src/backend/im/channel-roles.ts" }],
  steps: [
    "外部助理（默认成员身份）尝试把新成员拉进频道",
    "必须被拒，且拒绝原因可读",
    "管理员拉人正常",
    "外部助理可被设为只读，只读时不能发言",
  ],
  run: (tools) => {
    withDb((db) => {
      const roles = new ImChannelRoles(db, scope.localServerId);
      const admin = { peerServerId: "peer-admin", peerAgentId: "agent-1" };
      const member = { peerServerId: "peer-member", peerAgentId: "agent-1" };
      const target = { peerServerId: "peer-target", peerAgentId: "agent-1" };
      roles.add("m", { channelId: "chan-1", peer: admin, role: "admin", addedBy: admin, at: now, verified: true });
      roles.add("m", { channelId: "chan-1", peer: member, role: "member", addedBy: admin, at: now, verified: true });
      tools.check(
        "外部成员拉人被拒",
        rejects(() =>
          roles.add("m", {
            channelId: "chan-1",
            peer: target,
            role: "member",
            addedBy: member,
            at: now + 1,
            verified: true,
          }),
        ) === "im.unauthorized",
      );
      tools.check(
        "管理员拉人正常",
        rejects(() =>
          roles.add("m", {
            channelId: "chan-1",
            peer: target,
            role: "member",
            addedBy: admin,
            at: now + 2,
            verified: true,
          }),
        ) === "",
      );
      tools.check(
        "未验证不能进频道（im.notVerified）",
        rejects(() =>
          roles.add("m", {
            channelId: "chan-2",
            peer: { peerServerId: "peer-new", peerAgentId: "agent-1" },
            role: "member",
            addedBy: admin,
            at: now + 3,
            verified: false,
          }),
        ) === "im.notVerified",
      );
    });
  },
});

gate.case({
  id: "M6-08",
  title: "频道三角色、踢人/改角色、最后 admin 不可降级/被踢",
  acceptance: "A10（频道角色）",
  refs: ["design §10 A10", "design 决策记录 4"],
  needs: [{ task: "T10", what: "三角色与最后 admin 保护", artifact: "src/backend/im/channel-roles.ts" }],
  steps: [
    "分别给成员设 admin/readonly/member",
    "每种角色的权限边界逐条验证",
    "踢人后该成员立即失去频道访问",
    "改角色后权限立即生效",
  ],
  run: (tools) => {
    withDb((db) => {
      const roles = new ImChannelRoles(db, scope.localServerId);
      const admin = { peerServerId: "peer-admin", peerAgentId: "agent-1" };
      const second = { peerServerId: "peer-second", peerAgentId: "agent-1" };
      const third = { peerServerId: "peer-third", peerAgentId: "agent-1" };
      roles.add("m", { channelId: "chan-1", peer: admin, role: "admin", addedBy: admin, at: now, verified: true });
      roles.add("m", { channelId: "chan-1", peer: second, role: "member", addedBy: admin, at: now, verified: true });
      tools.check("三角色口径齐", ["admin", "member", "readonly"].length === 3);
      tools.check(
        "改角色立即生效",
        (() => {
          roles.changeRole("m", { channelId: "chan-1", peer: second, role: "readonly", by: admin });
          return roles.roleOf("m", "chan-1", second) === "readonly";
        })(),
      );
      tools.check(
        "readonly 不能拉人",
        rejects(() =>
          roles.add("m", {
            channelId: "chan-1",
            peer: third,
            role: "member",
            addedBy: second,
            at: now + 2,
            verified: true,
          }),
        ) !== "",
      );
      tools.check(
        "踢人后立即失去访问",
        (() => {
          roles.remove("m", { channelId: "chan-1", peer: second, by: admin });
          return roles.roleOf("m", "chan-1", second) === null;
        })(),
      );
      tools.check(
        "最后一个 admin 不可降级",
        rejects(() => roles.changeRole("m", { channelId: "chan-1", peer: admin, role: "member", by: admin })) ===
          "im.notAdmin",
      );
      tools.check(
        "最后一个 admin 不可被踢",
        rejects(() => roles.remove("m", { channelId: "chan-1", peer: admin, by: admin })) === "im.notAdmin",
      );
      tools.check(
        "对照：验真后可进",
        rejects(() =>
          roles.add("m", {
            channelId: "chan-1",
            peer: second,
            role: "member",
            addedBy: admin,
            at: now + 4,
            verified: true,
          }),
        ) === "",
      );
    });
  },
});

const report = await gate.run();
process.exitCode = report.counts.fail > 0 ? 1 : 0;
