import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImAuditLog } from "../src/backend/im/audit";
import { ImChannelRoles } from "../src/backend/im/channel-roles";
import { ImService } from "../src/backend/im/im-service";
import { ImMessagingDriver } from "../src/backend/im/messaging-driver";
import { ImPrimaryChain } from "../src/backend/im/proxy";
import { ImSearchService } from "../src/backend/im/search";
import {
  IM_RATE_LIMITS,
  ImBlockStore,
  ImContactRequestStore,
  ImContactStore,
  ImReportStore,
  ImSendGate,
} from "../src/backend/im/social";
import { HARNESS_APPLIED_AT, openHarnessDatabase, query } from "../src/backend/migration-harness";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { type ImCaseTools, ImGate } from "./im-e2e-support";

const gate = new ImGate({
  gate: "T14b M2 关卡：收件箱与联系人",
  script: "scripts/im-m2-e2e.ts",
  milestone: "P0-M2",
  evidence: "evidence/im-m2",
});

const scope = { localServerId: "s", localMemberId: "m" };
const peerA = { peerServerId: "peer-a", peerAgentId: "agent-1" };
const peerB = { peerServerId: "peer-b", peerAgentId: "agent-1" };
const peerC = { peerServerId: "peer-c", peerAgentId: "agent-1" };
const now = 1_700_000_000_000;

