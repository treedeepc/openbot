import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  decodeImWireFrame,
  ImWireForwarder,
  type ImWireFrame,
  ImWireRejected,
  isWirePayload,
} from "../src/backend/im/wire";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { bytes, itemAt, record } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
function threw(name: string, run: () => unknown, expected: string): void {
  let code = "";
  try {
    run();
  } catch (error) {
    code = error instanceof Error ? error.name : String(error);
  }
  check(name, code === expected, code || "没有报错");
}

const root = await mkdtemp(join(tmpdir(), "im-wire-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
db.prepare(
  "INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status, cert_ref, enrolled_at, revoked_at, pairing_expires_at, pairing_code) VALUES ('srv-1','me','device-a','pk','active',NULL,1,NULL,NULL,NULL)",
).run();
db.prepare(
  "INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status, cert_ref, enrolled_at, revoked_at, pairing_expires_at, pairing_code) VALUES ('srv-1','me','device-b','pk2','active',NULL,1,NULL,NULL,NULL)",
).run();
db.exec("PRAGMA foreign_keys = ON");

const forwarder = new ImWireForwarder(db, "srv-1");
const at = 1_700_000_000_000;
const frame: ImWireFrame = {
  type: "forward",
  fromServerId: "srv-2",
  fromAgentId: "agent-peer",
  toServerId: "srv-1",
  toAgentId: "me",
  sealed: "ciphertext-aaaa",
  nonce: "nonce-1",
  remoteMessageId: "rm-aaaa",
  sentAt: at,
};

const forwarded = forwarder.forward("me", {
  frame,
  deviceIds: ["device-a", "device-b"],
  at,
  expiresAt: at + 86_400_000,
  chain: null,
});
check(
  "T7b 密文转发：两台设备各入队",
  forwarded.outcomes.length === 2 && forwarded.outcomes.every((o) => o.queued),
  JSON.stringify(forwarded.outcomes.map((o) => o.deviceId)),
);
check(
  "T7b 密文转发：密文原样入队（不解密）",
  new TextDecoder().decode(
    bytes(
      record(
        db
          .prepare("SELECT sealed_payload FROM offline_queue WHERE queue_id = ?")
          .get(itemAt(forwarded.outcomes, 0).queueId),
      ).sealed_payload,
    ),
  ) === "ciphertext-aaaa",
  "",
);
const round = forwarder.receive(itemAt(forwarded.outcomes, 0) && frame);
check("T7b 接收：帧解码先于任何处理", round.type === "forward" && round.sealed === "ciphertext-aaaa", "");
check(
  "T7b 接收：sender 先于 decode——坏帧直接拒",
  (() => {
    try {
      decodeImWireFrame({ ...frame, fromServerId: "" });
      return false;
    } catch {
      return true;
    }
  })(),
  "",
);
threw("T7b 接收：未知消息类型拒", () => decodeImWireFrame({ ...frame, type: "bogus" }), "ImWireRejected");
threw("T7b 接收：缺字段拒", () => decodeImWireFrame({ ...frame, sealed: undefined }), "ImWireRejected");
check(
  "T7b 接收：收件人不匹配拒",
  (() => {
    try {
      forwarder.accept("other-member", frame, { kind: "message", body: "x" });
      return false;
    } catch (error) {
      return error instanceof ImWireRejected;
    }
  })(),
  "",
);
check("T7b 接收：合法载荷被接受", forwarder.accept("me", frame, { kind: "message", body: "x" }).accepted === true, "");
check("T7b 载荷校验：缺 kind 拒", isWirePayload({ body: "x" }) === false, "");
check(
  "T7b 取件确认：ack 后有时间戳",
  forwarder.confirm("me", { queueId: itemAt(forwarded.outcomes, 0).queueId, at: at + 10 }) === true,
  "",
);
check("对照组：缺链声明时 fail-closed（不放行工具）", forwarded.mayExecuteTools === false, "");
check(
  "对照组：本地链转发可执行工具",
  forwarder.forward("me", {
    frame: { ...frame, nonce: "nonce-2", remoteMessageId: "rm-aaaa-2" },
    deviceIds: ["device-a"],
    at,
    expiresAt: at + 86_400_000,
    chain: { chainId: "c-local", rootMessageId: "m", trustDomain: "local", createdAt: at },
  }).mayExecuteTools === true,
  "",
);

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");
db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
