import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CausalChain } from "../src/backend/im/causal-chain";
import * as gate from "../src/backend/im/causal-chain";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { record, text } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const external: CausalChain = { chainId: "c-1", rootMessageId: "m-1", trustDomain: "im-peer", createdAt: 1 };
const local: CausalChain = { chainId: "c-2", rootMessageId: "m-2", trustDomain: "local", createdAt: 1 };

check("A1 外部链禁用工具", gate.mayUseTools(external) === false, "");
check("A1 本地链可用工具", gate.mayUseTools(local) === true, "");
check("A1 缺因果链默认拒绝", gate.mayUseTools(null) === false && gate.toolsDecision(null).allowed === false, "");
check("A1 外部链只回文本（toolsEnabled=false）", gate.toolsDecision(external).toolsEnabled === false, "");
check("A1 本地链 toolsEnabled", gate.toolsDecision(local).toolsEnabled === true, "");

let threw = false;
try {
  gate.requireChain(null);
} catch {
  threw = true;
}
check("A1 缺声明抛错（传递失败默认拒绝）", threw, "");

const derived = gate.inheritedChain(external, { createdAt: 2 });
check("A2 派生任务继承因果链", derived.chainId === "c-1" && derived.rootMessageId === "m-1", JSON.stringify(derived));
check("A2 继承后仍是外部链、工具禁用", gate.mayUseTools(derived) === false, "");
const derived2 = gate.inheritedChain(derived, { chainId: "c-3", createdAt: 3 });
check(
  "A2 二级派生继承信任域",
  derived2.trustDomain === "im-peer" && derived2.chainId === "c-3",
  JSON.stringify(derived2),
);

const stopOwn = gate.decideInboundAction({
  action: "stop",
  chainId: "c-1",
  sessionThreadId: "t-1",
  targetThreadId: "t-1",
  targetKind: "own-reply",
});
check(
  "A3 外部 stop 只停自己会话的回复",
  stopOwn.allowed === true && stopOwn.toolsEnabled === false,
  JSON.stringify(stopOwn),
);
const stopLocal = gate.decideInboundAction({
  action: "stop",
  chainId: "c-1",
  sessionThreadId: "t-1",
  targetThreadId: "t-2",
  targetKind: "local-task",
});
check("A3 外部 stop 不得停本地任务", stopLocal.allowed === false, JSON.stringify(stopLocal));
const stopOther = gate.decideInboundAction({
  action: "stop",
  chainId: "c-1",
  sessionThreadId: "t-1",
  targetThreadId: "t-2",
  targetKind: "other-session",
});
check("A3 外部 stop 不得停其他会话", stopOther.allowed === false, "");
const stopProc = gate.decideInboundAction({
  action: "stop",
  chainId: "c-1",
  sessionThreadId: "t-1",
  targetThreadId: null,
  targetKind: "system-process",
});
check("A3 外部 stop 不得停系统进程", stopProc.allowed === false, "");
const approval = gate.decideInboundAction({
  action: "approval",
  chainId: "c-1",
  sessionThreadId: "t-1",
  targetThreadId: "t-1",
  targetKind: "own-reply",
});
check("A3 approval 一律拒绝", approval.allowed === false, JSON.stringify(approval));
const reply = gate.decideInboundAction({
  action: "reply",
  chainId: "c-1",
  sessionThreadId: "t-1",
  targetThreadId: "t-1",
  targetKind: "own-reply",
});
check("A3 外部 reply 只回文本", reply.allowed === true && reply.toolsEnabled === false, JSON.stringify(reply));

const kept = gate.externalContext([
  { source: "current-message", text: "hi" },
  { source: "explicit-attachment", text: "a.png", marked: true },
  { source: "session-history", text: "earlier" },
  { source: "local-memory", text: "secret" },
  { source: "skill-output", text: "tool out" },
]);
check(
  "A4 白名单只留三类来源",
  kept.length === 3 && kept.every((entry) => entry.marked),
  kept.map((e) => e.source).join(","),
);
check(
  "A4 外部内容标记来源",
  kept.every((entry) => typeof entry.marked === "boolean"),
  "",
);
const clean = gate.externalContextIsClean([
  { source: "current-message" },
  { source: "local-memory" },
  { source: "workspace-instructions" },
  { source: "other-session" },
]);
check(
  "A4 泄漏检出（记忆/工作区/其他会话）",
  clean.clean === false && clean.leaked.length === 3,
  clean.leaked.join(","),
);