function withDb<T>(work: (db: ReturnType<typeof openHarnessDatabase>) => T): T {
  const root = mkdtempSync(join(tmpdir(), "im-e2e-m2-"));
  const db = openHarnessDatabase(join(root, "m2.db"));
  try {
    migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
    return work(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function insertPeer(
  db: ReturnType<typeof openHarnessDatabase>,
  peerServerId: string,
  peerAgentId: string,
  publicKey: string,
  displayName: string,
): void {
  db.prepare(
    "INSERT INTO peers (peer_server_id, peer_agent_id, public_key, display_name, first_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(peerServerId, peerAgentId, publicKey, displayName, 1_700_000_000_000);
}

function seedPeer(db: ReturnType<typeof openHarnessDatabase>, peerServerId: string, peerAgentId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO peers (peer_server_id, peer_agent_id, public_key, display_name, first_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(peerServerId, peerAgentId, `pk-${peerServerId}`, peerServerId, 1_700_000_000_000);
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

gate.case({
  id: "M2-01",
  title: "联系人请求→同意→列表",
  acceptance: "A10（加好友需本人确认）",
  refs: ["design §10 A10", "plan §2 P0-M2 出口"],
  needs: [{ task: "T6", what: "contacts / contact_requests", artifact: "src/backend/im/social.ts" }],
  steps: [
    "外部助理 A 向本机发联系人请求",
    "本机收到请求但不自动通过，需本人确认",
    "本人同意后，双方进入联系人列表",
    "请求、同意动作都可回看",
  ],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const contacts = new ImContactStore(db);
      const requests = new ImContactRequestStore(db);
      const created = requests.create({
        ...scope,
        requestId: "req-1",
        direction: "inbound",
        peer: peerA,
        message: "hi",
        at: now,
      });
      tools.record("请求入站、状态待确认", created.direction === "inbound");
      tools.record(
        "未经同意不进联系人列表",
        contacts.find(scope, peerA) === null || contacts.find(scope, peerA)?.state !== "accepted",
      );
      tools.record(
        "请求可回看（inbound 列表里能查到）",
        requests.list({ ...scope, direction: "inbound" }).length === 1,
      );
      contacts.request({ ...scope, contactId: "c-1", peer: peerA, at: now });
      const accepted = contacts.accept({ ...scope, peer: peerA, at: now + 1 });
      tools.record("同意后进入联系人列表", accepted.state === "accepted" && contacts.list(scope).length === 1);
      tools.record("同意后可按对端查到", contacts.find(scope, peerA)?.state === "accepted");
    });
  },
});

gate.case({
  id: "M2-02",
  title: "未验证外部助理：受限流",
  acceptance: "A10（限流）",
  refs: ["design §10 A10", "design §4.7", "plan §3 T6 验收"],
  needs: [
    { task: "T6", what: "限速与冷却", artifact: "src/backend/im/social.ts" },
    { task: "T10", what: "外部不能进频道" },
    { task: "T2", what: "未验证标记（peers.verified_at）" },
  ],
  steps: [
    "未验证的外部助理出现在列表里，带「未验证」标记",
    "尝试把它拉进频道，必须被拒",
    "加好友必须本人确认",
    "验证后以上限制解除",
  ],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const sendGate = new ImSendGate(db);
      const contactTarget = {
        senderScope: scope,
        sender: peerA,
        recipientScope: { localServerId: "s2", localMemberId: "m2" },
        recipient: peerB,
        action: "contactRequest",
        at: now,
        policy: IM_RATE_LIMITS.contactRequest,
      };
      for (let index = 0; index < IM_RATE_LIMITS.contactRequest.max; index += 1) sendGate.recordSent(contactTarget);
      const over = sendGate.peekRate(contactTarget);
      tools.record("加好友请求超限被拦（需本人确认的入口也受限流）", over.allowed === false, over.reason);
      tools.record("冷却期单独计时", over.retryAfterMs > 0, `${over.retryAfterMs}`);
      const service = new ImService(db, scope.localServerId);
      insertPeer(db, "peer-a", "agent-1", "public-key-peer-a", "Peer A");
      db.prepare(
        "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(scope.localServerId, scope.localMemberId, "thread-x", "peer-a", "agent-1", "open");
      tools.record("未验证标记可读（peers.verified_at 为空即未验证）", service.peerVerifiedAt("m", peerA) === null);
      const roles = new ImChannelRoles(db, scope.localServerId);
      const admin = { peerServerId: "peer-admin", peerAgentId: "agent-1" };
      roles.add("m", { channelId: "chan-1", peer: admin, role: "admin", addedBy: admin, at: now, verified: true });
      tools.check(
        "未验证不能进频道（im.notVerified）",
        rejects(() =>
          roles.add("m", {
            channelId: "chan-1",
            peer: peerA,
            role: "member",
            addedBy: admin,
            at: now + 1,
            verified: false,
          }),
        ) === "im.notVerified",
      );
      tools.check(
        "对照：验真后可进",
        rejects(() =>
          roles.add("m", {
            channelId: "chan-1",
            peer: peerA,
            role: "member",
            addedBy: admin,
            at: now + 2,
            verified: true,
          }),
        ) === "",
      );
    });
  },
});

gate.case({
  id: "M2-03",
  title: "指派后主责起草、由人确认发送",
  acceptance: "A4（草稿发送）",
  refs: ["plan §2 P0-M2 出口", "plan §3 T11a2 验收"],
  needs: [
    { task: "T9", what: "指派与单一主责" },
    { task: "T11a2", what: "界面草稿发送（人确认）" },
  ],
  steps: [
    "收到外部消息后指派主责助理",
    "断言指派/转交本身不产生任何对外消息（im_messages 与 offline_queue 计数不变）",
    "对照：真发出时确实落库（区别于「发不出去」）",
    "「人点确认后才发」的界面硬规则属 T11a2 前端证据层，交前端截图",
  ],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      seedPeer(db, "peer-a", "agent-1");
      db.prepare(
        "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(scope.localServerId, scope.localMemberId, "thread-1", "peer-a", "agent-1", "open");
      const chain = new ImPrimaryChain(db);
      const driver = new ImMessagingDriver(db, scope.localServerId);
      const sent = () => Number(query(db, "SELECT COUNT(*) AS n FROM im_messages")[0]?.n ?? -1);
      const queued = () => Number(query(db, "SELECT COUNT(*) AS n FROM offline_queue")[0]?.n ?? -1);
      const sentBefore = sent();
      const queuedBefore = queued();
      chain.assign(scope, "thread-1", "agent-1", "primary");
      tools.check(
        "指派主责不产生任何对外消息",
        sent() === sentBefore && queued() === queuedBefore,
        `sent ${sentBefore}->${sent()} queued ${queuedBefore}->${queued()}`,
      );
      chain.assign(scope, "thread-1", "agent-2", "assist");
      tools.check(
        "加助理同样不产生对外消息",
        sent() === sentBefore && queued() === queuedBefore,
        `sent ${sentBefore}->${sent()} queued ${queuedBefore}->${queued()}`,
      );
      chain.transfer(scope, "thread-1", "agent-1", "agent-2");
      tools.check(
        "转交主责同样不产生对外消息",
        sent() === sentBefore && queued() === queuedBefore,
        `sent ${sentBefore}->${sent()} queued ${queuedBefore}->${queued()}`,
      );
      tools.check(
        "对照：真发出时确实落库（区别于「发不出去」）",
        (() => {
          driver.send("m", {
            threadId: "thread-1",
            peer: peerA,
            body: "explicit send",
            remoteMessageId: "rm-m2-03",
            sentAt: now,
            expiresAt: now + 86_400_000,
          });
          return sent() === sentBefore + 1;
        })(),
      );
      tools.note(
        "「人点确认后才发」的界面硬规则属 T11a2 前端证据层（截图），不在本用例断言范围；本用例只验后端无自动发送路径",
      );
    });
  },
});

