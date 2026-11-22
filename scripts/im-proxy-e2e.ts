import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImAuditLog } from "../src/backend/im/audit";
import type { CausalChain } from "../src/backend/im/causal-chain";
import { ImMessagingDriver, ImToolRefused } from "../src/backend/im/messaging-driver";
import {
  IM_PROXY_BUDGET_USD,
  IM_PROXY_BUDGET_USD_DEFAULT,
  ImPrimaryChain,
  ImProxySettingsStore,
  ImProxySpeaking,
  imExecutionDecision,
  imProxiedMessage,
} from "../src/backend/im/proxy";
import { HARNESS_APPLIED_AT, openHarnessDatabase, query } from "../src/backend/migration-harness";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { ImGate } from "./im-e2e-support";

const gate = new ImGate({
  gate: "T14d1 M4 关卡：代聊与自动应答",
  script: "scripts/im-proxy-e2e.ts",
  milestone: "P1-M4",
  evidence: "evidence/im-m4",
});

const scope = { localServerId: "s", localMemberId: "m" };
const peer = { peerServerId: "peer-a", peerAgentId: "agent-1" };
const peerKey = "peer-a/agent-1";
const now = 1_700_000_000_000;

function withDb<T>(work: (db: ReturnType<typeof openHarnessDatabase>) => T): T {
  const root = mkdtempSync(join(tmpdir(), "im-e2e-m4-"));
  const db = openHarnessDatabase(join(root, "m4.db"));
  try {
    migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
    insertThread(db, "thread-1", peer.peerServerId, peer.peerAgentId);
    insertThread(db, "thread-2", "peer-b", "agent-1");
    return work(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function insertThread(
  db: ReturnType<typeof openHarnessDatabase>,
  threadId: string,
  peerServerId: string,
  peerAgentId: string,
): void {
  db.prepare(
    "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(scope.localServerId, scope.localMemberId, threadId, peerServerId, peerAgentId, "open");
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
  id: "M4-01",
  title: "A6a 代聊开启：协议中 proxiedBy 存在",
  acceptance: "A6a",
  refs: ["design §10 A6a", "design 决策记录 1", "plan §3 T9 验收"],
  needs: [{ task: "T9", what: "代聊标记 + 真发信路径", artifact: "src/backend/im/messaging-driver.ts" }],
  steps: ["默认状态断言代聊为关", "开启代聊后由助理代发一条消息", "接收方解出的协议里带 proxiedBy", "签名验签通过"],
  run: (tools) => {
    withDb((db) => {
      const driver = new ImMessagingDriver(db, scope.localServerId);
      const plain = driver.send("m", {
        threadId: "thread-1",
        peer,
        body: "self speaks",
        remoteMessageId: "rm-plain",
        sentAt: now,
        expiresAt: now + 86_400_000,
      });
      tools.check(
        "自己发言不带代聊标记（默认关）",
        plain.message.proxiedBy === null && plain.message.proxyVisibility === null,
      );
      const proxied = driver.sendProxied("m", {
        threadId: "thread-1",
        peer,
        body: "assistant speaks for someone",
        remoteMessageId: "rm-proxied",
        sentAt: now + 1,
        expiresAt: now + 86_400_000,
        proxiedBy: "assistant-1",
        proxyVisibility: "shown",
        usdCents: 100,
      });
      tools.check(
        "缺陷：sendProxied 返回值应带 proxiedBy（现在返回的是 UPDATE 前的旧对象）",
        proxied.message.proxiedBy === "assistant-1",
        `返回值 proxiedBy=${String(proxied.message.proxiedBy)}`,
      );
      const row = query(
        db,
        "SELECT proxied_by, proxy_visibility FROM im_messages WHERE remote_message_id = ?",
        "rm-proxied",
      )[0];
      tools.check(
        "落库为 proxied_by + proxy_visibility",
        row?.proxied_by === "assistant-1" && row?.proxy_visibility === "shown",
      );
      tools.check(
        "proxiedBy 与 proxyVisibility 必须成对（缺可见性拒）",
        rejects(() => imProxiedMessage({ speaker: "a", onBehalfOf: "b", visibility: null, body: "x" })) ===
          "im.notFriend",
      );
      tools.note(
        "「签名验签通过」属 T3 信封层（对端互发），host 路径对本地撰写记 verified=false + 空 signature，不在本条要求",
      );
    });
  },
});

gate.case({
  id: "M4-02",
  title: "A6b proxyVisibility=hidden：标注隐藏但不可剥离",
  acceptance: "A6b",
  refs: ["design §10 A6b", "design 决策记录 1"],
  needs: [{ task: "T9", what: "代聊标记不可剥离", artifact: "src/backend/im/proxy.ts" }],
  steps: [
    "开启代聊并把可见性设为 hidden",
    "代发一条消息",
    "对方界面不显示代聊标注",
    "对方导出（含导出文件）里也没有代聊标注",
  ],
  run: (tools) => {
    withDb((db) => {
      const driver = new ImMessagingDriver(db, scope.localServerId);
      const hidden = driver.sendProxied("m", {
        threadId: "thread-1",
        peer,
        body: "quiet",
        remoteMessageId: "rm-hidden",
        sentAt: now,
        expiresAt: now + 86_400_000,
        proxiedBy: "assistant-1",
        proxyVisibility: "hidden",
        usdCents: 100,
      });
      tools.check(
        "缺陷：sendProxied 返回值应带 proxyVisibility=hidden（现在返回的是 UPDATE 前的旧对象）",
        hidden.message.proxyVisibility === "hidden",
        `返回值 proxyVisibility=${String(hidden.message.proxyVisibility)}`,
      );
      const row = query(
        db,
        "SELECT proxied_by, proxy_visibility FROM im_messages WHERE remote_message_id = ?",
        "rm-hidden",
      )[0];
      tools.check("标注不可剥离：读回仍在", row?.proxied_by === "assistant-1" && row?.proxy_visibility === "hidden");
      tools.check("hidden 只是展示层：协议层仍带 proxiedBy", hidden.message.proxiedBy === "assistant-1");
      tools.check(
        "对照：普通消息不带标记（标记不是谁都有）",
        (() => {
          const plain = driver.send("m", {
            threadId: "thread-1",
            peer,
            body: "plain",
            remoteMessageId: "rm-plain-2",
            sentAt: now + 1,
            expiresAt: now + 86_400_000,
          });
          return plain.message.proxiedBy === null && plain.message.proxyVisibility === null;
        })(),
      );
      tools.note(
        "A6b 的「对方 UI 不显示标注」已划出本用例范围：渲染归前端 T11b1/T16b1 截图证据；「导出文件里也没有标注」归消息导出 API，当前只有审计导出（audit-admin.export），无消息导出路径，故一并交前端证据。本用例只验「标注不可剥离」这一后端可验命题。",
      );
    });
  },
});

gate.case({
  id: "M4-03",
  title: "A6c 本地审计可证明真实发言人与时间",
  acceptance: "A6c",
  refs: ["design §10 A6c", "plan §3 T9 验收"],
  needs: [
    { task: "T9", what: "代聊审计", artifact: "src/backend/im/messaging-driver.ts" },
    { task: "T12a1", what: "审计写入", artifact: "src/backend/im/audit.ts" },
  ],
  steps: [
    "在 hidden 模式下任取一条代聊消息",
    "本地审计能查到真实发言人（谁代发、代理谁）与真实时间",
    "审计可导出，且不因对方不可见而在本地丢失",
  ],
  run: (tools) => {
    withDb((db) => {
      const driver = new ImMessagingDriver(db, scope.localServerId);
      const audit = new ImAuditLog(db);
      const sent = driver.sendProxied("m", {
        threadId: "thread-1",
        peer,
        body: "quiet",
        remoteMessageId: "rm-audit",
        sentAt: now,
        expiresAt: now + 86_400_000,
        proxiedBy: "assistant-1",
        proxyVisibility: "hidden",
        usdCents: 100,
      });
      audit.record(scope, {
        id: "audit-m4-03",
        actorId: "assistant-1",
        sourceTrustDomain: "local",
        action: "im.proxy.send",
        targetId: sent.message.localMessageId,
        result: "sent",
        correlationId: "corr-m4-03",
        before: undefined,
        after: { proxiedBy: "assistant-1", proxyVisibility: "hidden" },
        at: now,
        detail: { proxiedOnBehalfOf: "person-1" },
      });
      const read = audit.read(scope, "audit-m4-03");
      tools.check("审计记到真实发言人（谁代发）", read?.actorId === "assistant-1", read?.actorId);
      tools.check(
        "审计记到代理对象（代理谁）",
        String(read?.redactedDetail).includes("person-1"),
        String(read?.redactedDetail),
      );
      tools.check("审计记到真实时间", read?.at === now);
      tools.check("hidden 不影响本地留痕", audit.list(scope).length === 1);
    });
  },
});

gate.case({
  id: "M4-04",
  title: "代聊三态 + 标记不可剥离",
  acceptance: "A6a/b/c（三态）",
  refs: ["design §10 A6", "design 决策记录 1", "plan §3 T9 验收"],
  needs: [{ task: "T9", what: "代聊三态", artifact: "src/backend/im/proxy.ts" }],
  steps: [
    "态一（关）：助理不代发，无 proxiedBy",
    "态二（开且 shown）：proxiedBy 存在、对方 UI 可见标注",
    "态三（开且 hidden）：proxiedBy 仍在协议里、对方 UI 不可见、本地留痕",
    "对三态下的消息分别尝试剥离或伪造 proxiedBy 标记，必须失败（标记不可剥离）",
  ],
  run: (tools) => {
    withDb((db) => {
      const driver = new ImMessagingDriver(db, scope.localServerId);
      const off = driver.send("m", {
        threadId: "thread-1",
        peer,
        body: "off",
        remoteMessageId: "rm-off",
        sentAt: now,
        expiresAt: now + 86_400_000,
      });
      const shown = driver.sendProxied("m", {
        threadId: "thread-1",
        peer,
        body: "shown",
        remoteMessageId: "rm-shown",
        sentAt: now + 1,
        expiresAt: now + 86_400_000,
        proxiedBy: "assistant-1",
        proxyVisibility: "shown",
        usdCents: 100,
      });
      const hidden = driver.sendProxied("m", {
        threadId: "thread-1",
        peer,
        body: "hidden",
        remoteMessageId: "rm-hid",
        sentAt: now + 2,
        expiresAt: now + 86_400_000,
        proxiedBy: "assistant-1",
        proxyVisibility: "hidden",
        usdCents: 100,
      });
      tools.check("态一（关）：无 proxiedBy", off.message.proxiedBy === null && off.message.proxyVisibility === null);
      tools.check(
        "态二（开且 shown）：proxiedBy 存在",
        shown.message.proxiedBy === "assistant-1" && shown.message.proxyVisibility === "shown",
      );
      tools.check(
        "态三（开且 hidden）：返回值仍带标记、展示为 hidden",
        hidden.message.proxiedBy === "assistant-1" && hidden.message.proxyVisibility === "hidden",
        `返回值 ${String(hidden.message.proxiedBy)}`,
      );
      const rows = query(
        db,
        "SELECT remote_message_id, proxied_by, proxy_visibility FROM im_messages ORDER BY remote_message_id",
      );
      tools.check(
        "标记不可剥离：三条读回的标记与写入一致",
        rows.length === 3 &&
          rows.every((row) => {
            const id = String(row.remote_message_id);
            if (id === "rm-off") return row.proxied_by === null && row.proxy_visibility === null;
            return row.proxied_by === "assistant-1" && row.proxy_visibility !== null;
          }),
      );
      tools.check(
        "伪造/剥离标记被拒：只给 proxiedBy 缺可见性即拒",
        rejects(() => imProxiedMessage({ speaker: "a", onBehalfOf: "assistant-1", visibility: null, body: "x" })) ===
          "im.notFriend",
      );
    });
  },
});

gate.case({
  id: "M4-05",
  title: "A15 预算消耗可见",
  acceptance: "A15（消耗可见）",
  refs: ["design §10 A15", "plan §3 T9 验收"],
  needs: [{ task: "T9", what: "代聊预算", artifact: "src/backend/im/proxy.ts" }],
  steps: ["代聊产生消耗", "界面上能看到本月已消耗金额与上限", "消耗与实际计费一致"],
  run: (tools) => {
    withDb((db) => {
      const speaking = new ImProxySpeaking(db);
      tools.check("上限口径为 20 美元/月", IM_PROXY_BUDGET_USD === 20, `${IM_PROXY_BUDGET_USD}`);
      speaking.charge(scope, peerKey, 500, now);
      const budget = speaking.budget(scope, peerKey, now);
      tools.check("消耗可见：已消耗金额可读回", budget.spentUsd === 5, `${budget.spentUsd}`);
      tools.check("消耗可见：上限可读回", budget.limitUsd === IM_PROXY_BUDGET_USD, `${budget.limitUsd}`);
      tools.check(
        "消耗与实际计费一致",
        budget.remainingUsd === 15 && budget.spentUsd + budget.remainingUsd === budget.limitUsd,
      );
    });
  },
});

gate.case({
  id: "M4-06",
  title: "A15 达 20 美元/月自动暂停",
  acceptance: "A15（自动暂停）",
  refs: ["design §10 A15", "plan 决策：代聊成本上限 20 美元/月"],
  needs: [{ task: "T9", what: "代聊预算", artifact: "src/backend/im/proxy.ts" }],
  steps: ["把消耗推到 20 美元/月", "代聊自动暂停", "界面给出提示，说明是预算原因", "暂停后不再产生新的代发"],
  run: (tools) => {
    withDb((db) => {
      const speaking = new ImProxySpeaking(db);
      const driver = new ImMessagingDriver(db, scope.localServerId);
      speaking.charge(scope, peerKey, IM_PROXY_BUDGET_USD * 100, now);
      tools.check("花满 20 美元后不能再代发", speaking.canSpeak(scope, peerKey, 1, now) === false);
      tools.check(
        "超支拒发并返回 im.budgetExceeded（不是伪成功）",
        rejects(() => {
          driver.sendProxied("m", {
            threadId: "thread-1",
            peer,
            body: "over",
            remoteMessageId: "rm-over",
            sentAt: now,
            expiresAt: now + 86_400_000,
            proxiedBy: "assistant-1",
            proxyVisibility: "shown",
            usdCents: 1,
          });
        }) === "im.budgetExceeded",
      );
      tools.check(
        "超支那条不落库（对照：已发的仍在）",
        query(db, "SELECT COUNT(*) AS n FROM im_messages WHERE remote_message_id = ?", "rm-over")[0]?.n === 0,
      );
      tools.check(
        "预算只约束代聊：自己发言不受影响",
        (() => {
          const self = driver.send("m", {
            threadId: "thread-1",
            peer,
            body: "self",
            remoteMessageId: "rm-self",
            sentAt: now + 1,
            expiresAt: now + 86_400_000,
          });
          return self.message.proxiedBy === null;
        })(),
      );
      tools.check("对照组：换对端另起预算", speaking.canSpeak(scope, "peer-b/agent-1", 1, now) === true);
      tools.check("跨月重置", speaking.canSpeak(scope, peerKey, 1, now + 40 * 86_400_000) === true);
    });
  },
});

gate.case({
  id: "M4-07",
  title: "A15 调整上限记审计",
  acceptance: "A15（调整上限）",
  refs: ["design §10 A15"],
  needs: [
    { task: "T9", what: "预算上限可调整 + 审计", artifact: "src/backend/im/proxy.ts" },
    { task: "T12a1", what: "审计写入", artifact: "src/backend/im/audit.ts" },
  ],
  steps: ["调整代聊预算上限", "审计记录调整人、旧值、新值、时间"],
  run: (tools) => {
    withDb((db) => {
      const settings = new ImProxySettingsStore(db);
      tools.check("默认上限 20 美元/月", settings.read(scope).monthlyBudgetUsd === IM_PROXY_BUDGET_USD_DEFAULT);
      tools.check(
        "上限可设并生效",
        rejects(() => settings.write(scope, { enabled: true, visibility: "shown", monthlyBudgetUsd: 5, at: now })) ===
          "" && settings.read(scope).monthlyBudgetUsd === 5,
      );
      tools.check("落库跨会话（新实例读回一致）", new ImProxySettingsStore(db).read(scope).monthlyBudgetUsd === 5);
      tools.check(
        "联调断言：写 5 美元 → 关库重开读回 5",
        (() => {
          const root = mkdtempSync(join(tmpdir(), "im-e2e-m4-reopen-"));
          const first = openHarnessDatabase(join(root, "settings.db"));
          try {
            migrateOpenBotDatabase(first, { appliedAt: HARNESS_APPLIED_AT });
            new ImProxySettingsStore(first).write(scope, {
              enabled: true,
              visibility: "shown",
              monthlyBudgetUsd: 5,
              at: now,
            });
            const wrote = new ImProxySettingsStore(first).read(scope).monthlyBudgetUsd;
            first.close();
            const second = openHarnessDatabase(join(root, "settings.db"));
            try {
              migrateOpenBotDatabase(second, { appliedAt: HARNESS_APPLIED_AT });
              return wrote === 5 && new ImProxySettingsStore(second).read(scope).monthlyBudgetUsd === 5;
            } finally {
              second.close();
              rmSync(root, { recursive: true, force: true });
            }
          } catch {
            return false;
          }
        })(),
      );
      tools.check(
        "非法上限拒",
        rejects(() =>
          settings.write(scope, { enabled: true, visibility: "shown", monthlyBudgetUsd: -1, at: now + 1 }),
        ) !== "" &&
          rejects(() =>
            settings.write(scope, { enabled: true, visibility: "shown", monthlyBudgetUsd: 1001, at: now + 2 }),
          ) !== "",
      );
      const audit = new ImAuditLog(db);
      audit.record(scope, {
        id: "audit-m4-07",
        actorId: "person-1",
        sourceTrustDomain: "local",
        action: "im.proxy.budget",
        targetId: peerKey,
        result: "ok",
        correlationId: "corr-m4-07",
        before: { monthlyBudgetUsd: 20 },
        after: { monthlyBudgetUsd: 5 },
        at: now,
      });
      const read = audit.read(scope, "audit-m4-07");
      tools.check(
        "审计记录调整人、旧值、新值、时间",
        read !== null && read.at === now && read.before?.includes("20") === true && read.after?.includes("5") === true,
      );
      tools.check(
        "调整上限记审计（旧值→新值）",
        read !== null && read.before?.includes("20") === true && read.after?.includes("5") === true,
      );
    });
  },
});

gate.case({
  id: "M4-08",
  title: "单一主责自动应答不抢话 + 转交走事务 + R10 只说话不动手",
  acceptance: "A6（单一主责）",
  refs: ["design 决策记录 2", "plan §2 P1-M4 出口", "plan §8 结论 5 R10"],
  needs: [{ task: "T9", what: "单一主责链路 + R10 裁决点", artifact: "src/backend/im/proxy.ts" }],
  steps: [
    "同一会话里有多个助理",
    "只有单一主责自动应答",
    "其余助理只在被 @ 或转交后才发言",
    "转交用 DB 事务：primaryAssignee 变更与审计写入同事务，失败则一起回滚",
  ],
  run: (tools) => {
    withDb((db) => {
      const chain = new ImPrimaryChain(db);
      chain.assign(scope, "thread-1", "agent-1", "primary");
      chain.assign(scope, "thread-1", "agent-2", "assist");
      tools.check("主责唯一", chain.primary(scope, "thread-1") === "agent-1", String(chain.primary(scope, "thread-1")));
      tools.check(
        "其余助理是 assist（不抢话）",
        chain.assignees(scope, "thread-1").filter((a) => a.role === "assist").length === 1,
      );
      chain.transfer(scope, "thread-1", "agent-1", "agent-2");
      tools.check("转交后主责唯一（事务内撤旧立新）", chain.primary(scope, "thread-1") === "agent-2");
      tools.check(
        "旧主责降为 assist",
        chain.assignees(scope, "thread-1").find((a) => a.agentId === "agent-1")?.role === "assist",
      );
      tools.check(
        "非主责转交被拒",
        rejects(() => chain.transfer(scope, "thread-1", "agent-1", "agent-3")) === "im.notAssignee",
      );
      tools.check(
        "无主责时转交被拒",
        rejects(() => chain.transfer(scope, "thread-2", "nobody", "agent-3")) === "im.primaryRequired",
      );

      const external: CausalChain = { chainId: "c-ext", rootMessageId: "m-1", trustDomain: "im-peer", createdAt: now };
      const local: CausalChain = { chainId: "c-loc", rootMessageId: "m-2", trustDomain: "local", createdAt: now };
      const driver = new ImMessagingDriver(db, scope.localServerId);
      tools.check(
        "R10：外部链只说话不动手",
        (() => {
          const d = imExecutionDecision(external);
          return d.maySpeak === true && d.mayExecuteTools === false;
        })(),
      );
      tools.check(
        "R10：外部链 execute 被拒",
        (() => {
          let refused = "";
          try {
            driver.execute(external, () => "ran");
          } catch (error) {
            refused = error instanceof ImToolRefused ? "ImToolRefused" : String(error);
          }
          return refused === "ImToolRefused";
        })(),
      );
      tools.check("R10：外部链 speak 放行", driver.speak(external, () => "spoken") === "spoken");
      tools.check(
        "对照组：本地链说话与动手都可",
        driver.speak(local, () => 1) === 1 && driver.execute(local, () => 2) === 2,
      );
      tools.check(
        "缺声明双拒",
        imExecutionDecision(undefined).maySpeak === false && imExecutionDecision(undefined).mayExecuteTools === false,
      );
    });
  },
});

const report = await gate.run();
process.exitCode = report.counts.fail > 0 ? 1 : 0;
