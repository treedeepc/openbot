import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImDeviceStore } from "../src/backend/im/device-store";
import { createImIdentity, ImDeviceRegistry, imNewPairingCode } from "../src/backend/im/identity";
import { addImPairingCodeColumn } from "../src/backend/migrations/0070-im-pairing-code";
import { LATEST_SCHEMA_VERSION, migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { record } from "./verify-im-helpers";

const REPO = resolve(import.meta.dirname, "..");

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-pairing-"));
const scope = { localServerId: "srv-1", localMemberId: "me" };
const identity = createImIdentity();
const keyA = createImIdentity();
const keyB = createImIdentity();
const keyC = createImIdentity();
const now = 1_700_000_000_000;
const TTL = 900_000;

const open = (path: string) => {
  const db = new DatabaseSync(path);
  migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
  return db;
};

const path = join(root, "openbot.db");
let db = open(path);
let store = new ImDeviceStore(db);
let registry = new ImDeviceRegistry(identity, store, scope);

const begun = registry.enrollBegin({ ...scope, deviceId: "device-a", publicKey: keyA.publicKey, now, ttlMs: TTL });
check(
  "入网生成随机码并随记录返回",
  /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(begun.pairingCode ?? ""),
  String(begun.pairingCode),
);
const saved = store.read(scope.localServerId, scope.localMemberId, "device-a");
check(
  "随机码与 TTL 同批落库",
  saved?.pairingCode === begun.pairingCode && saved?.pairingExpiresAt === now + TTL,
  JSON.stringify(saved?.pairingExpiresAt),
);

const samples = [imNewPairingCode(), imNewPairingCode(), imNewPairingCode(), imNewPairingCode(), imNewPairingCode()];
check("随机性：5 个码互不相同", new Set(samples).size === samples.length, samples.join(","));

const late = registry.enrollBegin({ ...scope, deviceId: "device-late", publicKey: keyC.publicKey, now, ttlMs: TTL });
const codeLate = late.pairingCode ?? "";
db.close();

db = open(path);
store = new ImDeviceStore(db);
registry = new ImDeviceRegistry(identity, store, scope);

check(
  "对照组·未过期的码重开后仍可批准",
  registry.enrollApprove({
    deviceId: "device-a",
    pairingCode: begun.pairingCode ?? "",
    now: now + 1,
    ttlMs: 86_400_000,
  }).status === "active",
  "",
);

let expired = "";
try {
  registry.enrollApprove({ deviceId: "device-late", pairingCode: codeLate, now: now + TTL + 1, ttlMs: 86_400_000 });
} catch (error) {
  expired = error instanceof Error ? error.name : "";
}
check("重开后过期的码必须 im.pairingExpired", expired === "ImPairingExpired", expired || "没有报错");

const expiredAttempt = registry.enrollStatus("device-late");
check("过期未批准：设备仍是 pending（未被误激活）", expiredAttempt === "pending", expiredAttempt);

let sameSessionExpired = "";
try {
  registry.enrollApprove({ deviceId: "device-late", pairingCode: codeLate, now: now + TTL + 2, ttlMs: 86_400_000 });
} catch (error) {
  sameSessionExpired = error instanceof Error ? error.name : "";
}
check("同会话内过期的码同样拒绝", sameSessionExpired === "ImPairingExpired", sameSessionExpired);

let wrongCode = "";
try {
  registry.enrollApprove({ deviceId: "device-late", pairingCode: "0000-0000", now: now + 3, ttlMs: 86_400_000 });
} catch (error) {
  wrongCode = error instanceof Error ? error.name : "";
}
check("错码被拒（im.pairingExpired）", wrongCode === "ImPairingExpired", wrongCode);

const begunB = registry.enrollBegin({
  ...scope,
  deviceId: "device-b",
  publicKey: keyB.publicKey,
  now: now + 4,
  ttlMs: TTL,
});
registry.enrollApprove({
  deviceId: "device-b",
  pairingCode: begunB.pairingCode ?? "",
  now: now + 5,
  ttlMs: 86_400_000,
});
const afterApprove = store.read(scope.localServerId, scope.localMemberId, "device-b");
check(
  "批准后 pairing_code 清空（单次使用）",
  afterApprove?.pairingCode === null && afterApprove?.pairingExpiresAt === null,
  JSON.stringify(afterApprove?.pairingCode),
);

let reused = "";
try {
  registry.enrollApprove({
    deviceId: "device-b",
    pairingCode: begunB.pairingCode ?? "",
    now: now + 6,
    ttlMs: 86_400_000,
  });
} catch (error) {
  reused = error instanceof Error ? error.name : "";
}
check(
  "已批准设备不会二次消费配对码",
  reused === "" && registry.enrollStatus("device-b") === "active",
  reused || "幂等返回",
);

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");
const ddlAfter = record(
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_devices'").get(),
);
check("0069 后 local_devices 带 pairing_code", String(ddlAfter?.sql).includes("pairing_code"), "");
db.close();

const oldPath = join(root, "old.db");
const oldDb = new DatabaseSync(oldPath);
migrateOpenBotDatabase(oldDb, { appliedAt: new Date().toISOString(), throughVersion: 68 });
oldDb
  .prepare(
    `INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status,
      cert_ref, enrolled_at, revoked_at, pairing_expires_at) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?)`,
  )
  .run(scope.localServerId, scope.localMemberId, "legacy-pending", keyA.publicKey, now + TTL);
oldDb.close();

const upgraded = open(oldPath);
const upgradedStore = new ImDeviceStore(upgraded);
const upgradedRegistry = new ImDeviceRegistry(identity, upgradedStore, scope);
let noFallback = "";
try {
  upgradedRegistry.enrollApprove({
    deviceId: "legacy-pending",
    pairingCode: "6F70-656E",
    now: now + 1,
    ttlMs: 86_400_000,
  });
} catch (error) {
  noFallback = error instanceof Error ? error.name : "";
}
check("升级后旧 pending 设备没有派生回退", noFallback === "ImPairingExpired", noFallback);
check(
  "升级后旧记录 pairing_code 为 NULL",
  upgradedStore.read(scope.localServerId, scope.localMemberId, "legacy-pending")?.pairingCode === null,
  "",
);

const legacyDdl = upgraded
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_devices'")
  .get();
const freshPath = join(root, "fresh.db");
const fresh = open(freshPath);
const freshDdl = record(
  fresh.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_devices'").get(),
);
check("parity：新库与升级库的 local_devices 同构", freshDdl?.sql === legacyDdl?.sql, "");
check("parity：升级路径 foreign_key_check 为空", upgraded.prepare("PRAGMA foreign_key_check").all().length === 0, "");
check("parity：新库路径 foreign_key_check 为空", fresh.prepare("PRAGMA foreign_key_check").all().length === 0, "");
const freshAgain = new DatabaseSync(join(root, "again.db"));
migrateOpenBotDatabase(freshAgain, { appliedAt: new Date().toISOString() });
addImPairingCodeColumn(freshAgain);
check("幂等：重复跑 0069 不报错", true, `LATEST=${LATEST_SCHEMA_VERSION}`);
freshAgain.close();
fresh.close();
upgraded.close();

const source = await readFile(`${REPO}/src/backend/im/identity.ts`, "utf8");
check("派生语义已删：源码里没有 imPairingCode", !source.includes("imPairingCode"), "");
check("派生语义已删：没有派生前缀常量", !source.includes("openbot-im-pairing-v1"), "");

await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