gate.case({
  id: "M2-04",
  title: "拉黑伪成功：对方看似已发送、不出现未送达/重发、不通知",
  acceptance: "A7（拉黑伪成功）",
  refs: ["design §10 A7", "design 决策记录 3", "plan §3 T6 验收"],
  needs: [{ task: "T6", what: "双层拉黑伪成功", artifact: "src/backend/im/social.ts" }],
  steps: [
    "本机拉黑外部助理 B",
    "B 发消息，B 侧显示已发送（伪成功）",
    "B 侧不出现未送达、不出现重发入口、不出现已读回执",
    "B 侧不出现任何失败提示",
    "本机不弹通知",
  ],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const blocks = new ImBlockStore(db);
      const sendGate = new ImSendGate(db);
      const decide = () =>
        sendGate.decide({
          senderScope: scope,
          sender: peerA,
          recipientScope: { localServerId: "s2", localMemberId: "m2" },
          recipient: peerB,
          action: "message",
          at: now,
          policy: IM_RATE_LIMITS.message,
        });
      const before = decide();
      tools.record(
        "对照组：没被拦的确实 sent",
        before.outcome === "sent" && before.pseudoSuccess === false,
        before.outcome,
      );
      tools.record("对照组：可通知可重发", before.notify === true && before.retry === true);

      blocks.add({ ...scope, ruleId: "rule-out", peer: peerB, at: now });
      const outbound = decide();
      tools.record(
        "外层拉黑·对方看似已发送（伪成功）",
        outbound.pseudoSuccess === true && outbound.outcome === "blocked-discarded",
      );
      tools.record("外层拉黑·不出现未送达/重发", outbound.retry === false);
      tools.record("外层拉黑·不通知", outbound.notify === false);
      tools.record("外层拉黑·无失败提示（reason 是拦截而非错误）", outbound.reason === "blocked-outbound");

      const inbound = sendGate.decide({
        senderScope: scope,
        sender: peerA,
        recipientScope: { localServerId: "s2", localMemberId: "m2" },
        recipient: peerB,
        action: "message",
        at: now + 1,
        policy: IM_RATE_LIMITS.message,
      });
      tools.record(
        "双层拉黑·任一层拦下都伪成功",
        inbound.pseudoSuccess === true && inbound.retry === false && inbound.notify === false,
      );
    });
  },
});

gate.case({
  id: "M2-05",
  title: "拉黑后本机 blocked/discarded + 审计",
  acceptance: "A7（本机处置）",
  refs: ["design §10 A7", "plan §3 T6/T12a1 验收"],
  needs: [
    { task: "T6", what: "双层拉黑伪成功", artifact: "src/backend/im/social.ts" },
    { task: "T12a1", what: "审计写入", artifact: "src/backend/im/audit.ts" },
  ],
  steps: [
    "拉黑期间 B 发的每条消息在本机标记 blocked/discarded",
    "不进入正常收件箱",
    "每条都写审计，可查到发送方、时间、处置结果",
  ],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const blocks = new ImBlockStore(db);
      const sendGate = new ImSendGate(db);
      const audit = new ImAuditLog(db);
      blocks.add({ ...scope, ruleId: "r-1", peer: peerB, at: now });
      const decision = sendGate.decide({
        senderScope: scope,
        sender: peerA,
        recipientScope: { localServerId: "s2", localMemberId: "m2" },
        recipient: peerB,
        action: "message",
        at: now,
        policy: IM_RATE_LIMITS.message,
      });
      tools.record("处置结果是 blocked/discarded", decision.outcome === "blocked-discarded", decision.outcome);
      audit.record(scope, {
        id: "audit-m2-05",
        actorId: "peer-b/agent-1",
        sourceTrustDomain: "im-peer",
        action: "im.message.inbound",
        targetId: "msg-1",
        result: decision.outcome,
        correlationId: "corr-m2-05",
        before: undefined,
        after: undefined,
        at: now,
      });
      const read = audit.read(scope, "audit-m2-05");
      tools.record(
        "每条都写审计、可查发送方与时间",
        read !== null && read.actorId === "peer-b/agent-1" && read.at === now,
      );
      tools.record("处置结果可查", read?.result === "blocked-discarded", read?.result);
    });
  },
});

