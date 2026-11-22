import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImAuditLog, redactImValue } from "../src/backend/im/audit";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { record, text } from "./verify-im-helpers";

const REPO = resolve(import.meta.dirname, "..");

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-audit-"));
const path = join(root, "openbot.db");
const scope = { localServerId: "srv-1", localMemberId: "me" };
const otherScope = { localServerId: "srv-1", localMemberId: "other" };

const open = () => {
  const db = new DatabaseSync(path);
  migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
  return db;
};

let db = open();
let audit = new ImAuditLog(db);

const SECRET_TOKEN = "sk-live-0123456789ABCDEFGHIJKLMNO";
const publicKey = "a".repeat(48);

const row = audit.record(scope, {
  id: "ev-1",
  actorId: "agent-1",
  sourceTrustDomain: "host",
  action: "im.deviceEnroll",
  targetId: "device-a",
  result: "ok",
  correlationId: "corr-1",
  before: { status: "pending" },
  after: { status: "active", publicKey, token: SECRET_TOKEN, nested: { password: "hunter2", keep: "visible" } },
  at: 1000,
  detail: { note: `token=${SECRET_TOKEN}`, pairingCode: "A1B2-C3D4" },
});

check("T12a1 审计写入后读回", row.id === "ev-1" && row.action === "im.deviceEnroll", "");
const read = record(audit.read(scope, "ev-1"));
check("T12a1 读回来源信任域与关联 id", read?.sourceTrustDomain === "host" && read?.correlationId === "corr-1", "");

const after = JSON.parse(text(read.after));
check("T12a1 写入前脱敏：密钥名 token", after.token === "[redacted]", String(after.token));
check("T12a1 写入前脱敏：密钥名 password", after.nested.password === "[redacted]", String(after.nested.password));
check("T12a1 写入前脱敏：长串 publicKey", after.publicKey === "[redacted]", String(after.publicKey));
check("T12a1 脱敏保留非敏感字段", after.status === "active" && after.nested.keep === "visible", "");
const detail = JSON.parse(text(read.redactedDetail));
check("T12a1 写入前脱敏：detail 里的明文密钥", !text(read.redactedDetail).includes(SECRET_TOKEN), "");
check(
  "T12a1 脱敏保留可读文案",
  detail.note === "[redacted]" && detail.pairingCode === "A1B2-C3D4",
  JSON.stringify(detail.note),
);

const flat = record(redactImValue({ publicKey, deviceId: "device-a", expiresAt: 5 }));
check(
  "T12a1 redactImValue 单独可用",
  flat.publicKey === "[redacted]" && flat.deviceId === "device-a" && flat.expiresAt === 5,
  "",
);

audit.record(scope, {
  id: "ev-2",
  actorId: "agent-1",
  sourceTrustDomain: "host",
  action: "im.deviceRevoke",
  targetId: "device-a",
  result: "ok",
  correlationId: "corr-1",
  before: null,
  after: { status: "revoked" },
  at: 2000,
});

check(
  "T12a1 按关联 id 聚合",
  audit.byCorrelation(scope, "corr-1").length === 2,
  String(audit.byCorrelation(scope, "corr-1").length),
);
check(
  "T12a1 列表按时间排序",
  audit
    .list(scope)
    .map((entry) => entry.id)
    .join(",") === "ev-1,ev-2",
  "",
);

let overwriteRefused = false;
try {
  audit.record(scope, {
    id: "ev-1",
    actorId: "attacker",
    sourceTrustDomain: "host",
    action: "tamper",
    targetId: "device-a",
    result: "ok",
    correlationId: "corr-1",
    before: null,
    after: null,
    at: 3000,
  });
} catch (error) {
  overwriteRefused = String(error).includes("UNIQUE") || String(error).includes("PRIMARY");
}
check("T12a1 只追加：同 id 再写入被主键拒绝", overwriteRefused, "");
check(
  "T12a1 只追加：原事件未被篡改",
  audit.read(scope, "ev-1")?.action === "im.deviceEnroll",
  audit.read(scope, "ev-1")?.action,
);

const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(audit));
check(
  "T12a1 只追加：无 update/delete 方法",
  !methods.some((name) => /update|delete|remove|patch|upsert/i.test(name)),
  methods.join(","),
);

const source = await readFile(`${REPO}/src/backend/im/audit.ts`, "utf8");
const mutations = source.match(/\b(?:UPDATE|DELETE|DROP|ALTER)\b/gi) ?? [];
check("T12a1 只追加：SQL 里没有 UPDATE/DELETE/DROP/ALTER", mutations.length === 0, mutations.join(","));
check("T12a1 只追加：只有 INSERT 一条写入语句", (source.match(/INSERT INTO audit_log/g) ?? []).length === 1, "");

check("T12a1 作用域隔离：别的成员看不到", audit.list(otherScope).length === 0, "");
audit.record(otherScope, {
  id: "ev-9",
  actorId: "agent-2",
  sourceTrustDomain: "host",
  action: "im.messageSend",
  targetId: "lm-1",
  result: "ok",
  correlationId: "corr-2",
  before: null,
  after: null,
  at: 4000,
});
check("T12a1 作用域隔离：写入互不串读", audit.list(scope).length === 2 && audit.list(otherScope).length === 1, "");

const raw = record(db.prepare("SELECT * FROM audit_log WHERE id = ?").get("ev-1"));
check("T12a1 落盘即脱敏：库里无明文密钥", !JSON.stringify(raw).includes(SECRET_TOKEN), "");
check("T12a1 落盘即脱敏：库里无原始公钥", !JSON.stringify(raw).includes(publicKey), "");

check("T12a1 迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");
db.close();

db = open();
audit = new ImAuditLog(db);
check("T12a1 跨会话只追加仍在", audit.list(scope).length === 2 && audit.read(scope, "ev-2") !== null, "");
check("T12a1 跨会话后仍是脱敏后的内容", !JSON.stringify(audit.read(scope, "ev-1")).includes(SECRET_TOKEN), "");
db.close();

await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
