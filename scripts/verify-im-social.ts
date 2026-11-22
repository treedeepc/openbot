import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as social from "../src/backend/im/social";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-social-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });

const me = { localServerId: "srv-1", localMemberId: "me" };
const peer = { peerServerId: "srv-2", peerAgentId: "agent-peer" };
const other = { peerServerId: "srv-3", peerAgentId: "agent-other" };
const now = 1_700_000_000_000;

const contacts = new social.ImContactStore(db);
const requests = new social.ImContactRequestStore(db);
const blocks = new social.ImBlockStore(db);
const reports = new social.ImReportStore(db);
const limiter = new social.ImRateLimiter(db);

const contact = contacts.request({ ...me, contactId: "c-1", peer, alias: "Mira", source: "im", at: now });
check("A7 联系人：请求后 pending", contact.state === "pending", contact.state);
check("A7 联系人：可读回", contacts.find(me, peer)?.alias === "Mira", "");
contacts.accept({ ...me, peer, at: now + 1 });
check("A7 联系人：接受后 accepted", contacts.find(me, peer)?.state === "accepted", "");
let duplicate = "";
try {
  contacts.request({ ...me, contactId: "c-2", peer, at: now + 2 });
} catch (error) {
  duplicate = error instanceof Error ? error.name : "";
}
check("A7 联系人：重复请求被拒（im.contactExists）", duplicate === "ImDuplicateContact", duplicate);
check("A7 联系人：列表", contacts.list(me).length === 1, "");
check("A7 联系人：作用域隔离", contacts.list({ localServerId: "srv-1", localMemberId: "other" }).length === 0, "");

const inbound = requests.create({ ...me, requestId: "r-1", direction: "inbound", peer, message: "hi", at: now + 3 });
check("A7 联系人请求：入站未处理", inbound.resolvedAt === null, "");
requests.resolve({ ...me, requestId: "r-1", at: now + 4 });
check(
  "A7 联系人请求：处理后有 resolved_at",
  requests.list({ ...me, direction: "inbound" })[0]?.resolvedAt === now + 4,
  "",
);
requests.create({ ...me, requestId: "r-2", direction: "outbound", peer: other, at: now + 5 });
check("A7 联系人请求：出站与入站分开", requests.list({ ...me, direction: "outbound" }).length === 1, "");

const rule = blocks.add({ ...me, ruleId: "b-1", peer, reason: "spam", at: now + 6 });
check("A7 拉黑：规则落库", blocks.isBlocked(me, peer) === true, "");
check("A7 拉黑：未拉黑的对端照常", blocks.isBlocked(me, other) === false, "");
check("A7 拉黑：作用域隔离", blocks.isBlocked({ localServerId: "srv-1", localMemberId: "other" }, peer) === false, "");
blocks.remove({ ...me, peer });
check("A7 拉黑：解除后不再拦", blocks.isBlocked(me, peer) === false, "");
blocks.add({ ...me, ruleId: rule.ruleId, peer, reason: "spam", at: now + 7 });
check("A7 拉黑：重新拉黑覆盖旧规则", blocks.list(me).length === 1, String(blocks.list(me).length));

const report = reports.create({
  ...me,
  reportId: "rp-1",
  targetPeer: "srv-2/agent-peer",
  category: "spam",
  detail: "ads",
  at: now + 8,
});
check("A7 举报：新建 open", report.status === "open", report.status);
reports.resolve({ ...me, reportId: "rp-1", status: "actioned", at: now + 9 });
check("A7 举报：处理后 actioned", reports.list(me)[0]?.status === "actioned", "");
check("A7 举报：保留分类", reports.list(me)[0]?.category === "spam", "");

const open: social.ImRateDecision = { allowed: true, reason: "ok", retryAfterMs: 0, used: 0 };
const outBlocked = social.imSendDecision({ outboundBlocked: true, inboundBlocked: false, rate: open });
check(
  "双层拉黑·外层：我拉黑对方→伪成功",
  outBlocked.pseudoSuccess && outBlocked.outcome === "blocked-discarded",
  JSON.stringify(outBlocked),
);
check("双层拉黑·外层：无失败/无重发/无通知", outBlocked.notify === false && outBlocked.retry === false, "");
const inBlocked = social.imSendDecision({ outboundBlocked: false, inboundBlocked: true, rate: open });
check(
  "双层拉黑·内层：对方拉黑我→伪成功",
  inBlocked.pseudoSuccess && inBlocked.outcome === "blocked-discarded",
  JSON.stringify(inBlocked),
);
check("双层拉黑·内层：无失败/无重发/无通知", inBlocked.notify === false && inBlocked.retry === false, "");
const both = social.imSendDecision({ outboundBlocked: true, inboundBlocked: true, rate: open });
check("双层拉黑：两层都拦仍是伪成功", both.pseudoSuccess && both.notify === false && both.retry === false, "");
const normal = social.imSendDecision({ outboundBlocked: false, inboundBlocked: false, rate: open });
check(
  "对照组：没被拉黑正常发送",
  normal.outcome === "sent" && normal.pseudoSuccess === false && normal.notify === true,
  "",
);

