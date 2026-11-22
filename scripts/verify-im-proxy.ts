import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CausalChain } from "../src/backend/im/causal-chain";
import * as gate from "../src/backend/im/causal-chain";
import * as proxy from "../src/backend/im/proxy";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-proxy-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
const scope = { localServerId: "srv-1", localMemberId: "me" };
const threadFixtures: [string, string][] = [
  ["me", "th-1"],
  ["other", "th-2"],
];
for (const [member, threadId] of threadFixtures) {
  db.prepare(
    "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1', ?, ?, 'srv-2', 'agent-peer', 'open', NULL)",
  ).run(member, threadId);
}
db.exec("PRAGMA foreign_keys = ON");

const chain = new proxy.ImPrimaryChain(db);
chain.assign(scope, "th-1", "agent-a", "primary");
chain.assign(scope, "th-1", "agent-b", "assist");
check("单一主责：初始指派", chain.primary(scope, "th-1") === "agent-a", chain.primary(scope, "th-1") ?? "null");

const afterTransfer = chain.transfer(scope, "th-1", "agent-a", "agent-b");
check(
  "转交：新主责唯一",
  afterTransfer.filter((a) => a.role === "primary").length === 1,
  JSON.stringify(afterTransfer),
);
check("转交：旧主责降为 assist", afterTransfer.find((a) => a.agentId === "agent-a")?.role === "assist", "");
check("转交：一次事务里完成（读回一致）", chain.primary(scope, "th-1") === "agent-b", "");

function threw(name: string, run: () => unknown, expected: string): void {
  let code = "";
  try {
    run();
  } catch (error) {
    code = error instanceof Error ? error.name : String(error);
  }
  check(name, code === expected, code || "没有报错");
}

threw("转交：非主责不能转交", () => chain.transfer(scope, "th-1", "agent-a", "agent-a"), "ImNotPrimary");
chain.assign(scope, "th-1", "agent-c", "assist");
threw(
  "转交：不能把主责转给自己以外未指派的人前先撤主责",
  () => chain.remove(scope, "th-1", "agent-b"),
  "ImPrimaryRequired",
);
check("对照组：可移除非主责", chain.remove(scope, "th-1", "agent-c").length === 2, "");
check(
  "作用域隔离：别的成员看不到指派",
  chain.assignees({ localServerId: "srv-1", localMemberId: "other" }, "th-1").length === 0,
  "",
);
threw(
  "作用域隔离：别的成员拿我的线程转交被拒",
  () => chain.transfer({ localServerId: "srv-1", localMemberId: "other" }, "th-1", "agent-b", "agent-a"),
  "ImThreadUnknown",
);
check(
  "对照组：别的成员自己的线程可正常指派",
  chain.assign({ localServerId: "srv-1", localMemberId: "other" }, "th-2", "agent-x", "primary").length === 1,
  "",
);

const speaking = new proxy.ImProxySpeaking(db);
const peerKey = "srv-2/agent-peer";
const at = Date.UTC(2026, 10, 21);
const proxied = proxy.imProxiedMessage({
  speaker: "agent-a",
  onBehalfOf: "agent-b",
  visibility: "shown",
  body: "on behalf",
});
check(
  "代聊：proxiedBy 与可见性一起落",
  proxied.proxiedBy === "agent-b" && proxied.proxyVisibility === "shown",
  JSON.stringify(proxied),
);
check(
  "代聊：自己发言不带代聊标记",
  proxy.imProxiedMessage({ speaker: "agent-a", onBehalfOf: null, visibility: null, body: "hi" }).proxiedBy === null,
  "",
);
threw(
  "代聊：给了 proxiedBy 缺可见性被拒",
  () => proxy.imProxiedMessage({ speaker: "a", onBehalfOf: "b", visibility: null, body: "x" }),
  "ImProxyNotAllowed",
);

speaking.charge(scope, peerKey, 1_500, at);
check(
  "预算：记账 15 美元后剩 5 美元",
  speaking.budget(scope, peerKey, at).remainingUsd === 5,
  JSON.stringify(speaking.budget(scope, peerKey, at)),
);
check("预算：还能代聊 5 美元", speaking.canSpeak(scope, peerKey, 500, at) === true, "");
check("预算：6 美元超出 20 上限", speaking.canSpeak(scope, peerKey, 600, at) === false, "");
speaking.charge(scope, peerKey, 500, at);
threw("预算：超支被拒（im.budgetExceeded）", () => speaking.charge(scope, peerKey, 1, at), "ImProxyBudgetExceeded");
check(
  "预算：上限正好 20 美元",
  speaking.budget(scope, peerKey, at).spentUsd === 20,
  String(speaking.budget(scope, peerKey, at).spentUsd),
);
const nextMonth = Date.UTC(2026, 11, 5);
check("预算：跨月重置", speaking.budget(scope, peerKey, nextMonth).spentUsd === 0, "");
check("预算：按对端分开计数", speaking.budget(scope, "srv-3/agent-other", at).spentUsd === 0, "");

const external: CausalChain = { chainId: "c-1", rootMessageId: "m-1", trustDomain: "im-peer", createdAt: at };
const local: CausalChain = { chainId: "c-2", rootMessageId: "m-2", trustDomain: "local", createdAt: at };
const externalDecision = proxy.imExecutionDecision(external);
check(
  "R10：外部会话只说话不动手",
  externalDecision.maySpeak === true && externalDecision.mayExecuteTools === false,
  JSON.stringify(externalDecision),
);
check("R10：imExternalSpeaksOnly 判定", proxy.imExternalSpeaksOnly(external) === true, "");
const localDecision = proxy.imExecutionDecision(local);
check("对照组：本地链可执行工具", localDecision.mayExecuteTools === true && localDecision.maySpeak === true, "");
const missing = proxy.imExecutionDecision(undefined);
check("R10：缺声明默认双拒", missing.maySpeak === false && missing.mayExecuteTools === false, JSON.stringify(missing));
check(
  "R10：裁决点就是 toolsDecision",
  proxy.imExecutionDecision(external).mayExecuteTools === gate.toolsDecision(external).toolsEnabled,
  "",
);

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");

db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