const root = await mkdtemp(join(tmpdir(), "im-causal-"));
const path = join(root, "openbot.db");
const db = new DatabaseSync(path);
migrateOpenBotDatabase(db, { appliedAt: "2026-11-21T00:00:00.000Z" });
const tables = [
  "projection_agent_threads",
  "projection_channel_tasks",
  "workflow_runs",
  "workflow_steps",
  "projection_deliveries",
];
check(
  "五张任务表都有 causal_chain_id",
  tables.every((table) =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === "causal_chain_id"),
  ),
  tables
    .filter(
      (t) =>
        !db
          .prepare(`PRAGMA table_info(${t})`)
          .all()
          .some((c) => c.name === "causal_chain_id"),
    )
    .join(","),
);
check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");
db.exec("PRAGMA foreign_keys = OFF");
db.exec("INSERT INTO projection_channel_tasks (task_id, channel_id, task_json) VALUES ('t-1', 'c-1', '{}')");
db.exec("PRAGMA foreign_keys = ON");
db.prepare("UPDATE projection_channel_tasks SET causal_chain_id = ? WHERE task_id = ?").run("c-1", "t-1");
const row = record(db.prepare("SELECT causal_chain_id FROM projection_channel_tasks WHERE task_id = ?").get("t-1"));
check("因果链可持久化", row.causal_chain_id === "c-1", JSON.stringify(row));

migrateOpenBotDatabase(db, { appliedAt: "2026-11-21T00:00:01.000Z" });
const after = record(db.prepare("SELECT causal_chain_id FROM projection_channel_tasks WHERE task_id = ?").get("t-1"));
check("重启后因果链仍在（队列恢复场景）", after.causal_chain_id === "c-1", JSON.stringify(after));
const persisted: CausalChain | null =
  after.causal_chain_id === "c-1"
    ? { chainId: text(after.causal_chain_id), rootMessageId: "m-1", trustDomain: "im-peer", createdAt: 1 }
    : null;
check("重启后闸门仍禁用工具", gate.mayUseTools(persisted) === false, "");
check(
  "重启后 approval 仍被拒",
  gate.decideInboundAction({
    action: "approval",
    chainId: "c-1",
    sessionThreadId: "t",
    targetThreadId: "t",
    targetKind: "own-reply",
  }).allowed === false,
  "",
);
db.close();
await rm(root, { recursive: true, force: true });

check(
  "缺声明（undefined）默认拒绝工具",
  gate.authorizeToolCall(undefined).allowed === false,
  JSON.stringify(gate.authorizeToolCall(undefined)),
);
check(
  "显式本地（null）放行工具",
  gate.authorizeToolCall(null).toolsEnabled === true,
  JSON.stringify(gate.authorizeToolCall(null)),
);
check("外部链拒绝工具", gate.authorizeToolCall(external).toolsEnabled === false, "");
check("本地链放行工具", gate.authorizeToolCall(local).toolsEnabled === true, "");

const registry = new gate.CausalChainRegistry();
const declared = registry.declare({ chainId: "r-1", rootMessageId: "m-1", trustDomain: "im-peer", createdAt: 1 });
check("registry 持久化因果链", registry.read("r-1")?.trustDomain === "im-peer", JSON.stringify(declared));
check("registry 缺声明拒绝", registry.authorize(undefined).allowed === false, "");
check("registry 显式本地放行", registry.authorize(null).toolsEnabled === true, "");
check("registry 外部链拒绝", registry.authorize("r-1").toolsEnabled === false, "");
const child = registry.derive(declared, "r-2", 2);
check("registry 派生继承", child.rootMessageId === "m-1" && child.trustDomain === "im-peer", JSON.stringify(child));
check("registry 派生后仍禁工具", registry.authorize("r-2").toolsEnabled === false, "");
const localChild = registry.derive(
  { chainId: "r-3", rootMessageId: "m-3", trustDomain: "local", createdAt: 1 },
  "r-4",
  2,
);
check("registry 本地派生可放行", registry.authorize("r-4").toolsEnabled === true, JSON.stringify(localChild));

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