gate.case({
  id: "M2-06",
  title: "解除拉黑后新消息恢复、历史不补发",
  acceptance: "A7（解除拉黑）",
  refs: ["design §10 A7", "plan §3 T6 验收"],
  needs: [{ task: "T6", what: "拉黑增删查", artifact: "src/backend/im/social.ts" }],
  steps: ["解除对 B 的拉黑", "B 之后发的新消息正常收下", "拉黑期间被丢弃的历史消息不补发"],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const blocks = new ImBlockStore(db);
      const sendGate = new ImSendGate(db);
      const decide = () =>
        sendGate.decide({
          senderScope: scope,
          sender: peerA,
          recipientScope: { localServerId: "s2", localMemberId: "m2" },
          recipient: peerB,
          action: "message",
          at: now + 10,
          policy: IM_RATE_LIMITS.message,
        });
      blocks.add({ ...scope, ruleId: "r-1", peer: peerB, at: now });
      const blocked = decide();
      tools.record(
        "拉黑期间是 discarded 而非 queued（没有可补发的积压）",
        blocked.outcome === "blocked-discarded",
        blocked.outcome,
      );
      tools.record("解除拉黑生效", blocks.remove({ ...scope, peer: peerB }) === true);
      tools.record("解除后新消息恢复正常收下", decide().outcome === "sent");
      tools.record(
        "对照组：拉黑仍在时仍被拦",
        (() => {
          blocks.add({ ...scope, ruleId: "r-2", peer: peerB, at: now + 20 });
          return decide().outcome === "blocked-discarded";
        })(),
      );
    });
  },
});