const policy = social.IM_RATE_LIMITS.message;
for (let index = 0; index < policy.max; index += 1) {
  const at = now + 1000 + index;
  const decision = limiter.peek({
    ...me,
    actorId: "agent-peer",
    action: "im.message",
    targetId: "thread-1",
    at,
    policy,
  });
  if (!decision.allowed) check("A10 限速：窗口内额度未提前用完", false, `第 ${index} 次就被拦`);
  limiter.record({ ...me, actorId: "agent-peer", action: "im.message", targetId: "thread-1", at, policy });
}
const over = limiter.peek({
  ...me,
  actorId: "agent-peer",
  action: "im.message",
  targetId: "thread-1",
  at: now + 1000 + policy.max,
  policy,
});
check("A10 限速：超过额度被拦", over.allowed === false && over.reason === "rate-limited", JSON.stringify(over));
const limited = social.imSendDecision({ outboundBlocked: false, inboundBlocked: false, rate: over });
check(
  "A10 限速：伪成功（无失败/重发/通知）",
  limited.pseudoSuccess && limited.outcome === "rate-limited-discarded" && !limited.notify && !limited.retry,
  JSON.stringify(limited),
);
const otherActor = limiter.peek({
  ...me,
  actorId: "agent-other",
  action: "im.message",
  targetId: "thread-1",
  at: now + 1000 + policy.max,
  policy,
});
check("A10 限速：按发送方分开计数", otherActor.allowed === true, "");
const nextWindow = limiter.peek({
  ...me,
  actorId: "agent-peer",
  action: "im.message",
  targetId: "thread-1",
  at: now + 1000 + policy.windowMs + 1,
  policy,
});
check("A10 限速：下一窗口恢复", nextWindow.allowed === true, "");

const coolPolicy = social.IM_RATE_LIMITS.contactRequest;
const first = limiter.peek({
  ...me,
  actorId: "agent-peer",
  action: "im.contactRequest",
  targetId: "srv-2/agent-peer",
  at: now + 2000,
  policy: coolPolicy,
});
limiter.record({
  ...me,
  actorId: "agent-peer",
  action: "im.contactRequest",
  targetId: "srv-2/agent-peer",
  at: now + 2000,
  policy: coolPolicy,
});
const cooling = limiter.peek({
  ...me,
  actorId: "agent-peer",
  action: "im.contactRequest",
  targetId: "srv-2/agent-peer",
  at: now + 2500,
  policy: coolPolicy,
});
check(
  "A10 冷却：冷却期内被拦",
  first.allowed === true && cooling.allowed === false && cooling.reason === "cooldown",
  JSON.stringify(cooling),
);
const cooled = social.imSendDecision({ outboundBlocked: false, inboundBlocked: false, rate: cooling });
check("A10 冷却：伪成功（无失败/重发/通知）", cooled.pseudoSuccess && !cooled.notify && !cooled.retry, "");
const afterCooldown = limiter.peek({
  ...me,
  actorId: "agent-peer",
  action: "im.contactRequest",
  targetId: "srv-2/agent-peer",
  at: now + 2000 + coolPolicy.cooldownMs + 1,
  policy: coolPolicy,
});
check("A10 冷却：冷却结束恢复", afterCooldown.allowed === true, "");

const gate = new social.ImSendGate(db);
const meAsPeer = { peerServerId: "srv-1", peerAgentId: "me" };
const them = { localServerId: "srv-2", localMemberId: "agent-peer" };
const toPeer = {
  senderScope: me,
  sender: meAsPeer,
  recipientScope: them,
  recipient: peer,
  action: "im.message",
  targetId: "th-1",
  at: now + 9000,
  policy: social.IM_RATE_LIMITS.message,
};
check("合成入口：我拉黑对方→一次判定即伪成功", gate.decide(toPeer).pseudoSuccess === true, "");
blocks.remove({ ...me, peer });
check("合成入口：解除后恢复正常发送", gate.decide({ ...toPeer, at: now + 9001 }).outcome === "sent", "");
blocks.add({ ...them, ruleId: "b-them", peer: meAsPeer, reason: "muted", at: now + 9002 });
const inner = gate.decide({ ...toPeer, at: now + 9003 });
check(
  "合成入口：对方拉黑我→伪成功且对方无通知",
  inner.pseudoSuccess && inner.notify === false && inner.retry === false,
  JSON.stringify(inner),
);
check("合成入口：伪成功不是失败态", inner.outcome === "blocked-discarded" && inner.retry === false, inner.outcome);
blocks.remove({ ...them, peer: meAsPeer });
check("对照组：对方解除拉黑后恢复", gate.decide({ ...toPeer, at: now + 9004 }).outcome === "sent", "");

const ratePolicy = social.IM_RATE_LIMITS.message;
const rateInput = {
  senderScope: me,
  sender: meAsPeer,
  recipientScope: them,
  recipient: peer,
  action: "im.message",
  at: now + 20_000,
  policy: ratePolicy,
};
const key = gate.rateKey(rateInput);
check(
  "口径：targetId 是对端身份而非消息/线程 ID",
  key.targetId === "srv-2/agent-peer" && key.actorId === "srv-1/me",
  JSON.stringify(key),
);
for (let index = 0; index < 3; index += 1) gate.recordSent({ ...rateInput, at: now + 20_000 + index });
const afterThree = gate.peekRate({ ...rateInput, at: now + 20_001 });
check("口径：换消息（换目标 ID）不重置额度", afterThree.used === 3, String(afterThree.used));
gate.recordSent({ ...rateInput, at: now + 20_100 });
check("口径：同一对端累计计数", gate.peekRate({ ...rateInput, at: now + 20_101 }).used === 4, "");
check("口径：换对端才另起额度", gate.peekRate({ ...rateInput, recipient: other, at: now + 20_102 }).used === 0, "");

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");

db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
