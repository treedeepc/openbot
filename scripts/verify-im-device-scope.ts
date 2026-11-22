import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImDeviceStore } from "../src/backend/im/device-store";
import {
  createImIdentity,
  ImDeviceRegistry,
  imNewPairingCode,
  verifyDeviceCertificate,
} from "../src/backend/im/identity";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-device-scope-"));
const path = join(root, "openbot.db");
const scope = { localServerId: "srv-1", localMemberId: "me" };
const otherScope = { localServerId: "srv-1", localMemberId: "other" };
const identity = createImIdentity();
const keyA = createImIdentity();
const keyB = createImIdentity();
const now = 1_700_000_000_000;

const open = () => {
  const db = new DatabaseSync(path);
  migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
  return db;
};

let db = open();
let store = new ImDeviceStore(db);
let registry = new ImDeviceRegistry(identity, store, scope);
const begunA = registry.enrollBegin({
  ...scope,
  deviceId: "device-a",
  publicKey: keyA.publicKey,
  now,
  ttlMs: 900_000,
});
registry.enrollApprove({
  deviceId: "device-a",
  pairingCode: begunA.pairingCode ?? "",
  now: now + 1,
  ttlMs: 86_400_000,
});
const begunB = registry.enrollBegin({
  ...scope,
  deviceId: "device-b",
  publicKey: keyB.publicKey,
  now: now + 2,
  ttlMs: 900_000,
});
const codeB = begunB.pairingCode ?? "";
check(
  "写入侧正常：活跃 1、待批准 1",
  registry.activeDevices().length === 1 && registry.enrollStatus("device-b") === "pending",
  "",
);
const samples = [begunA.pairingCode, begunB.pairingCode, imNewPairingCode(), imNewPairingCode(), imNewPairingCode()];
check(
  "配对码随机且格式 XXXX-XXXX",
  samples.every((code) => /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(code ?? "")),
  samples.join(","),
);
check("配对码互不相同（不再由公钥派生）", new Set(samples).size === samples.length, String(new Set(samples).size));
db.close();

db = open();
store = new ImDeviceStore(db);
registry = new ImDeviceRegistry(identity, store, scope);

check("对照组·未撤销设备重开后仍可验真", registry.verifyDevice("device-a", now + 3) === true, "");
check(
  "对照组·重开后 activeDevices 非空",
  registry.activeDevices().length === 1,
  String(registry.activeDevices().length),
);

const approved = registry.enrollApprove({ deviceId: "device-b", pairingCode: codeB, now: now + 4, ttlMs: 86_400_000 });
check("M1-11 重开后待批准设备可继续批准", approved.status === "active", approved.status);
check("M1-11 批准后可验真", registry.verifyDevice("device-b", now + 5) === true, "");

registry.revoke("device-a", now + 6);
db.close();

db = open();
store = new ImDeviceStore(db);
registry = new ImDeviceRegistry(identity, store, scope);
check("M1-12 撤销跨会话生效", registry.verifyDevice("device-a", now + 7) === false, "");
check("M1-12 对照组·同会话另一设备仍可验真", registry.verifyDevice("device-b", now + 7) === true, "");
check(
  "M1-12 撤销后状态读回 revoked",
  registry.enrollStatus("device-a") === "revoked",
  registry.enrollStatus("device-a"),
);
const revokedRecord = store.read(scope.localServerId, scope.localMemberId, "device-a");
check(
  "M1-12 撤销落盘 revoked_at + 证书失效",
  revokedRecord?.revokedAt === now + 6 && revokedRecord?.cert?.expiresAt === 0,
  JSON.stringify(revokedRecord?.revokedAt),
);
check(
  "M1-12 撤销后证书不可验",
  revokedRecord?.cert ? verifyDeviceCertificate(revokedRecord.cert, now + 8, identity.publicKey) === false : true,
  "",
);

const scoped = new ImDeviceRegistry(identity, store, otherScope);
check(
  "作用域隔离：别的成员看不到设备",
  scoped.activeDevices().length === 0 && scoped.verifyDevice("device-a", now + 9) === false,
  "",
);
check("作用域隔离：同名设备在他作用域内不受影响", scoped.verifyDevice("device-b", now + 9) === false, "");

let missingScope = false;
try {
  new ImDeviceRegistry(identity, store);
} catch (error) {
  missingScope = error instanceof Error && error.name === "ImDeviceScopeRequired";
}
check("缺作用域时直接报错（不再静默空载入）", missingScope, "");

const memory = new ImDeviceRegistry(identity);
memory.enrollBegin({
  ...scope,
  deviceId: "device-c",
  publicKey: keyA.publicKey,
  now,
  ttlMs: 900_000,
});
check("无 store 的纯内存用法不受影响", memory.enrollStatus("device-c") === "pending", "");

db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