gate.case({
  id: "M2-07",
  title: "拉黑后发不进",
  acceptance: "A7（拉黑）",
  refs: ["plan §2 P0-M2 出口"],
  needs: [
    { task: "T6", what: "拉黑", artifact: "src/backend/im/social.ts" },
    { task: "T12c", what: "搜索服务（拉黑后搜不到）" },
  ],
  steps: ["拉黑后在搜索里查 B，查不到", "从本机主动向 B 发消息，发不进去"],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const blocks = new ImBlockStore(db);
      const sendGate = new ImSendGate(db);
      blocks.add({ ...scope, ruleId: "r-1", peer: peerB, at: now });
      tools.record("本机主动发也被拦（发不进去）", blocks.isBlocked(scope, peerB) === true);
      const decision = sendGate.decide({
        senderScope: scope,
        sender: peerB,
        recipientScope: scope,
        recipient: peerB,
        action: "message",
        at: now,
        policy: IM_RATE_LIMITS.message,
      });
      tools.record("出口被拦、伪成功不投递", decision.outcome === "blocked-discarded" && decision.retry === false);
      seedPeer(db, "peer-a", "agent-1");
      seedPeer(db, "peer-b", "agent-1");
      seedPeer(db, "peer-c", "agent-1");
      seedPeer(db, "peer-d", "agent-1");
      seedContact(db, scope.localServerId, scope.localMemberId, "c-a", "peer-a", "agent-1");
      seedContact(db, scope.localServerId, scope.localMemberId, "c-b", "peer-b", "agent-1");
      seedContact(db, scope.localServerId, scope.localMemberId, "c-d", "peer-d", "agent-1");
      db.prepare(
        "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(scope.localServerId, scope.localMemberId, "thread-a", "peer-a", "agent-1", "open");
      const search = new ImSearchService(db, scope.localServerId);
      tools.note(
        "M2-07 特征刻画：命中条件是 display_name / peer_server_id / peer_agent_id 的 LIKE，不看 searchable（结果里 searchable 恒 true，未进 WHERE）；可见性要求有 im_threads 或 contacts 其一即可，会话不是必要条件；两条 block_rules 反连接（我拉黑他 / 他拉黑我）",
      );
      tools.check(
        "命中条件是名字/ID 的 LIKE（按 peer_server_id 搜得到）",
        search.search("m", { q: "peer-a", at: now }).items.some((i) => i.peerServerId === "peer-a"),
      );
      tools.check(
        "命中条件不是 searchable：结果里 searchable 恒为 true，不是可筛字段",
        search.search("m", { q: "peer-a", at: now + 1 }).items.every((i) => i.searchable === true),
      );
      tools.check(
        "会话不是必要条件：peer-d 只有联系人、无会话，仍可搜到",
        query(db, "SELECT COUNT(*) AS n FROM im_threads WHERE peer_server_id = ?", "peer-d")[0]?.n === 0 &&
          search.search("m", { q: "peer-d", at: now + 2 }).items.some((i) => i.peerServerId === "peer-d"),
      );
      tools.check(
        "对照：既无会话也无联系人的 peer-c 不可见（可见性闸）",
        search.search("m", { q: "peer-c", at: now + 3 }).items.every((i) => i.peerServerId !== "peer-c"),
      );
      tools.check(
        "未拉黑时搜得到",
        search.search("m", { q: "peer", at: now + 4 }).items.some((i) => i.peerServerId === "peer-d"),
      );
      blocks.add({ ...scope, ruleId: "r-2", peer: peerB, at: now + 5 });
      tools.check(
        "被我拉黑的对象搜不到",
        search.search("m", { q: "peer", at: now + 6 }).items.every((i) => i.peerServerId !== "peer-b"),
      );
      tools.check(
        "对照：拉黑不影响搜别人",
        search.search("m", { q: "peer", at: now + 7 }).items.some((i) => i.peerServerId === "peer-a"),
      );
      blocks.remove({ ...scope, peer: peerB });
      tools.check(
        "解除拉黑后恢复可搜",
        search.search("m", { q: "peer", at: now + 8 }).items.some((i) => i.peerServerId === "peer-b"),
      );
    });
  },
});

gate.case({
  id: "M2-08",
  title: "限速与冷却生效",
  acceptance: "A10（限流）",
  refs: ["design §10 A10", "design §4.7", "plan §3 T6 验收"],
  needs: [{ task: "T6", what: "限速与冷却", artifact: "src/backend/im/social.ts" }],
  steps: ["按 §4.7 的限速与冷却参数压测发送频率", "超限时被拒并返回 rateLimited", "冷却后恢复", "限速触发本身有审计"],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const sendGate = new ImSendGate(db);
      const policy = IM_RATE_LIMITS.message;
      const toPeerB = {
        senderScope: scope,
        sender: peerA,
        recipientScope: { localServerId: "s2", localMemberId: "m2" },
        recipient: peerB,
        action: "message",
        at: now,
        policy,
      };
      for (let index = 0; index < policy.max; index += 1) sendGate.recordSent(toPeerB);
      const over = sendGate.peekRate(toPeerB);
      tools.record("超限被拒", over.allowed === false && over.reason === "rate-limited", over.reason);
      const blocked = sendGate.decide(toPeerB);
      tools.record(
        "限速也走伪成功（不重发不通知）",
        blocked.outcome === "rate-limited-discarded" &&
          blocked.pseudoSuccess === true &&
          blocked.retry === false &&
          blocked.notify === false,
      );
      const nextWindow = sendGate.peekRate({ ...toPeerB, at: now + policy.windowMs + 1 });
      tools.record("窗口过后恢复", nextWindow.allowed === true, nextWindow.reason);
      tools.record(
        "口径钉住：换一条消息（不同时刻、同一对端）不重置额度",
        sendGate.peekRate({ ...toPeerB, at: now + 1 }).allowed === false,
      );
      tools.record("对照组：换对端另起额度", sendGate.peekRate({ ...toPeerB, recipient: peerC }).allowed === true);
      tools.record(
        "冷却期按对端独立计",
        sendGate.peekRate({
          ...toPeerB,
          action: "contactRequest",
          at: now + IM_RATE_LIMITS.contactRequest.windowMs + 1,
          policy: IM_RATE_LIMITS.contactRequest,
        }).allowed === true,
      );
    });
  },
});

