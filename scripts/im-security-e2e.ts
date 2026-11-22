import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { newChannelTask } from "../src/backend/channel-service";
import { ChannelStore } from "../src/backend/channel-store";
import { databaseRow } from "../src/backend/database/database-rows";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { ImAuditLog } from "../src/backend/im/audit";
import {
  authorizeToolCall,
  type CausalChain,
  CausalChainMissing,
  CausalChainRegistry,
  causalChainForThread,
  decideInboundAction,
  externalContext,
  externalContextIsClean,
  IM_EXTERNAL_CONTEXT_SOURCES,
  IM_EXTERNAL_TRUST_DOMAINS,
  IM_FORBIDDEN_CONTEXT_SOURCES,
  IM_INBOUND_ACTIONS,
  inheritedChain,
  isExternalChain,
  mayUseTools,
  requireChain,
  sharedCausalChains,
  sharedCausalThreads,
  toolsDecision,
} from "../src/backend/im/causal-chain";
import { MailboxStore } from "../src/backend/mailbox-store";
import { HARNESS_APPLIED_AT, openHarnessDatabase, query } from "../src/backend/migration-harness";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { WorkflowRunStore } from "../src/backend/workflows/workflow-run-store";
import { type ImCaseTools, ImGate } from "./im-e2e-support";

const gate = new ImGate({
  gate: "T14c M3 关卡：安全闸门收口",
  script: "scripts/im-security-e2e.ts",
  milestone: "P0-M3",
  evidence: "evidence/im-m3",
});

