import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TEAM_CURRENT_CAPABILITIES } from "../packages/contracts/src/team-protocol/current";
import { imEntrySupport } from "../packages/team-client/src/im-client";
import { ImDeliveryService } from "../src/backend/im/delivery";
import { ImHostApi } from "../src/backend/im/host-api";
import { createImIdentity, imFingerprint } from "../src/backend/im/identity";
import { ImService } from "../src/backend/im/im-service";
import { ImLanDiscovery } from "../src/backend/im/lan";
import { IM_LAN_PEER_OFFLINE, ImLanOutbox, ImLanUndelivered } from "../src/backend/im/lan-outbox";
import { ImMessageStore } from "../src/backend/im/messages";
import { ImWithdrawService } from "../src/backend/im/withdraw";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { IM_HANDLED_PATHS } from "../src/main/team-api/route-im";
import { itemAt } from "./verify-im-helpers";

const REPO = resolve(import.meta.dirname, "..");

const { IM_ROUTES, IM_ROUTES_BY_CAPABILITY, imCapabilityOfRoute, IM_LAN_DISCOVERY_CAPABILITY, IM_CAPABILITIES } =
  await import(`${REPO}/packages/contracts/src/team-protocol/im-v1.ts`);

const routesByCapability = new Map<string, readonly string[]>(Object.entries(IM_ROUTES_BY_CAPABILITY));
const routesOf = (capability: string): readonly string[] => routesByCapability.get(capability) ?? [];

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = "") => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
async function rejected(name: string, run: () => Promise<unknown> | unknown, expected: string) {
  let code = "";
  try {
    await run();
  } catch (error) {
    code = error instanceof Error ? error.name : String(error);
  }
  check(name, code === expected, code || "没有报错");
}

