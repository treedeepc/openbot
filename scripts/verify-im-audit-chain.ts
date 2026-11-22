import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImAuditLog, redactImValue } from "../src/backend/im/audit";
import { addImAuditChainColumn } from "../src/backend/migrations/0070-im-audit-chain";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { itemAt, record, text } from "./verify-im-helpers";

const REPO = resolve(import.meta.dirname, "..");

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-audit-chain-"));
const scope = { localServerId: "srv-1", localMemberId: "me" };
const other = { localServerId: "srv-1", localMemberId: "other" };
const open = (path: string) => {
  const db = new DatabaseSync(path);
  migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
  return db;
};

const path = join(root, "openbot.db");
const db = open(path);
const audit = new ImAuditLog(db);

const longChain = "1f47c2ae-9d3b-4c1e-8a55-0d7e6b2c9a41";
const row = audit.record(scope, {
  id: "ev-1",
  actorId: "agent-1",
  sourceTrustDomain: "im-peer",
  action: "im.messageSend",
  targetId: "lm-1",
  result: "ok",
  correlationId: "corr-1",
  causalChainId: longChain,
  before: { state: "submitted" },
  after: { state: "acked", token: "sk-live-0123456789ABCDEFGHIJKLMNO" },
  at: 1000,
  detail: { note: "sent" },
});
check("0070 审计一等字段：写入返回带链", row.causalChainId === longChain, String(row.causalChainId));
const read = record(audit.read(scope, "ev-1"));
check("0070 一等字段读回不被脱敏", read?.causalChainId === longChain, String(read?.causalChainId));
check("0070 一等字段不进 redacted_detail", String(read.redactedDetail ?? "").includes(longChain) !== true, "");
check("0070 对照：detail 里的密钥仍被脱敏", JSON.parse(text(read.after)).token === "[redacted]", "");
check(
  "0070 对照：detail 里的长串会被脱敏",
  record(redactImValue({ note: longChain })).note === "[redacted]",
  JSON.stringify(redactImValue({ note: longChain })),
);

audit.record(scope, {
  id: "ev-2",
  actorId: "agent-1",
  sourceTrustDomain: "local",
  action: "im.deviceApprove",
  targetId: "device-a",
  result: "ok",
  correlationId: "corr-2",
  before: null,
  after: null,
  at: 2000,
});
check(
  "0070 链可空：不给链读回 null",
  audit.read(scope, "ev-2")?.causalChainId === null,
  String(audit.read(scope, "ev-2")?.causalChainId),
);

audit.record(other, {
  id: "ev-3",
  actorId: "agent-2",
  sourceTrustDomain: "im-peer",
  action: "im.messageSend",
  targetId: "lm-2",
  result: "ok",
  correlationId: "corr-3",
  before: null,
  after: null,
  causalChainId: "chain-other",
  at: 3000,
});
check("0070 作用域隔离", audit.list(scope).length === 2 && audit.list(other)[0]?.causalChainId === "chain-other", "");
check(
  "0070 只追加仍在：原型无 update/delete",
  !Object.getOwnPropertyNames(Object.getPrototypeOf(audit)).some((name) => /update|delete|remove/i.test(name)),
  "",
);

let overwriteRefused = false;
try {
  audit.record(scope, {
    id: "ev-1",
    actorId: "x",
    sourceTrustDomain: "host",
    action: "tamper",
    targetId: "y",
    result: "ok",
    correlationId: "c",
    before: null,
    after: null,
    at: 4000,
  });
} catch (error) {
  overwriteRefused = String(error).includes("UNIQUE") || String(error).includes("PRIMARY");
}
check("0070 只追加：同 id 再写被主键拒绝", overwriteRefused, "");
check("0070 只追加：原事件未被篡改", audit.read(scope, "ev-1")?.causalChainId === longChain, "");

const ddl = record(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get());
check("0070 后 audit_log 带 causal_chain_id", String(ddl?.sql).includes("causal_chain_id"), "");
check("0070 新库路径 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");
db.close();

const oldPath = join(root, "old.db");
const oldDb = new DatabaseSync(oldPath);
migrateOpenBotDatabase(oldDb, { appliedAt: new Date().toISOString(), throughVersion: 69 });
oldDb
  .prepare(
    `INSERT INTO audit_log (local_server_id, local_member_id, id, actor_id, source_trust_domain, action,
      target_id, result, correlation_id, before, after, at, redacted_detail)
     VALUES (?, ?, 'legacy-1', 'agent-1', 'host', 'im.messageSend', 'lm-3', 'ok', 'corr-legacy', NULL, NULL, 5000, NULL)`,
  )
  .run(scope.localServerId, scope.localMemberId);
oldDb.close();

const upgraded = open(oldPath);
const upgradedAudit = new ImAuditLog(upgraded);
check(
  "0070 升级后旧事件链为 null",
  upgradedAudit.read(scope, "legacy-1")?.causalChainId === null,
  String(upgradedAudit.read(scope, "legacy-1")?.causalChainId),
);
const upgradedDdl = record(
  upgraded.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get(),
);
const fresh = open(join(root, "fresh.db"));
const freshDdl = record(
  fresh.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get(),
);
check("parity：新库与升级库的 audit_log 同构", freshDdl?.sql === upgradedDdl?.sql, "");
check("parity：升级路径 foreign_key_check 为空", upgraded.prepare("PRAGMA foreign_key_check").all().length === 0, "");
addImAuditChainColumn(upgraded);
addImAuditChainColumn(fresh);
check("幂等：重复跑 0070 不报错", true, "");
fresh.close();
upgraded.close();

const source = await readFile(`${REPO}/src/backend/im/audit.ts`, "utf8");
check(
  "只追加：模块内无 UPDATE/DELETE/DROP/ALTER",
  !/\b(UPDATE|DELETE|DROP|ALTER)\b/.test(source),
  (source.match(/\b(UPDATE|DELETE|DROP|ALTER)\b/g) ?? []).join(","),
);
check("写入用带列名的 INSERT", /INSERT INTO audit_log \(/.test(source), "");
const columnless = [
  ...(await readFile(`${REPO}/src/backend/im/audit.ts`, "utf8")).matchAll(/INSERT INTO (\w+) VALUES/g),
].map((match) => itemAt(match, 1));
check("无列名位置插入扫描：0070 影响表无命中", columnless.length === 0, columnless.join(","));

await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
