import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IM_ROUTES, imCapabilityOfRoute } from "../packages/contracts/src/team-protocol/im-v1";
import { createImIdentity, imFingerprint } from "../src/backend/im/identity";
import { ImFingerprintMismatch, ImMessageMissing, ImPeerUnknown, ImService } from "../src/backend/im/im-service";
import { ImDuplicateMessage } from "../src/backend/im/messages";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { itemAt, record } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-t18a1-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");

const memberA = "member-a";
const memberB = "member-b";
const peerKey = createImIdentity();
const peer = { peerServerId: "srv-2", peerAgentId: "agent-peer" };
const peerB = { peerServerId: "srv-3", peerAgentId: "agent-other" };

db.prepare(
  "INSERT INTO peers (peer_server_id, peer_agent_id, public_key, display_name, verified_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, NULL, 1, 1)",
).run(peer.peerServerId, peer.peerAgentId, peerKey.publicKey, "Mira");
db.prepare(
  "INSERT INTO peers (peer_server_id, peer_agent_id, public_key, display_name, verified_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, NULL, 1, 1)",
).run(peerB.peerServerId, peerB.peerAgentId, createImIdentity().publicKey, "Other");
const threadSeeds: { member: string; threadId: string; ref: { peerServerId: string; peerAgentId: string } }[] = [
  { member: memberA, threadId: "th-a", ref: peer },
  { member: memberB, threadId: "th-b", ref: peerB },
];
for (const seed of threadSeeds) {
  db.prepare(
    "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1', ?, ?, ?, ?, 'open', NULL)",
  ).run(seed.member, seed.threadId, seed.ref.peerServerId, seed.ref.peerAgentId);
}
db.exec("PRAGMA foreign_keys = ON");

const im = new ImService(db, "srv-1");

const sent = im.sendFromClient(memberA, {
  threadId: "th-a",
  remoteMessageId: "rm-1",
  body: "hello",
  attachments: [],
  replyTo: null,
  proxiedBy: null,
  proxyVisibility: null,
});
check("T18a1 message:send 落库可读", sent.localMessageId !== "" && sent.body === "hello", sent.localMessageId);
check("T18a1 message:send 带投递记录", record(db.prepare("SELECT COUNT(*) AS n FROM im_deliveries").get()).n === 1, "");
check("T18a1 message:send 默认未验真（签名由 T3 信封层补）", sent.verified === false, String(sent.verified));

const listed = im.listMessages(memberA, { threadId: "th-a" });
check(
  "T18a1 message:list 读回",
  listed.items.length === 1 && itemAt(listed.items, 0).localMessageId === sent.localMessageId,
  String(listed.items.length),
);

check("跨成员隔离：B 看不到 A 的会话消息", im.listMessages(memberB, { threadId: "th-a" }).items.length === 0, "");
check("跨成员隔离：B 用自己的线程也看不到", im.listMessages(memberB, { threadId: "th-b" }).items.length === 0, "");

let duplicate = "";
try {
  im.sendFromClient(memberA, {
    threadId: "th-a",
    remoteMessageId: "rm-1",
    body: "again",
    attachments: [],
    replyTo: null,
    proxiedBy: null,
    proxyVisibility: null,
  });
} catch (error) {
  duplicate = error instanceof ImDuplicateMessage ? "ImDuplicateMessage" : String(error);
}
check("message:send 重复 remoteMessageId 被拒", duplicate === "ImDuplicateMessage", duplicate);

const peersA = im.listPeers(memberA, {});
const peersB = im.listPeers(memberB, {});
check(
  "peers:list 只返回本成员的对端",
  peersA.items.length === 1 && itemAt(peersA.items, 0).peerAgentId === "agent-peer",
  peersA.items.map((p) => p.peerAgentId).join(","),
);
check(
  "跨成员隔离：B 的对端列表不同",
  peersB.items.length === 1 && itemAt(peersB.items, 0).peerAgentId === "agent-other",
  "",
);

const fingerprint = imFingerprint(peerKey.publicKey);
const verified = im.verifyPeer(memberA, { ...peer, fingerprint });
check("peers:verify 指纹一致转 verified", verified.verified === true && verified.fingerprint === fingerprint, "");

let mismatch = "";
try {
  im.verifyPeer(memberA, { ...peer, fingerprint: "AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH" });
} catch (error) {
  mismatch = error instanceof ImFingerprintMismatch ? "ImFingerprintMismatch" : String(error);
}
check("peers:verify 指纹不符拒（im.confirmMismatch）", mismatch === "ImFingerprintMismatch", mismatch);

let crossMember = "";
try {
  im.verifyPeer(memberB, { ...peer, fingerprint });
} catch (error) {
  crossMember = error instanceof ImPeerUnknown ? "ImPeerUnknown" : String(error);
}
check("跨成员隔离：B 不能验 A 的对端", crossMember === "ImPeerUnknown", crossMember);

let missingPeer = "";
try {
  im.verifyPeer(memberA, { peerServerId: "srv-9", peerAgentId: "agent-x", fingerprint });
} catch (error) {
  missingPeer = error instanceof ImPeerUnknown ? "ImPeerUnknown" : String(error);
}
check("peers:verify 未知对端拒", missingPeer === "ImPeerUnknown", missingPeer);

im.withdrawMessage(memberA, { threadId: "th-a", localMessageId: sent.localMessageId });
const withdrawn = record(itemAt(im.listMessages(memberA, { threadId: "th-a" }).items, 0));
check("message:withdraw 落撤回时间", withdrawn.withdrawnAt !== null, String(withdrawn.withdrawnAt));

let wrongThread = "";
try {
  im.withdrawMessage(memberA, { threadId: "th-b", localMessageId: sent.localMessageId });
} catch (error) {
  wrongThread = error instanceof ImMessageMissing ? "ImMessageMissing" : String(error);
}
check("message:withdraw 跨线程/跨成员拒", wrongThread === "ImMessageMissing", wrongThread);

check("路由→能力映射：peersList 属 im-peers-v1", imCapabilityOfRoute(IM_ROUTES.peersList) === "im-peers-v1", "");
check(
  "路由→能力映射：messageSend 属 im-messages-v1",
  imCapabilityOfRoute(IM_ROUTES.messageSend) === "im-messages-v1",
  "",
);
check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");

db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
