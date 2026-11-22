import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createImIdentity, imFingerprint } from "../src/backend/im/identity";
import { ImFingerprintMismatch, ImService } from "../src/backend/im/im-service";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { itemAt, record, text } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-verified-at-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
const key = createImIdentity();
const rotated = createImIdentity();
const peer = { peerServerId: "srv-2", peerAgentId: "agent-peer" };

db.prepare(
  "INSERT INTO peers (peer_server_id, peer_agent_id, public_key, display_name, verified_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'Mira', NULL, 1, 1)",
).run(peer.peerServerId, peer.peerAgentId, key.publicKey);
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1', 'me', 'th-1', 'srv-2', 'agent-peer', 'open', NULL)",
).run();
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1', 'other', 'th-2', 'srv-2', 'agent-peer', 'open', NULL)",
).run();
db.exec("PRAGMA foreign_keys = ON");

const im = new ImService(db, "srv-1");
const at = 1_700_000_000_000;

check(
  "初始未验证：verified=false 且 verified_at 为空",
  itemAt(im.listPeers("me", {}).items, 0).verified === false && im.peerVerifiedAt("me", peer) === null,
  String(im.peerVerifiedAt("me", peer)),
);

const fingerprint = imFingerprint(key.publicKey);
const verified = im.verifyPeer("me", { ...peer, fingerprint }, at);
check("verifyPeer 转 verified", verified.verified === true, "");
check(
  "verified_at 落「指纹核对通过」的时间",
  im.peerVerifiedAt("me", peer) === at,
  String(im.peerVerifiedAt("me", peer)),
);
check("读回的 ImPeer.verified 与 verified_at 一致", itemAt(im.listPeers("me", {}).items, 0).verified === true, "");

let mismatch = "";
try {
  im.verifyPeer("me", { ...peer, fingerprint: "AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH" }, at + 1);
} catch (error) {
  mismatch = error instanceof ImFingerprintMismatch ? "ImFingerprintMismatch" : String(error);
}
check(
  "指纹不符不落 verified_at",
  mismatch === "ImFingerprintMismatch" && im.peerVerifiedAt("me", peer) === at,
  mismatch,
);

const rotatedPeer = im.recordPeerKey("me", { ...peer, publicKey: rotated.publicKey, at: at + 2 });
check("改指纹：指纹更新", rotatedPeer.fingerprint === imFingerprint(rotated.publicKey), "");
check("改指纹：verified_at 被清掉", im.peerVerifiedAt("me", peer) === null, String(im.peerVerifiedAt("me", peer)));
check("改指纹：verified 跟着变 false", itemAt(im.listPeers("me", {}).items, 0).verified === false, "");

im.verifyPeer("me", { ...peer, fingerprint: imFingerprint(rotated.publicKey) }, at + 3);
check(
  "重新核对通过后 verified_at 落新时间",
  im.peerVerifiedAt("me", peer) === at + 3,
  String(im.peerVerifiedAt("me", peer)),
);

const revoked = im.revokePeerVerification("me", peer);
check("撤销：返回真", revoked === true, "");
check("撤销：verified_at 清空", im.peerVerifiedAt("me", peer) === null, String(im.peerVerifiedAt("me", peer)));
check("撤销：verified 变 false", itemAt(im.listPeers("me", {}).items, 0).verified === false, "");

const unchanged = im.recordPeerKey("me", { ...peer, publicKey: rotated.publicKey, at: at + 4 });
check(
  "对照组：同指纹刷新不误清（未验证仍 null）",
  unchanged.verified === false && im.peerVerifiedAt("me", peer) === null,
  "",
);

im.verifyPeer("me", { ...peer, fingerprint: imFingerprint(rotated.publicKey) }, at + 5);
const same = im.recordPeerKey("me", { ...peer, publicKey: rotated.publicKey, at: at + 6 });
check(
  "对照组：同指纹刷新保留 verified_at",
  same.verified === true && im.peerVerifiedAt("me", peer) === at + 5,
  String(im.peerVerifiedAt("me", peer)),
);

function threw(name: string, run: () => unknown, expected: string): void {
  let code = "";
  try {
    run();
  } catch (error) {
    code = error instanceof Error ? error.name : String(error);
  }
  check(name, code === expected, code || "没有报错");
}
const mineOnly = { peerServerId: "srv-7", peerAgentId: "agent-mine" };
db.exec("PRAGMA foreign_keys = OFF");
db.prepare(
  "INSERT INTO peers (peer_server_id, peer_agent_id, public_key, display_name, verified_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'Mine', NULL, 1, 1)",
).run(mineOnly.peerServerId, mineOnly.peerAgentId, createImIdentity().publicKey);
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1', 'me', 'th-mine', 'srv-7', 'agent-mine', 'open', NULL)",
).run();
db.exec("PRAGMA foreign_keys = ON");
im.verifyPeer(
  "me",
  {
    ...mineOnly,
    fingerprint: imFingerprint(
      text(record(record(db.prepare("SELECT public_key FROM peers WHERE peer_server_id = 'srv-7'").get())).public_key),
    ),
  },
  at + 7,
);
threw("作用域隔离：看不见的对端读不到 verified_at", () => im.peerVerifiedAt("other", mineOnly), "ImPeerUnknown");
threw("作用域隔离：看不见的对端不能撤销", () => im.revokePeerVerification("other", mineOnly), "ImPeerUnknown");
check(
  "对照组：可见对端的 verified_at 两边一致（peers 目录是服务器共享）",
  im.peerVerifiedAt("other", peer) === im.peerVerifiedAt("me", peer),
  String(im.peerVerifiedAt("other", peer)),
);
threw("未知对端拒", () => im.peerVerifiedAt("me", { peerServerId: "srv-9", peerAgentId: "x" }), "ImPeerUnknown");

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");

db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