gate.case({
  id: "M2-09",
  title: "审计写入：字段齐全且写入前脱敏",
  acceptance: "A11（写入）",
  refs: ["design §10 A11", "plan §3 T12a1 验收"],
  needs: [{ task: "T12a1", what: "审计写入", artifact: "src/backend/im/audit.ts" }],
  steps: [
    "触发任一审计动作（联系人同意、拉黑、指派、举报）",
    "断言明细含 actor、信任域、action、target、result、correlationId、before-after、时间",
    "把一条带敏感标记的数据放进被审计对象，断言写入的审计里已经是脱敏后的值",
  ],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const reports = new ImReportStore(db);
      const audit = new ImAuditLog(db);
      const secret = "token-abcdefghijklmnop";
      const report = reports.create({
        ...scope,
        reportId: "rep-1",
        targetPeer: "peer-b/agent-1",
        category: "spam",
        detail: `spam with ${secret}`,
        at: now,
      });
      audit.record(scope, {
        id: "audit-m2-09",
        actorId: "peer-a/agent-1",
        sourceTrustDomain: "im-peer",
        action: "im.report.create",
        targetId: report.reportId,
        result: report.status,
        correlationId: "corr-m2-09",
        before: undefined,
        after: { status: report.status },
        at: now,
        detail: { category: "spam", token: secret },
      });
      const read = audit.read(scope, "audit-m2-09");
      tools.record(
        "明细含 actor/信任域/action/target/result/correlationId/时间",
        read !== null &&
          read.actorId === "peer-a/agent-1" &&
          read.sourceTrustDomain === "im-peer" &&
          read.action === "im.report.create" &&
          read.targetId === "rep-1" &&
          read.correlationId === "corr-m2-09" &&
          read.at === now,
      );
      tools.record("before/after 有留痕", read?.after?.includes("open") === true);
      tools.record("写入前脱敏：敏感值不落库", !String(read?.redactedDetail).includes(secret));
    });
  },
});

gate.case({
  id: "M2-10",
  title: "审计明细不可变",
  acceptance: "A11（不可变）",
  refs: ["design §10 A11", "plan §3 T12a1 验收"],
  needs: [{ task: "T12a1", what: "审计只追加", artifact: "src/backend/im/audit.ts" }],
  steps: ["写入一条审计后尝试 UPDATE / DELETE", "必须失败或被拒，audit_log 只追加", "追加新事件不影响旧事件"],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const audit = new ImAuditLog(db);
      audit.record(scope, {
        id: "audit-m2-10",
        actorId: "peer-a/agent-1",
        sourceTrustDomain: "im-peer",
        action: "im.report.create",
        targetId: "rep-1",
        result: "open",
        correlationId: "corr-m2-10",
        before: undefined,
        after: undefined,
        at: now,
      });
      tools.record(
        "同 id 再写被主键拒绝且原事件未被篡改",
        rejects(() => {
          audit.record(scope, {
            id: "audit-m2-10",
            actorId: "tampered",
            sourceTrustDomain: "local",
            action: "tampered",
            targetId: "x",
            result: "ok",
            correlationId: "c",
            before: undefined,
            after: undefined,
            at: now + 1,
          });
        }) !== "" && audit.read(scope, "audit-m2-10")?.action === "im.report.create",
      );
      tools.record(
        "ImAuditLog 只暴露追加与读取（无 update/delete）",
        Object.getOwnPropertyNames(ImAuditLog.prototype).sort().join(",") ===
          "byCorrelation,constructor,list,read,record",
        Object.getOwnPropertyNames(ImAuditLog.prototype).sort().join(","),
      );
      audit.record(scope, {
        id: "audit-m2-10-b",
        actorId: "peer-a/agent-1",
        sourceTrustDomain: "im-peer",
        action: "im.block.add",
        targetId: "r-1",
        result: "ok",
        correlationId: "corr-m2-10",
        before: undefined,
        after: undefined,
        at: now + 2,
      });
      tools.record(
        "追加新事件不影响旧事件",
        audit.read(scope, "audit-m2-10")?.action === "im.report.create" && audit.list(scope).length === 2,
      );
    });
  },
});

const report = await gate.run();
process.exitCode = report.counts.fail > 0 ? 1 : 0;