const at = 1_700_000_000_000;
const root = await mkdtemp(join(tmpdir(), "im-r21-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1','me','th-1','srv-2','agent-peer','open',NULL)",
).run();
db.prepare(
  "INSERT INTO peers (peer_server_id, peer_agent_id, public_key, display_name, verified_at, first_seen_at, last_seen_at) VALUES ('srv-2','agent-peer','pk-peer','Peer',NULL,1,NULL)",
).run();
db.exec("PRAGMA foreign_keys = ON");

const store = new ImMessageStore(db);
const service = new ImService(db, "srv-1");
const delivered: { deliveryId: string; body: string }[] = [];
let deliverMode: "ok" | "fail" = "fail";
const outbox = new ImLanOutbox(db, "srv-1", (input) => {
  delivered.push({ deliveryId: input.deliveryId, body: input.body });
  if (deliverMode === "fail") throw new ImLanUndelivered(IM_LAN_PEER_OFFLINE);
});

function send(remoteMessageId: string, body: string) {
  return service.sendFromClient("me", {
    threadId: "th-1",
    remoteMessageId,
    body,
    attachments: [],
    replyTo: null,
    proxiedBy: null,
    proxyVisibility: null,
    at,
  });
}
const stateOf = (deliveryId: string) => store.readDelivery(deliveryId)?.state ?? "missing";

send("rm-1", "draft-body-1");
send("rm-2", "draft-body-2");

process.stdout.write(`\n== A 未送达态 ==\n`);
const firstDraft = await outbox.markUndelivered("me", { deliveryId: "dl-rm-1", at, error: IM_LAN_PEER_OFFLINE });
check("A 局域网投递失败 → 进未送达态", stateOf("dl-rm-1") === "failed", stateOf("dl-rm-1"));
check(
  "A 未送达带可读原因",
  store.readDelivery("dl-rm-1")?.error === IM_LAN_PEER_OFFLINE,
  String(store.readDelivery("dl-rm-1")?.error),
);
check(
  "A 未送达写了下次重试时间（不静默）",
  outbox.drafts("me")[0]?.nextRetryAt === at + 30_000,
  String(outbox.drafts("me")[0]?.nextRetryAt),
);
check(
  "A 对照：没失败过的那条仍在 submitted（没有被误标未送达）",
  stateOf("dl-rm-2") === "submitted",
  stateOf("dl-rm-2"),
);

check(
  "A2 陈旧返回修复：markUndelivered 返回的 nextRetryAt 不是 null",
  firstDraft?.nextRetryAt === at + 30_000,
  String(firstDraft?.nextRetryAt),
);
check(
  "A2 返回值读回自库：attempts 与库一致",
  firstDraft?.attempts === 1 && firstDraft?.attempts === store.readDelivery("dl-rm-1")?.attempts,
  `${firstDraft?.attempts}/${store.readDelivery("dl-rm-1")?.attempts}`,
);
check(
  "A2 返回值读回自库：error 与库一致",
  firstDraft?.error === store.readDelivery("dl-rm-1")?.error,
  String(firstDraft?.error),
);
check(
  "A2 返回值读回自库：正文/线程/对端齐全",
  firstDraft?.body === "draft-body-1" && firstDraft?.threadId === "th-1" && firstDraft?.peerAgentId === "agent-peer",
  JSON.stringify(firstDraft),
);
check(
  "A2 对照：没标未送达的那条返回 null（不是编一个草稿出来）",
  (await outbox.markUndelivered("me", { deliveryId: "dl-none", at })) === null,
  "",
);

process.stdout.write(`\n== B 草稿保留 ==\n`);
const drafts = () => outbox.drafts("me");
check(
  "B 未送达的留在草稿/待发队列",
  drafts().some((draft) => draft.deliveryId === "dl-rm-1"),
  JSON.stringify(drafts().map((d) => d.deliveryId)),
);
check("B 草稿里正文没丢", drafts().find((draft) => draft.deliveryId === "dl-rm-1")?.body === "draft-body-1", "");
await outbox.markUndelivered("me", { deliveryId: "dl-rm-1", at: at + 10, error: "im.notDelivered" });
check(
  "B 再失败一次仍在草稿队列（不丢）",
  drafts().some((draft) => draft.deliveryId === "dl-rm-1"),
  "",
);
check(
  "B 尝试次数累加到 2（不静默）",
  store.readDelivery("dl-rm-1")?.attempts === 2,
  String(store.readDelivery("dl-rm-1")?.attempts),
);
check(
  "B 保留最后一次失败原因",
  store.readDelivery("dl-rm-1")?.error === "im.notDelivered",
  String(store.readDelivery("dl-rm-1")?.error),
);
check(
  "B 对照：草稿队列不含没失败的那条",
  !drafts().some((draft) => draft.deliveryId === "dl-rm-2"),
  JSON.stringify(drafts().map((d) => d.deliveryId)),
);

process.stdout.write(`\n== C 上线自动重发 ==\n`);
deliverMode = "ok";
const resent = await outbox.onPeerOnline({ peerServerId: "srv-2", peerAgentId: "agent-peer", at: at + 20 });
check(
  "C 对端上线自动重发：发出投递",
  delivered.length === 1 && itemAt(delivered, 0).deliveryId === "dl-rm-1",
  JSON.stringify(delivered),
);
check(
  "C 重发结果报 delivered",
  resent.length === 1 && itemAt(resent, 0).outcome === "delivered",
  JSON.stringify(resent),
);
check("C 状态机推进到 persisted", stateOf("dl-rm-1") === "persisted", stateOf("dl-rm-1"));
check("C 重发后草稿队列清空", drafts().length === 0, JSON.stringify(drafts()));
check(
  "C 重发也计入尝试次数",
  store.readDelivery("dl-rm-1")?.attempts === 3,
  String(store.readDelivery("dl-rm-1")?.attempts),
);

process.stdout.write(`\n== C2 上线自动重发（真触发） ==\n`);
send("rm-7", "draft-body-7");
await outbox.markUndelivered("me", { deliveryId: "dl-rm-7", at: at + 80 });
check(
  "C2 前置：rm-7 在草稿队列",
  drafts().some((draft) => draft.deliveryId === "dl-rm-7"),
  "",
);
const responder = {
  announce: () => {},
  browse: (onPeer: (peer: { host: string; port: number; txt: Record<string, string> }) => void) => {
    onPeer({
      host: "127.0.0.1",
      port: 47831,
      txt: { peerServerId: "srv-2", peerAgentId: "agent-peer", publicKey: "pk-peer" },
    });
  },
  stop: () => {},
};
const host = new ImHostApi(db, "srv-1", {}, null, {
  responder,
  deliver: (input: { deliveryId: string; body: string }) => {
    delivered.push({ deliveryId: input.deliveryId, body: input.body });
  },
});
host.lanBrowse();
for (let round = 0; round < 40 && !delivered.some((entry) => entry.deliveryId === "dl-rm-7"); round += 1)
  await new Promise((done) => setTimeout(done, 5));
await new Promise((done) => setTimeout(done, 20));
check(
  "C2 对端上线后自动重发（没有手调）",
  delivered.some((entry) => entry.deliveryId === "dl-rm-7"),
  JSON.stringify(delivered),
);
check("C2 自动重发把状态推到 persisted", stateOf("dl-rm-7") === "persisted", stateOf("dl-rm-7"));
const beforeRepeat = delivered.length;
host.lanBrowse();
await new Promise((done) => setTimeout(done, 20));
check("C2 对照：重复 announce 不重复投递", delivered.length === beforeRepeat, String(delivered.length));

process.stdout.write(`\n== D 对照：不重发 ==\n`);
const deliveredBefore = delivered.length;
const again = await outbox.onPeerOnline({ peerServerId: "srv-2", peerAgentId: "agent-peer", at: at + 30 });
check("D 对照：已送达的不重发（没再投递）", delivered.length === deliveredBefore, JSON.stringify(delivered));
check("D 对照：已送达的不在重发结果里", again.length === 0, JSON.stringify(again));
check(
  "D 对照：已送达的状态与次数都不动",
  stateOf("dl-rm-1") === "persisted" && store.readDelivery("dl-rm-1")?.attempts === 3,
  `${stateOf("dl-rm-1")}/${store.readDelivery("dl-rm-1")?.attempts}`,
);
const skipDelivered = await outbox.resend("me", { deliveryId: "dl-rm-1", at: at + 31 });
check(
  "D 对照：手动重发已送达的 → 跳过且不投递",
  skipDelivered.outcome === "skipped-delivered" && delivered.length === deliveredBefore,
  skipDelivered.outcome,
);
await rejected(
  "D 对照：已送达的不能被标回未送达（状态机不可逆）",
  () => outbox.markUndelivered("me", { deliveryId: "dl-rm-1", at: at + 32 }),
  "ImDeliveryDelivered",
);
check(
  "D 非 A 对照：还没送达的可以标未送达",
  stateOf("dl-rm-2") === "submitted" &&
    (await outbox.markUndelivered("me", { deliveryId: "dl-rm-2", at: at + 33 }))?.attempts === 1,
  stateOf("dl-rm-2"),
);

process.stdout.write(`\n== D2 对照：已撤回的不重发 ==\n`);
const withdrawn = send("rm-3", "draft-body-3");
await outbox.markUndelivered("me", { deliveryId: "dl-rm-3", at: at + 40, error: IM_LAN_PEER_OFFLINE });
check(
  "D2 前置：rm-3 在草稿队列",
  drafts().some((draft) => draft.deliveryId === "dl-rm-3"),
  "",
);
const withdraw = new ImWithdrawService(db, "srv-1");
const result = withdraw.withdraw("me", { threadId: "th-1", localMessageId: withdrawn.localMessageId, at: at + 41 });
check("D2 撤回未送达的消息 → 场景是 lan-undelivered", result.scene === "lan-undelivered", result.scene);
check(
  "D2 撤回把草稿一起退掉",
  result.queueRemoved === true && !drafts().some((draft) => draft.deliveryId === "dl-rm-3"),
  JSON.stringify(drafts()),
);
check("D2 撤回不谎称通知了收件人", result.notifiedRecipient === false, String(result.notifiedRecipient));
const afterWithdraw = await outbox.onPeerOnline({ peerServerId: "srv-2", peerAgentId: "agent-peer", at: at + 42 });
check(
  "D2 对照：已撤回的不重发（没有它的投递记录）",
  !delivered.some((entry) => entry.deliveryId === "dl-rm-3"),
  JSON.stringify(delivered),
);
const skipWithdrawn = await outbox.resend("me", { deliveryId: "dl-rm-3", at: at + 43 });
check(
  "D2 对照：手动重发已撤回的 → 跳过且不投递",
  skipWithdrawn.outcome === "skipped-withdrawn" && !delivered.some((entry) => entry.deliveryId === "dl-rm-3"),
  skipWithdrawn.outcome,
);
check(
  "D2 对照：重发结果里没有已撤回那条",
  !afterWithdraw.some((entry) => entry.deliveryId === "dl-rm-3"),
  JSON.stringify(afterWithdraw),
);

process.stdout.write(`\n== E 状态机守卫 ==\n`);
send("rm-4", "draft-body-4");
store.setDeliveryState("dl-rm-4", "persisted", at + 50);
store.setDeliveryState("dl-rm-4", "acked", at + 51);
store.setDeliveryState("dl-rm-4", "read", at + 52);
store.setDeliveryState("dl-rm-4", "acked", at + 53);
check("E 对照：已 read 的不能被降级回 acked", stateOf("dl-rm-4") === "read", stateOf("dl-rm-4"));
check(
  "E 对照：persisted 之后不会被打回 submitted",
  (() => {
    store.setDeliveryState("dl-rm-4", "submitted", at + 54);
    return stateOf("dl-rm-4") === "read";
  })(),
  stateOf("dl-rm-4"),
);
check(
  "E 对照：已送达的 markUndelivered 不写库",
  store.markUndelivered("dl-rm-4", { error: "im.peerOffline", nextRetryAt: null }) === false &&
    stateOf("dl-rm-4") === "read",
  stateOf("dl-rm-4"),
);
send("rm-6", "draft-body-6");
await outbox.markUndelivered("me", { deliveryId: "dl-rm-6", at: at + 55 });
check("E 非 A 对照：还没送达的可以标未送达", stateOf("dl-rm-6") === "failed", stateOf("dl-rm-6"));
store.setDeliveryState("dl-rm-6", "submitted", at + 56);
check("E 非 A 对照：failed → submitted 允许（重发要能推进）", stateOf("dl-rm-6") === "submitted", stateOf("dl-rm-6"));
const deliveredResend = new ImDeliveryService(db, "srv-1");
let resendCode = "";
try {
  deliveredResend.resend("me", { deliveryId: "dl-rm-4", at: at + 57 });
} catch (error) {
  resendCode = error instanceof Error ? error.name : String(error);
}
check("E 对照：投递层重发也拒绝已送达的", resendCode === "ImNotResendable", resendCode || "没有报错");
check(
  "E 非 A 对照：投递层重发允许未送达的",
  deliveredResend.resend("me", { deliveryId: "dl-rm-6", at: at + 58 }).state === "submitted",
  stateOf("dl-rm-6"),
);
process.stdout.write(`\n== F 撤回场景口径 ==\n`);
const delivered2 = send("rm-5", "draft-body-5");
store.setDeliveryState("dl-rm-5", "persisted", at + 60);
const scene2 = withdraw.withdraw("me", { threadId: "th-1", localMessageId: delivered2.localMessageId, at: at + 61 });
check("F 对照：撤回已送达的 → 场景是 online（不是 lan-undelivered）", scene2.scene === "online", scene2.scene);

process.stdout.write(`\n== G lanPeers route ==\n`);
check("G lanPeers 在路由表里", IM_HANDLED_PATHS.has(IM_ROUTES.lanPeers), IM_ROUTES.lanPeers);
check(
  "G lanPeers 归属 im-lan-discovery-v1",
  imCapabilityOfRoute(IM_ROUTES.lanPeers) === IM_LAN_DISCOVERY_CAPABILITY,
  String(imCapabilityOfRoute(IM_ROUTES.lanPeers)),
);

process.stdout.write(`\n== G2 发现与信任分离 ==\n`);
const keyT1 = createImIdentity();
const keyT2 = createImIdentity();
const echo = {
  entry: {
    host: "127.0.0.1",
    port: 47831,
    txt: { peerServerId: "srv-7", peerAgentId: "agent-t", publicKey: keyT1.publicKey },
  },
};
const echoResponder = {
  announce: () => {},
  browse: (onPeer: (peer: { host: string; port: number; txt: Record<string, string> }) => void) => {
    onPeer(echo.entry);
  },
  stop: () => {},
};
const trustLan = new ImLanDiscovery({ responder: echoResponder, turn: null });
trustLan.browse();
const verifiedPeer = trustLan.verify({ peerServerId: "srv-7", peerAgentId: "agent-t" }, imFingerprint(keyT1.publicKey));
check("G2 核对后 trusted=true", verifiedPeer.trusted === true, "");
trustLan.browse();
check(
  "G2 对照：同一公钥重复 announce 不清掉已核对的信任",
  trustLan.connect({ peerServerId: "srv-7", peerAgentId: "agent-t" }).trusted === true,
  String(itemAt(trustLan.discovered(), 0).trusted),
);
echo.entry = {
  host: "127.0.0.1",
  port: 47831,
  txt: { peerServerId: "srv-7", peerAgentId: "agent-t", publicKey: keyT2.publicKey },
};
trustLan.browse();
check(
  "G2 对照：换公钥必须清信任（指纹变了）",
  itemAt(trustLan.discovered(), 0).trusted === false &&
    itemAt(trustLan.discovered(), 0).fingerprint === imFingerprint(keyT2.publicKey),
  JSON.stringify({
    trusted: itemAt(trustLan.discovered(), 0).trusted,
    fingerprint: itemAt(trustLan.discovered(), 0).fingerprint,
  }),
);

process.stdout.write(`\n== H 能力注册口径 ==\n`);
const registered = TEAM_CURRENT_CAPABILITIES.filter((capability) =>
  IM_CAPABILITIES.some((item: string) => item === capability),
);
check("H im-lan-discovery-v1 已注册", registered.includes(IM_LAN_DISCOVERY_CAPABILITY), `${registered.length} 条`);
check(
  "H 已注册的每条 route 都实现了",
  registered.every((capability) => routesOf(capability).every((route) => IM_HANDLED_PATHS.has(route))),
  "",
);
const gates = imEntrySupport([...registered, "agent-tasks-v1", "agent-threads-v1"]);
check(
  "H 注册后七段入口全开（用户可见变化，changelog 已写）",
  Object.values(gates).every((value) => value === true),
  JSON.stringify(gates),
);

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) {
  for (const entry of failed) process.stdout.write(`FAIL  ${entry.name}\n`);
  process.exitCode = 1;
}
await rm(root, { recursive: true, force: true });