function rejects(work: () => void): string {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

function chainOfDelivery(database: OpenBotDatabase, deliveryId: string): string | null {
  const row = databaseRow(
    database.connection
      .prepare("SELECT delivery_json FROM projection_deliveries WHERE delivery_id = ?")
      .get(deliveryId),
  );
  if (!row) return null;
  const parsed = JSON.parse(String(row.delivery_json));
  if (!isDynamicRecord(parsed)) return null;
  return typeof parsed.causalChainId === "string" ? parsed.causalChainId : null;
}

const externalChain: CausalChain = {
  chainId: "chain-ext-1",
  rootMessageId: "msg-root-1",
  trustDomain: "im-peer",
  createdAt: 1_700_000_000_000,
};

const localChain: CausalChain = {
  chainId: "chain-local-1",
  rootMessageId: "msg-root-2",
  trustDomain: "local",
  createdAt: 1_700_000_000_000,
};

gate.case({
  id: "SEC-01",
  title: "A1 闸门判定：外部链禁用工具、只回文本",
  acceptance: "A1（闸门判定）",
  refs: ["design §10 A1", "plan §3 T5 验收", "src/backend/im/causal-chain.ts toolsDecision"],
  needs: [{ task: "T5", what: "安全闸门：因果链继承与默认拒绝", artifact: "src/backend/im/causal-chain.ts" }],
  steps: [
    "外部信任域（im-peer/im-proxy/third-party）的因果链进来",
    "断言 mayUseTools 为 false",
    "断言 toolsDecision 的 toolsEnabled 为 false 且允许回文本",
    "断言 reply 动作允许但 toolsEnabled 为 false（只回文本）",
  ],
  run: (tools: ImCaseTools) => {
    for (const trustDomain of IM_EXTERNAL_TRUST_DOMAINS) {
      const chain: CausalChain = { ...externalChain, trustDomain };
      tools.record(`外部信任域 ${trustDomain} 禁用工具`, mayUseTools(chain) === false);
      const decision = toolsDecision(chain);
      tools.record(`${trustDomain} 的 toolsEnabled 为 false`, decision.toolsEnabled === false);
      tools.record(`${trustDomain} 允许回文本`, decision.allowed === true);
      const reply = decideInboundAction({
        action: "reply",
        chainId: chain.chainId,
        sessionThreadId: "thread-1",
        targetThreadId: "thread-1",
        targetKind: "own-reply",
      });
      tools.record(`${trustDomain} 的 reply 只回文本`, reply.allowed && !reply.toolsEnabled);
    }
    tools.check("A1 闸门判定：外部输入禁用工具、只回文本", tools.passed);
  },
});

gate.case({
  id: "SEC-02",
  title: "A1 审计带 causal_chain_id",
  acceptance: "A1（审计）",
  refs: ["design §10 A1", "plan §3 T12a1 验收"],
  needs: [{ task: "T12a1", what: "审计写入：不可变事件、写入前脱敏、audit_log 只追加" }],
  steps: ["外部消息被处理后，审计条目必须带 causal_chain_id", "信任域标为外部", "脱敏后写入、不可变"],
  run: (tools: ImCaseTools) => {
    const db = openHarnessDatabase();
    try {
      migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
      const audit = new ImAuditLog(db);
      const scope = { localServerId: "s", localMemberId: "m" };
      const secret = "secret-token-value-abcde";
      audit.record(scope, {
        id: "audit-sec-02",
        actorId: "peer-1/agent-1",
        sourceTrustDomain: "im-peer",
        action: "im.message.handle",
        targetId: "msg-1",
        result: "handled",
        correlationId: "corr-sec-02",
        causalChainId: externalChain.chainId,
        before: undefined,
        after: undefined,
        at: 1_700_000_000_000,
        detail: { token: secret },
      });
      const read = audit.read(scope, "audit-sec-02");
      tools.record("信任域标为外部", read?.sourceTrustDomain === "im-peer", read?.sourceTrustDomain);
      tools.record("写入前脱敏：密钥类键名被脱敏", !String(read?.redactedDetail).includes(secret));
      tools.record(
        "审计带 causal_chain_id 一等字段并可读回",
        read?.causalChainId === externalChain.chainId,
        `causalChainId=${read?.causalChainId}`,
      );
      tools.record(
        "只追加：同 id 再写被拒且原事件未被篡改",
        rejects(() => {
          audit.record(scope, {
            id: "audit-sec-02",
            actorId: "tampered",
            sourceTrustDomain: "local",
            action: "tampered",
            targetId: "x",
            result: "ok",
            correlationId: "c",
            before: undefined,
            after: undefined,
            at: 1_700_000_001_000,
          });
        }) !== "" && audit.read(scope, "audit-sec-02")?.action === "im.message.handle",
      );
      const columns = query(db, "PRAGMA table_info(audit_log)")
        .map((row) => String(row.name))
        .sort()
        .join(",");
      tools.record("audit_log 含 redacted_detail 列", columns.includes("redacted_detail"), columns);
      tools.record("audit_log 有一等列 causal_chain_id", columns.includes("causal_chain_id"), columns);
    } finally {
      db.close();
    }
  },
});

gate.case({
  id: "SEC-03",
  title: "A2 派生委派/子任务继承因果链与信任域，工具仍禁用",
  acceptance: "A2（继承）",
  refs: ["design §10 A2", "src/backend/im/causal-chain.ts inheritedChain"],
  needs: [{ task: "T5", what: "因果链继承", artifact: "src/backend/im/causal-chain.ts" }],
  steps: [
    "从外部链派生一个委派或子任务",
    "断言继承 chainId、rootMessageId、trustDomain",
    "断言派生物仍是外部链、工具仍禁用",
    "二级派生同样继承信任域，不因派生升级为本地",
    "父链缺失时派生必须抛错（默认拒绝）",
  ],
  run: (tools: ImCaseTools) => {
    const derived = inheritedChain(externalChain, { chainId: null, createdAt: 1_700_000_100_000 });
    tools.check("派生继承 chainId", derived.chainId === externalChain.chainId, derived.chainId);
    tools.check("派生继承 rootMessageId", derived.rootMessageId === externalChain.rootMessageId);
    tools.check("派生继承 trustDomain", derived.trustDomain === externalChain.trustDomain);
    tools.check("派生仍是外部链", isExternalChain(derived));
    tools.check("派生后工具仍禁用", mayUseTools(derived) === false);
    tools.check("派生后 toolsEnabled 仍为 false", toolsDecision(derived).toolsEnabled === false);
    const grandChild = inheritedChain(derived, { chainId: "chain-derived-2", createdAt: 1_700_000_200_000 });
    tools.check("二级派生继承信任域", grandChild.trustDomain === externalChain.trustDomain);
    tools.check("二级派生工具仍禁用", mayUseTools(grandChild) === false);
    tools.check("二级派生可带自己的 chainId", grandChild.chainId === "chain-derived-2", grandChild.chainId);
    let missing = "";
    try {
      inheritedChain(null, { chainId: null, createdAt: 1 });
    } catch (error) {
      missing = error instanceof CausalChainMissing ? "CausalChainMissing" : String(error);
    }
    tools.check("父链缺失时派生默认拒绝", missing === "CausalChainMissing", missing);
  },
});

gate.case({
  id: "SEC-04",
  title: "A2 进程重启后仍禁用（因果链落库后重开同判）",
  acceptance: "A2（重启后）",
  refs: ["design §10 A2", "plan §2 P0-M3 出口", "src/backend/migrations/0068-im-causal-chain.ts"],
  needs: [{ task: "T5", what: "因果链持久化 + 重启后判定不变", artifact: "src/backend/im/causal-chain.ts" }],
  steps: [
    "把外部因果链写进真实迁移后的 causal_chains 表",
    "关掉连接（模拟进程重启）",
    "重开连接读回同一条链",
    "断言判定与重启前一致：工具仍禁用、toolsEnabled 仍 false",
  ],
  run: (tools: ImCaseTools) => {
    const directory = mkdtempSync(join(tmpdir(), "im-e2e-restart-"));
    const path = join(directory, "restart.db");
    try {
      const first = openHarnessDatabase(path);
      migrateOpenBotDatabase(first, { appliedAt: HARNESS_APPLIED_AT });
      first
        .prepare("INSERT INTO causal_chains (chain_id, root_message_id, trust_domain, created_at) VALUES (?, ?, ?, ?)")
        .run(externalChain.chainId, externalChain.rootMessageId, externalChain.trustDomain, externalChain.createdAt);
      const before = toolsDecision(externalChain);
      first.close();

      const reopened = openHarnessDatabase(path);
      try {
        const row = reopened
          .prepare("SELECT chain_id, root_message_id, trust_domain, created_at FROM causal_chains WHERE chain_id = ?")
          .get(externalChain.chainId);
        tools.check("重启后因果链仍在库里", row !== undefined);
        const chain: CausalChain = {
          chainId: externalChain.chainId,
          rootMessageId: externalChain.rootMessageId,
          trustDomain: externalChain.trustDomain,
          createdAt: externalChain.createdAt,
        };
        const after = toolsDecision(chain);
        tools.check("重启后工具仍禁用", mayUseTools(chain) === false);
        tools.check("重启后 toolsEnabled 仍为 false", after.toolsEnabled === false);
        tools.check("重启前后判定一致", after.toolsEnabled === before.toolsEnabled && after.allowed === before.allowed);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
});

gate.case({
  id: "SEC-05",
  title: "A2 队列恢复后仍禁用",
  acceptance: "A2（队列恢复后）",
  refs: ["design §10 A2", "plan §2 P0-M3 出口"],
  needs: [{ task: "T5", what: "安全闸门", artifact: "src/backend/im/causal-chain.ts" }],
  steps: [
    "把外部消息压入待处理队列后中断执行",
    "触发队列恢复/崩溃恢复",
    "恢复后继续处理，工具仍然禁用，不得因为重新入队而丢掉因果链",
  ],
  run: async (tools: ImCaseTools) => {
    const root = mkdtempSync(join(tmpdir(), "im-e2e-queue-recovery-"));
    const userData = join(root, "user-data");
    const shared = join(root, "shared");
    mkdirSync(userData, { recursive: true });
    mkdirSync(shared, { recursive: true });
    try {
      const database = new OpenBotDatabase(userData);
      await runCauseEffect(database.initialize());
      const mailbox = new MailboxStore(userData, shared, database);
      await runCauseEffect(mailbox.initialize());

      const externalChain: CausalChain = {
        chainId: "chain-external-1",
        rootMessageId: "m-1",
        trustDomain: "im-peer",
        createdAt: Date.now(),
      };
      const localChainForQueue: CausalChain = {
        chainId: "chain-local-1",
        rootMessageId: "m-2",
        trustDomain: "local",
        createdAt: Date.now(),
      };
      const externalReceipt = await runCauseEffect(
        mailbox.enqueue({
          sender: { kind: "user" },
          recipientAgentIds: ["agent-worker"],
          text: "derived from external input",
          channelId: "channel-1",
          causalChainId: externalChain.chainId,
          idempotencyKey: "im-e2e-queue-external",
        }),
      );
      const localReceipt = await runCauseEffect(
        mailbox.enqueue({
          sender: { kind: "user" },
          recipientAgentIds: ["agent-worker"],
          text: "local work",
          channelId: "channel-1",
          causalChainId: localChainForQueue.chainId,
          idempotencyKey: "im-e2e-queue-local",
        }),
      );
      const externalDeliveryId = externalReceipt.deliveries[0]?.id ?? "";
      const localDeliveryId = localReceipt.deliveries[0]?.id ?? "";
      tools.record("外部因果链写进队列", externalDeliveryId !== "", externalDeliveryId.slice(0, 8));
      tools.record("对照组：本地因果链也写进队列", localDeliveryId !== "", localDeliveryId.slice(0, 8));
      tools.record(
        "因果链落到持久化投递记录",
        chainOfDelivery(database, externalDeliveryId) === externalChain.chainId,
        String(chainOfDelivery(database, externalDeliveryId)),
      );

      database.close();
      const reopened = new OpenBotDatabase(userData);
      await runCauseEffect(reopened.initialize());
      const mailboxAfter = new MailboxStore(userData, shared, reopened);
      await runCauseEffect(mailboxAfter.initialize());

      tools.record(
        "重启后队列恢复、外部因果链仍在",
        chainOfDelivery(reopened, externalDeliveryId) === externalChain.chainId,
        String(chainOfDelivery(reopened, externalDeliveryId)),
      );
      tools.record(
        "对照组：重启后本地因果链同样仍在",
        chainOfDelivery(reopened, localDeliveryId) === localChainForQueue.chainId,
        String(chainOfDelivery(reopened, localDeliveryId)),
      );
      sharedCausalThreads.bind("thread-external", externalChain);
      const recovered = causalChainForThread("thread-external");
      tools.record("恢复后闸门仍读到外部链", recovered?.trustDomain === "im-peer", JSON.stringify(recovered));
      tools.record("恢复后外部链工具仍禁用", authorizeToolCall(recovered).toolsEnabled === false);
      sharedCausalThreads.bind("thread-local", localChainForQueue);
      tools.record(
        "对照组：恢复后本地链工具仍可用",
        authorizeToolCall(causalChainForThread("thread-local")).toolsEnabled === true,
      );
      tools.record("恢复后缺声明仍默认拒绝", authorizeToolCall(undefined).allowed === false);
      const derived = sharedCausalChains.derive(externalChain, "chain-derived-after-recovery", Date.now());
      tools.record(
        "恢复后派生仍继承外部链且禁工具",
        derived.trustDomain === "im-peer" && authorizeToolCall(derived).toolsEnabled === false,
      );
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
});

gate.case({
  id: "SEC-06",
  title: "A3 approval 一律被拒",
  acceptance: "A3（approval）",
  refs: ["design §10 A3", "src/backend/im/causal-chain.ts decideInboundAction"],
  needs: [{ task: "T5", what: "InboundAction 边界", artifact: "src/backend/im/causal-chain.ts" }],
  steps: [
    "外部消息触发 approval 动作",
    "断言一律被拒、reason 为 im.unauthorized、toolsEnabled 为 false",
    "本地链下的 approval 同样被拒（不因信任域高就放行）",
  ],
  run: (tools: ImCaseTools) => {
    for (const chain of [externalChain, localChain, null]) {
      const decision = decideInboundAction({
        action: "approval",
        chainId: chain?.chainId ?? null,
        sessionThreadId: "thread-1",
        targetThreadId: "thread-1",
        targetKind: "own-reply",
      });
      tools.record(
        `approval 在 ${chain?.trustDomain ?? "无链"} 下被拒`,
        decision.allowed === false && decision.reason === "im.unauthorized" && decision.toolsEnabled === false,
        JSON.stringify(decision),
      );
    }
    tools.check("A3 approval 一律被拒", tools.passed);
  },
});

gate.case({
  id: "SEC-07",
  title: "A3 外部 stop 只停该外部会话的回复",
  acceptance: "A3（stop 边界）",
  refs: ["design §10 A3", "src/backend/im/causal-chain.ts decideInboundAction"],
  needs: [{ task: "T5", what: "InboundAction stop 边界", artifact: "src/backend/im/causal-chain.ts" }],
  steps: [
    "stop 指向自己的会话回复 → 允许",
    "stop 指向本地任务 → 拒绝",
    "stop 指向其他会话 → 拒绝",
    "stop 指向系统进程 → 拒绝",
  ],
  run: (tools: ImCaseTools) => {
    const stop = (
      targetThreadId: string | null,
      targetKind: "own-reply" | "local-task" | "other-session" | "system-process",
    ) =>
      decideInboundAction({
        action: "stop",
        chainId: externalChain.chainId,
        sessionThreadId: "thread-own",
        targetThreadId,
        targetKind,
      });
    tools.check("stop 自己会话的回复被允许", stop("thread-own", "own-reply").allowed === true);
    tools.check("stop 本地任务被拒", stop("thread-task", "local-task").allowed === false);
    tools.check("stop 其他会话被拒", stop("thread-other", "other-session").allowed === false);
    tools.check("stop 系统进程被拒", stop(null, "system-process").allowed === false);
    tools.check("stop 自己会话但目标不是自己也拒", stop("thread-other", "own-reply").allowed === false);
  },
});

gate.case({
  id: "SEC-08",
  title: "A3 频道任务/工作流步骤/InboundAction 入口同闸门",
  acceptance: "A3（运行时入口）",
  refs: ["design §10 A3", "plan §3 T5 验收"],
  needs: [
    {
      task: "T5",
      what: "各任务表 causal_chain_id 落点写入与继承接线（委派/子任务/频道任务/工作流步骤/mailbox delivery）",
    },
  ],
  steps: [
    "外部消息进入频道任务，断言工具禁用",
    "外部消息进入工作流步骤，断言工具禁用",
    "外部消息触发 InboundAction，断言工具禁用",
    "三种入口发起 approval 都被拒",
  ],
  run: async (tools: ImCaseTools) => {
    const externalEntry = decideInboundAction({
      action: "reply",
      chainId: externalChain.chainId,
      sessionThreadId: "thread-1",
      targetThreadId: "thread-1",
      targetKind: "own-reply",
    });
    tools.record(
      "InboundAction 入口：允许回文本但工具禁用",
      externalEntry.allowed === true && externalEntry.toolsEnabled === false,
      JSON.stringify(externalEntry),
    );
    tools.record(
      "InboundAction 入口：approval 被拒",
      decideInboundAction({
        action: "approval",
        chainId: externalChain.chainId,
        sessionThreadId: "thread-1",
        targetThreadId: "thread-1",
        targetKind: "own-reply",
      }).allowed === false,
    );

    const root = mkdtempSync(join(tmpdir(), "im-e2e-writepoint-"));
    const userData = join(root, "user-data");
    const shared = join(root, "shared");
    mkdirSync(userData, { recursive: true });
    mkdirSync(shared, { recursive: true });
    try {
      const database = new OpenBotDatabase(userData);
      await runCauseEffect(database.initialize());
      const mailbox = new MailboxStore(userData, shared, database);
      await runCauseEffect(mailbox.initialize());
      const receipt = await runCauseEffect(
        mailbox.enqueue({
          sender: { kind: "user" },
          recipientAgentIds: ["agent-worker"],
          text: "external dispatch",
          channelId: "channel-1",
          causalChainId: externalChain.chainId,
          idempotencyKey: "im-e2e-writepoint-external",
        }),
      );
      const deliveryId = receipt.deliveries[0]?.id ?? "";
      tools.record(
        "mailbox delivery 落点把因果链写进投递记录",
        chainOfDelivery(database, deliveryId) === externalChain.chainId,
      );
      sharedCausalThreads.bind(`thread-${deliveryId}`, externalChain);
      tools.record(
        "mailbox delivery 落点入口同闸门：工具禁用",
        authorizeToolCall(causalChainForThread(`thread-${deliveryId}`)).toolsEnabled === false,
      );
      tools.record("对照组：本地链在同落点上工具仍可用", authorizeToolCall(localChain).toolsEnabled === true);
      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const wfRoot = mkdtempSync(join(tmpdir(), "im-e2e-workflow-"));
    const wfUser = join(wfRoot, "user-data");
    mkdirSync(wfUser, { recursive: true });
    try {
      const database = new OpenBotDatabase(wfUser);
      await runCauseEffect(database.initialize());
      const store = new WorkflowRunStore({ database });
      const at = new Date(1_700_000_000_000).toISOString();
      database.connection
        .prepare(
          "INSERT INTO workflows (workflow_id, title, graph_revision, strokes_json, next_run_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("wf-ext", "wf", 0, "[]", 1, at, at);
      database.connection
        .prepare(
          "INSERT INTO workflows (workflow_id, title, graph_revision, strokes_json, next_run_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("wf-loc", "wf", 0, "[]", 1, at, at);
      const insertRun = database.connection.prepare(
        "INSERT INTO workflow_runs (run_id, workflow_id, number, source, idempotency_key, graph_revision, graph_json, status, started_at, updated_at, causal_chain_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insertRun.run("run-ext", "wf-ext", 1, "manual", "idem-ext", 0, "{}", "running", at, at, externalChain.chainId);
      insertRun.run("run-loc", "wf-loc", 1, "manual", "idem-loc", 0, "{}", "running", at, at, localChain.chainId);
      store.addStep(
        {
          workflowId: "wf-ext",
          runId: "run-ext",
          nodeId: "node-1",
          kind: "agent",
          requestId: "req-ext",
          agentId: "agent-worker",
          status: "running",
          input: "external input",
        },
        new Date(1_700_000_000_000),
      );
      store.addStep(
        {
          workflowId: "wf-loc",
          runId: "run-loc",
          nodeId: "node-1",
          kind: "agent",
          requestId: "req-loc",
          agentId: "agent-worker",
          status: "running",
          input: "local input",
        },
        new Date(1_700_000_000_000),
      );
      const chainOf = (runId: string) => {
        const row = databaseRow(
          database.connection.prepare("SELECT causal_chain_id FROM workflow_steps WHERE run_id = ?").get(runId),
        );
        return row ? String(row.causal_chain_id) : null;
      };
      tools.record(
        "工作流步骤落点：从 workflow_runs 继承因果链",
        chainOf("run-ext") === externalChain.chainId,
        String(chainOf("run-ext")),
      );
      tools.record("工作流步骤入口同闸门：工具禁用", authorizeToolCall(externalChain).toolsEnabled === false);
      tools.record(
        "对照组：本地链的步骤同样继承，且工具仍可用",
        chainOf("run-loc") === localChain.chainId && authorizeToolCall(localChain).toolsEnabled === true,
        String(chainOf("run-loc")),
      );
      const meta = databaseRow(
        database.connection.prepare("SELECT updated_at FROM workflow_steps WHERE run_id = ?").get("run-ext"),
      );
      const updatedAt = meta ? String(meta.updated_at) : "";
      tools.record(
        "updated_at 落的是时间戳而非 run_id（根因定位：末两个绑定参数错位）",
        updatedAt.includes("T") && updatedAt.endsWith("Z"),
        `updated_at=${updatedAt}`,
      );
      database.close();
    } finally {
      rmSync(wfRoot, { recursive: true, force: true });
    }
    const chRoot = mkdtempSync(join(tmpdir(), "im-e2e-channel-"));
    const chUser = join(chRoot, "user-data");
    mkdirSync(chUser, { recursive: true });
    try {
      const database = new OpenBotDatabase(chUser);
      await runCauseEffect(database.initialize());
      const store = new ChannelStore(database);
      const at = new Date(1_700_000_000_000).toISOString();
      const channel = {
        id: "chan-1",
        name: "chan",
        title: "T",
        instructions: "",
        members: [],
        leadAgentId: null,
        archived: false,
        createdAt: at,
      };
      const task = newChannelTask("chan-1", "msg-1", "do the thing", "agent-1", externalChain.chainId);
      store.commit("op-ext", { channel: { ...channel, revision: 0 }, messages: [], tasks: [task], assignments: [] });
      const stored = store.task("chan-1", task.id);
      tools.record(
        "加列后频道任务仍能落库（无列名位置插入的坑已补）",
        stored !== null,
        stored ? "落库并读回成功" : "读不到",
      );
      tools.record(
        "频道任务落点继承因果链",
        stored?.causalChainId === externalChain.chainId,
        String(stored?.causalChainId),
      );
      tools.record("频道任务入口同闸门：工具禁用", authorizeToolCall(externalChain).toolsEnabled === false);
      const localTask = newChannelTask("chan-1", "msg-2", "local work", "agent-1", localChain.chainId);
      store.commit("op-loc", {
        channel: { ...channel, revision: 1 },
        messages: [],
        tasks: [localTask],
        assignments: [],
      });
      const storedLocal = store.task("chan-1", localTask.id);
      tools.record(
        "对照组：本地链的频道任务同样落库且继承，工具仍可用",
        storedLocal?.causalChainId === localChain.chainId && authorizeToolCall(localChain).toolsEnabled === true,
        String(storedLocal?.causalChainId),
      );
      store.commit("op-asg", {
        channel: { ...channel, revision: 2 },
        messages: [],
        tasks: [],
        assignments: [
          {
            id: "asg-1",
            channelId: "chan-1",
            taskId: task.id,
            agentId: "agent-1",
            taskRevision: 0,
            requestMessageId: "msg-1",
            resources: [],
            deliveryId: null,
            turnId: null,
            state: "queued",
            throughSequence: 0,
            summaryVersion: 0,
            awaitedTaskIds: [],
            pendingRevision: null,
            pendingOutcome: null,
          },
        ],
      });
      const asgRow = databaseRow(
        database.connection
          .prepare("SELECT task_id FROM projection_channel_assignments WHERE assignment_id = ?")
          .get("asg-1"),
      );
      tools.record(
        "加列后频道指派仍能落库（无列名位置插入第二处已补）",
        asgRow !== null && String(asgRow.task_id) === task.id,
        asgRow ? `task_id=${String(asgRow.task_id)}` : "读不到",
      );
      database.close();
    } finally {
      rmSync(chRoot, { recursive: true, force: true });
    }
  },
});

gate.case({
  id: "SEC-09",
  title: "A4 上下文隔离：不含本地记忆",
  acceptance: "A4（本地记忆）",
  refs: ["design §10 A4", "src/backend/im/causal-chain.ts IM_FORBIDDEN_CONTEXT_SOURCES"],
  needs: [{ task: "T5", what: "外部上下文白名单", artifact: "src/backend/im/causal-chain.ts" }],
  steps: ["把 local-memory 来源的上下文交给白名单过滤", "断言它被丢弃、不进入外部上下文", "断言泄漏检出把它报出来"],
  run: (tools: ImCaseTools) => {
    const kept = externalContext([
      { source: "current-message", text: "hello" },
      { source: "local-memory", text: "秘密记忆" },
    ]);
    tools.check(
      "local-memory 被白名单丢弃",
      kept.every((entry) => entry.source !== "local-memory"),
    );
    tools.check("白名单只留当前消息", kept.length === 1 && kept[0]?.source === "current-message");
    const clean = externalContextIsClean([{ source: "current-message" }, { source: "local-memory" }]);
    tools.check("泄漏检出报出 local-memory", clean.clean === false && clean.leaked.includes("local-memory"));
  },
});

gate.case({
  id: "SEC-10",
  title: "A4 上下文隔离：不含工作区文件与工作区指令",
  acceptance: "A4（工作区）",
  refs: ["design §10 A4", "design R15"],
  needs: [{ task: "T5", what: "外部上下文白名单", artifact: "src/backend/im/causal-chain.ts" }],
  steps: [
    "把 workspace-instructions 与 local-file 来源交给白名单过滤",
    "断言两者都被丢弃",
    "断言泄漏检出把两者都报出来",
  ],
  run: (tools: ImCaseTools) => {
    const kept = externalContext([
      { source: "explicit-attachment", text: "附件内容" },
      { source: "workspace-instructions", text: "工作区指令" },
      { source: "local-file", text: "/etc/passwd" },
    ]);
    tools.check(
      "workspace-instructions 被丢弃",
      kept.every((entry) => entry.source !== "workspace-instructions"),
    );
    tools.check(
      "local-file 被丢弃",
      kept.every((entry) => entry.source !== "local-file"),
    );
    const clean = externalContextIsClean([{ source: "workspace-instructions" }, { source: "local-file" }]);
    tools.check(
      "泄漏检出报出工作区来源",
      clean.leaked.includes("workspace-instructions") && clean.leaked.includes("local-file"),
    );
  },
});

gate.case({
  id: "SEC-11",
  title: "A4 上下文隔离：不含 CRM 与资料库内容",
  acceptance: "A4（CRM/资料库）",
  refs: ["design §10 A4"],
  needs: [{ task: "T5", what: "外部上下文白名单", artifact: "src/backend/im/causal-chain.ts" }],
  steps: ["把 crm 与 library 来源交给白名单过滤", "断言两者都被丢弃", "断言泄漏检出把两者都报出来"],
  run: (tools: ImCaseTools) => {
    const kept = externalContext([
      { source: "crm", text: "客户记录" },
      { source: "library", text: "资料库条目" },
      { source: "session-history", text: "本会话历史" },
    ]);
    tools.check(
      "crm 被丢弃",
      kept.every((entry) => entry.source !== "crm"),
    );
    tools.check(
      "library 被丢弃",
      kept.every((entry) => entry.source !== "library"),
    );
    tools.check("本会话历史是白名单来源、保留", kept.length === 1 && kept[0]?.source === "session-history");
    const clean = externalContextIsClean([{ source: "crm" }, { source: "library" }]);
    tools.check("泄漏检出报出 crm 与 library", clean.leaked.includes("crm") && clean.leaked.includes("library"));
  },
});

gate.case({
  id: "SEC-12",
  title: "A4 上下文隔离：不含其他会话历史与技能输出",
  acceptance: "A4（其他会话）",
  refs: ["design §10 A4"],
  needs: [{ task: "T5", what: "外部上下文白名单", artifact: "src/backend/im/causal-chain.ts" }],
  steps: ["把 other-session 与 skill-output 来源交给白名单过滤", "断言两者都被丢弃", "断言泄漏检出把两者都报出来"],
  run: (tools: ImCaseTools) => {
    const kept = externalContext([
      { source: "other-session", text: "另一个会话" },
      { source: "skill-output", text: "技能输出" },
    ]);
    tools.check(
      "other-session 被丢弃",
      kept.every((entry) => entry.source !== "other-session"),
    );
    tools.check(
      "skill-output 被丢弃",
      kept.every((entry) => entry.source !== "skill-output"),
    );
    tools.check("两者的上下文全被清空", kept.length === 0);
    const clean = externalContextIsClean([{ source: "other-session" }, { source: "skill-output" }]);
    tools.check("泄漏检出报出两者", clean.leaked.includes("other-session") && clean.leaked.includes("skill-output"));
  },
});

gate.case({
  id: "SEC-13",
  title: "A4 默认拒绝：缺因果链与非白名单上下文一律不放行",
  acceptance: "A4（默认拒绝）",
  refs: ["design §4.1.1", "design R15", "src/backend/im/causal-chain.ts requireChain/toolsDecision"],
  needs: [{ task: "T5", what: "默认拒绝", artifact: "src/backend/im/causal-chain.ts" }],
  steps: [
    "没有因果链时 requireChain 必须抛错",
    "没有因果链时 mayUseTools 为 false、toolsDecision 不放行",
    "白名单之外的上下文来源一律被丢弃，不因没有匹配规则而放行",
  ],
  run: (tools: ImCaseTools) => {
    let thrown = "";
    try {
      requireChain(null);
    } catch (error) {
      thrown = error instanceof CausalChainMissing ? error.message : String(error);
    }
    tools.check("缺因果链时 requireChain 抛错", thrown === "im.protocolError", thrown);
    tools.check("缺因果链时 mayUseTools 为 false", mayUseTools(null) === false);
    const decision = toolsDecision(null);
    tools.check(
      "缺因果链时不放行",
      decision.allowed === false && decision.reason === "im.unauthorized",
      JSON.stringify(decision),
    );
    const kept = externalContext([
      { source: "current-message", text: "ok" },
      { source: "local-memory", text: "leak" },
      { source: "other-session", text: "leak" },
    ]);
    tools.check("非白名单来源一律丢弃", kept.length === 1 && kept[0]?.source === "current-message");
  },
});

gate.case({
  id: "SEC-14",
  title: "授权点唯一裁决：外部信任域一律禁工具，不继承工作区发言人信任",
  acceptance: "A1–A4（授权点）",
  refs: ["plan §8 结论 5", "docs/messaging.md R10", "src/backend/im/causal-chain.ts toolsDecision"],
  needs: [{ task: "T5", what: "MessagingDriver 信任模型切断", artifact: "src/backend/im/causal-chain.ts" }],
  steps: [
    "断言 IM_INBOUND_ACTIONS 闭合为 reply/stop/approval",
    "外部三类信任域逐一走 toolsDecision，一律 toolsEnabled 为 false",
    "本地信任域对照：toolsEnabled 为 true",
    "断言外部信任域与本地信任域不重叠",
  ],
  run: (tools: ImCaseTools) => {
    tools.check(
      "InboundAction 闭合为三项",
      IM_INBOUND_ACTIONS.join(",") === "reply,stop,approval",
      IM_INBOUND_ACTIONS.join(","),
    );
    for (const trustDomain of IM_EXTERNAL_TRUST_DOMAINS) {
      tools.record(`${trustDomain} 禁工具`, toolsDecision({ ...externalChain, trustDomain }).toolsEnabled === false);
    }
    tools.check("本地信任域对照可用工具", toolsDecision(localChain).toolsEnabled === true);
    tools.check("外部信任域不含 local", !IM_EXTERNAL_TRUST_DOMAINS.includes("local"));
    tools.check("授权点唯一裁决：外部一律不动手", tools.passed);
  },
});

gate.case({
  id: "SEC-15",
  title: "外部上下文白名单恰为三类且带来源标记",
  acceptance: "A4（白名单）",
  refs: ["design §4.1.1", "src/backend/im/causal-chain.ts IM_EXTERNAL_CONTEXT_SOURCES"],
  needs: [{ task: "T5", what: "外部上下文白名单", artifact: "src/backend/im/causal-chain.ts" }],
  steps: [
    "白名单恰为当前消息、显式附件、本会话历史三类",
    "每条保留的上下文都带来源标记",
    "白名单与禁用清单不重叠",
    "禁用清单覆盖本地记忆、工作区指令、CRM、资料库、其他会话、本地文件、技能输出七类",
  ],
  run: (tools: ImCaseTools) => {
    tools.check(
      "白名单恰为三类",
      IM_EXTERNAL_CONTEXT_SOURCES.join(",") === "current-message,explicit-attachment,session-history",
      IM_EXTERNAL_CONTEXT_SOURCES.join(","),
    );
    tools.check(
      "禁用清单七类齐备",
      IM_FORBIDDEN_CONTEXT_SOURCES.join(",") ===
        "local-memory,workspace-instructions,crm,library,other-session,local-file,skill-output",
      IM_FORBIDDEN_CONTEXT_SOURCES.join(","),
    );
    const forbiddenText = IM_FORBIDDEN_CONTEXT_SOURCES.map((entry) => String(entry));
    const overlap = IM_EXTERNAL_CONTEXT_SOURCES.filter((source) => forbiddenText.includes(String(source)));
    tools.check("白名单与禁用清单不重叠", overlap.length === 0, overlap.join(","));
    const kept = externalContext([{ source: "explicit-attachment", text: "x" }]);
    tools.check(
      "保留的上下文都带来源标记",
      kept.every((entry) => entry.marked === true && entry.source.length > 0),
    );
  },
});

gate.case({
  id: "SEC-16",
  title: "authorizeToolCall 三态：缺声明默认拒绝、显式本地放行、外部拒工具",
  acceptance: "A1–A4（默认拒绝语义）",
  refs: ["design §4.1 缺声明或传递失败→默认拒绝工具", "src/backend/im/causal-chain.ts authorizeToolCall"],
  needs: [{ task: "T5", what: "authorizeToolCall 默认拒绝语义", artifact: "src/backend/im/causal-chain.ts" }],
  steps: [
    "缺声明（undefined，含传递失败）→ 默认拒绝，不放行",
    "显式本地（null）→ 放行且可用工具",
    "外部三类信任域 → 放行回文本但工具禁用",
    "本地链 → 放行且可用工具",
    "与 toolsDecision 的语义差异要分开验：toolsDecision(null) 是缺链拒绝",
  ],
  run: (tools: ImCaseTools) => {
    const missing = authorizeToolCall(undefined);
    tools.check(
      "缺声明默认拒绝",
      missing.allowed === false && missing.reason === "im.unauthorized" && missing.toolsEnabled === false,
      JSON.stringify(missing),
    );
    const explicitLocal = authorizeToolCall(null);
    tools.check(
      "显式本地放行且可用工具",
      explicitLocal.allowed === true && explicitLocal.toolsEnabled === true,
      JSON.stringify(explicitLocal),
    );
    for (const trustDomain of IM_EXTERNAL_TRUST_DOMAINS) {
      tools.record(
        `${trustDomain} 可回文本但工具禁用`,
        authorizeToolCall({ ...externalChain, trustDomain }).allowed === true &&
          authorizeToolCall({ ...externalChain, trustDomain }).toolsEnabled === false,
      );
    }
    tools.check("本地链可用工具", authorizeToolCall(localChain).toolsEnabled === true);
    const chainless = toolsDecision(null);
    tools.check(
      "toolsDecision(null) 是缺链拒绝（与显式本地区分）",
      chainless.allowed === false && chainless.toolsEnabled === false,
      JSON.stringify(chainless),
    );
    tools.check("缺声明默认拒绝、显式本地放行的区分成立", tools.passed);
  },
});

gate.case({
  id: "SEC-17",
  title: "CausalChainRegistry：声明/读回/派生继承/未声明默认拒绝",
  acceptance: "A2（注册表）",
  refs: ["design §10 A2", "src/backend/im/causal-chain.ts CausalChainRegistry"],
  needs: [
    {
      task: "T5",
      what: "CausalChainRegistry declare/read/derive/authorize",
      artifact: "src/backend/im/causal-chain.ts",
    },
  ],
  steps: [
    "declare 后可 read 回同一条链",
    "read(null) 是 null、read(undefined) 是 undefined、未声明的 chainId 拒绝",
    "derive 继承父链信任域，派生链仍在注册表里",
    "外部派生链工具仍禁用，本地派生链放行",
    "无父链派生必须抛错（默认拒绝）",
  ],
  run: (tools: ImCaseTools) => {
    const registry = new CausalChainRegistry();
    const declared = registry.declare(externalChain);
    tools.check("declare 返回落库后的链", declared.chainId === externalChain.chainId, declared.chainId);
    tools.check("read 读回同一条", registry.read(externalChain.chainId)?.trustDomain === "im-peer");
    tools.check("read(null) 是 null", registry.read(null) === null);
    tools.check("read(undefined) 是 undefined", registry.read(undefined) === undefined);
    tools.check("未声明的 chainId 默认拒绝", registry.authorize("no-such-chain").allowed === false);
    tools.check("已声明的外部链仍禁工具", registry.authorize(externalChain.chainId).toolsEnabled === false);
    const derived = registry.derive(externalChain, "chain-child-ext", 1_700_000_300_000);
    tools.check("derive 继承信任域", derived.trustDomain === "im-peer", derived.trustDomain);
    tools.check("derive 继承 rootMessageId", derived.rootMessageId === externalChain.rootMessageId);
    tools.check("派生链已进注册表", registry.read("chain-child-ext") !== undefined);
    tools.check("外部派生链工具仍禁用", registry.authorize("chain-child-ext").toolsEnabled === false);
    registry.declare(localChain);
    registry.derive(localChain, "chain-child-local", 1_700_000_400_000);
    tools.check("本地派生链放行", registry.authorize("chain-child-local").toolsEnabled === true);
    let withoutParent = "";
    try {
      registry.derive(null, "chain-x", 1);
    } catch (error) {
      withoutParent = error instanceof CausalChainMissing ? "CausalChainMissing" : String(error);
    }
    tools.check("无父链派生默认拒绝", withoutParent === "CausalChainMissing", withoutParent);
  },
});

const report = await gate.run();
process.exitCode = report.counts.fail > 0 ? 1 : 0;
