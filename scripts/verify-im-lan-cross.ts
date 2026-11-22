import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createImIdentity, imFingerprint } from "../src/backend/im/identity";
import { ImLanDiscovery, type ImMdnsResponder } from "../src/backend/im/lan";
import { decodeImWireFrame, ImWireForwarder, ImWireRejected } from "../src/backend/im/wire";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { itemAt, record } from "./verify-im-helpers";

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

const at = 1_700_000_000_000;

const responder: ImMdnsResponder = {
  announce: () => {},
  browse: (onPeer) => {
    onPeer({
      host: "192.168.1.20",
      port: 47821,
      txt: { peerServerId: "srv-2", peerAgentId: "agent-peer", publicKey: "aa".repeat(32) },
    });
    onPeer({
      host: "192.168.1.21",
      port: 47822,
      txt: { peerServerId: "srv-3", peerAgentId: "agent-b", publicKey: "" },
    });
  },
  stop: () => {},
};
const lan = new ImLanDiscovery({ responder, turn: null });
lan.browse();
const discovered = lan.discovered();
check("T7 发现：mDNS 找到对端", discovered.length === 1, JSON.stringify(discovered.map((p) => p.peerAgentId)));
check(
  "T7 发现与信任分离：发现的都不可信",
  discovered.every((peer) => peer.trusted === false),
  "",
);
check("T7 发现与信任分离：TXT 缺公钥的直接丢弃", !discovered.some((peer) => peer.peerAgentId === "agent-b"), "");
threw(
  "T7 连接必验指纹：未核对就 connect 被拒",
  () => lan.connect({ peerServerId: "srv-2", peerAgentId: "agent-peer" }),
  "ImLanPeerUnverified",
);
threw(
  "T7 连接必验指纹：指纹不符拒",
  () => lan.verify({ peerServerId: "srv-2", peerAgentId: "agent-peer" }, "AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH"),
  "ImFingerprintMismatch",
);
check(
  "T7 连接必验指纹：指纹相符才可信",
  lan.verify({ peerServerId: "srv-2", peerAgentId: "agent-peer" }, imFingerprint("aa".repeat(32))).trusted === true,
  "",
);
check(
  "T7 连接必验指纹：可信后 connect 成功",
  lan.connect({ peerServerId: "srv-2", peerAgentId: "agent-peer" }).peerAgentId === "agent-peer",
  "",
);
threw(
  "T7 对照：未知对端 connect 仍拒",
  () => lan.connect({ peerServerId: "srv-9", peerAgentId: "x" }),
  "ImLanPeerUnverified",
);
const withTurn = new ImLanDiscovery({
  responder,
  turn: { urls: ["turn:turn.example:3478"], username: "u", credential: "p" },
});
withTurn.browse();
check(
  "T7 TURN 兜底：配置了 TURN 就走 turn 传输",
  itemAt(withTurn.discovered(), 0).transport === "turn",
  itemAt(withTurn.discovered(), 0).transport,
);

const root = await mkdtemp(join(tmpdir(), "im-cross-"));
const paths = [join(root, "a.db"), join(root, "b.db")];
const dbs = paths.map((path) => {
  const db = new DatabaseSync(path);
  migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
  return db;
});
const forwarders = dbs.map((db) => new ImWireForwarder(db, "srv-1"));
for (const [index, db] of dbs.entries()) {
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    "INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status, cert_ref, enrolled_at, revoked_at, pairing_expires_at, pairing_code) VALUES ('srv-1','me',?,?, 'active', NULL, 1, NULL, NULL, NULL)",
  ).run(`device-${index}`, createImIdentity().publicKey);
  db.exec("PRAGMA foreign_keys = ON");
}

const frame = {
  type: "forward",
  fromServerId: "srv-1",
  fromAgentId: "me",
  toServerId: "srv-1",
  toAgentId: "me",
  sealed: "sealed-payload-from-A",
  nonce: "nonce-cross-1",
  sentAt: at,
};
const sent = itemAt(forwarders, 0).forward("me", { frame, deviceIds: ["device-0"], at, expiresAt: at + 86_400_000 });
check("T7b 跨实例：A 侧入队 1 条", sent.outcomes.length === 1, "");

const received = itemAt(forwarders, 1).receive(frame);
check("T7b 跨实例：B 侧收到同一帧", received.sealed === "sealed-payload-from-A" && received.fromAgentId === "me", "");
check("T7b 跨实例：密文在传递中未被改动", received.sealed === frame.sealed, "");
check(
  "T7b 跨实例：B 侧可接受该帧",
  itemAt(forwarders, 1).accept("me", received, { kind: "message", body: "x" }).accepted === true,
  "",
);
check(
  "T7b 跨实例：两库互不串（B 的队列为空）",
  record(itemAt(dbs, 1).prepare("SELECT COUNT(*) AS n FROM offline_queue").get()).n === 0,
  "",
);
check(
  "T7b 跨实例：A 的队列有那条密文",
  record(itemAt(dbs, 0).prepare("SELECT COUNT(*) AS n FROM offline_queue").get()).n === 1,
  "",
);
check(
  "T7b 跨实例：收件人被篡改的帧在 accept 处被拒（载荷篡改由 T3 信封层验签兜住）",
  (() => {
    try {
      itemAt(forwarders, 1).accept("me", itemAt(forwarders, 1).receive({ ...frame, toAgentId: "someone-else" }), {
        kind: "message",
        body: "x",
      });
      return false;
    } catch (error) {
      return error instanceof ImWireRejected && error.reason === "im.unauthorized";
    }
  })(),
  "",
);
check(
  "T7b 跨实例：帧解码器严格（多字段拒）",
  (() => {
    try {
      decodeImWireFrame({ ...frame, extra: 1 });
      return false;
    } catch {
      return true;
    }
  })(),
  "",
);

for (const db of dbs) db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
