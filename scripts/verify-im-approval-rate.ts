import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImDeviceStore } from "../src/backend/im/device-store";
import { createImIdentity, ImDeviceRegistry, ImPairingRateLimited } from "../src/backend/im/identity";
import { IM_RATE_LIMITS, ImRateLimiter, imApprovalRatePort } from "../src/backend/im/social";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { itemAt } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-approval-rate-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });

const scope = { localServerId: "srv-1", localMemberId: "me" };
const identity = createImIdentity();
const store = new ImDeviceStore(db);
const limiter = new ImRateLimiter(db);
const policy = IM_RATE_LIMITS.pairingApprove;
const registry = new ImDeviceRegistry(identity, store, scope, imApprovalRatePort(limiter, scope, policy));

const now = 1_700_000_000_000;
const keys = [createImIdentity(), createImIdentity(), createImIdentity(), createImIdentity()];

const begun = registry.enrollBegin({
  ...scope,
  deviceId: "device-a",
  publicKey: itemAt(keys, 0).publicKey,
  now,
  ttlMs: 900_000,
});
const approved = registry.enrollApprove({
  deviceId: "device-a",
  pairingCode: begun.pairingCode ?? "",
  now: now + 1,
  ttlMs: 86_400_000,
});
check("对照组：首次正确批准成功", approved.status === "active", approved.status);

const second = registry.enrollBegin({
  ...scope,
  deviceId: "device-b",
  publicKey: itemAt(keys, 1).publicKey,
  now: now + 2,
  ttlMs: 900_000,
});
const codeB = second.pairingCode ?? "";

const failures = [];
for (let attempt = 0; attempt < policy.max; attempt += 1) {
  try {
    registry.enrollApprove({
      deviceId: "device-b",
      pairingCode: "0000-0000",
      now: now + 3 + attempt * (policy.cooldownMs + 100),
      ttlMs: 86_400_000,
    });
    failures.push("no-error");
  } catch (error) {
    failures.push(error instanceof Error ? error.name : String(error));
  }
}
check(
  "失败会被计数（每次都 im.pairingExpired）",
  failures.every((name) => name === "ImPairingExpired"),
  failures.join(","),
);

let limited = "";
let retryAfter = 0;
try {
  registry.enrollApprove({
    deviceId: "device-b",
    pairingCode: codeB,
    now: now + 3 + policy.max * (policy.cooldownMs + 100),
    ttlMs: 86_400_000,
  });
} catch (error) {
  limited = error instanceof Error ? error.name : String(error);
  retryAfter = error instanceof ImPairingRateLimited ? error.retryAfterMs : 0;
}
check("超过额度后被限速（im.rateLimited）", limited === "ImPairingRateLimited", limited);
check("限速带 retryAfterMs", retryAfter > 0, String(retryAfter));
check("限速是硬拦：正确码也不放行", registry.enrollStatus("device-b") === "pending", registry.enrollStatus("device-b"));

const cooled = [];
try {
  registry.enrollApprove({ deviceId: "device-b", pairingCode: codeB, now: now + 4, ttlMs: 86_400_000 });
  cooled.push("no-error");
} catch (error) {
  cooled.push(error instanceof Error ? error.name : String(error));
}
check("冷却：失败后 1 秒内的下一次尝试被拦", itemAt(cooled, 0) === "ImPairingRateLimited", cooled.join(","));

const third = registry.enrollBegin({
  ...scope,
  deviceId: "device-c",
  publicKey: itemAt(keys, 2).publicKey,
  now: now + 10_000,
  ttlMs: 900_000,
});
const fresh = registry.enrollApprove({
  deviceId: "device-c",
  pairingCode: third.pairingCode ?? "",
  now: now + 10_001,
  ttlMs: 86_400_000,
});
check("对照组：别的设备不受 device-b 影响", fresh.status === "active", fresh.status);

const fourth = registry.enrollBegin({
  ...scope,
  deviceId: "device-d",
  publicKey: itemAt(keys, 3).publicKey,
  now: now + 20_000,
  ttlMs: 900_000,
});
const plain = new ImDeviceRegistry(identity, store, scope);
const plainFails = [];
for (let attempt = 0; attempt < policy.max + 2; attempt += 1) {
  try {
    plain.enrollApprove({
      deviceId: "device-d",
      pairingCode: "0000-0000",
      now: now + 20_001 + attempt * 2_000,
      ttlMs: 86_400_000,
    });
    plainFails.push("no-error");
  } catch (error) {
    plainFails.push(error instanceof Error ? error.name : String(error));
  }
}
check(
  "对照组：没接限速端口时不会限速（端口才是执行点）",
  plainFails.every((name) => name === "ImPairingExpired"),
  plainFails.join(","),
);

const successNotCounted = [];
try {
  registry.enrollApprove({
    deviceId: "device-d",
    pairingCode: fourth.pairingCode ?? "",
    now: now + 40_000,
    ttlMs: 86_400_000,
  });
  successNotCounted.push("approved");
} catch (error) {
  successNotCounted.push(error instanceof Error ? error.name : String(error));
}
check("成功不消耗失败额度", itemAt(successNotCounted, 0) === "approved", successNotCounted.join(","));

const bucket = db
  .prepare("SELECT count FROM audit_aggregates WHERE actor_id = ? AND action = ? AND result = 'denied'")
  .get("device-b", "im.pairingApprove");
check("失败计数落在 audit_aggregates（denied 桶）", Number(bucket?.count) === policy.max, String(bucket?.count));

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");

db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
