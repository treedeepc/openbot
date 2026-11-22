import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as gate from "../src/backend/im/causal-chain";
import { ImMessagingDriver, ImToolRefused } from "../src/backend/im/messaging-driver";
import { IM_PROXY_BUDGET_USD, ImPrimaryChain, ImProxyBudgetExceeded } from "../src/backend/im/proxy";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { record } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-driver-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1', 'me', 'th-1', 'srv-2', 'agent-peer', 'open', NULL)",
).run();
db.exec("PRAGMA foreign_keys = ON");

const driver = new ImMessagingDriver(db, "srv-1");
const peer = { peerServerId: "srv-2", peerAgentId: "agent-peer" };
const at = 1_700_000_000_000;

const sent = driver.send("me", { threadId: "th-1", peer, body: "hello", sentAt: at, expiresAt: at + 86_400_000 });
check(
  "发信链路：消息落库",
  sent.message.body === "hello" && sent.message.threadId === "th-1",
  sent.message.localMessageId,
);
check(
  "发信链路：投递记录已建",
  sent.deliveryId !== "" && driver.advance(sent.deliveryId, "persisted", at + 1) === undefined,
  "",
);
const row = record(db.prepare("SELECT state FROM im_deliveries WHERE delivery_id = ?").get(sent.deliveryId));
check("发信链路：状态机推进 persisted", String(row?.state) === "persisted", String(row?.state));
driver.advance(sent.deliveryId, "acked", at + 2);
check(
  "发信链路：状态机推进 acked",
  String(db.prepare("SELECT state FROM im_deliveries WHERE delivery_id = ?").get(sent.deliveryId)?.state) === "acked",
  "",
);
driver.advance(sent.deliveryId, "persisted", at + 3);
check(
  "对照组：状态机不倒退",
  String(db.prepare("SELECT state FROM im_deliveries WHERE delivery_id = ?").get(sent.deliveryId)?.state) === "acked",
  "",
);

const proxied = driver.sendProxied("me", {
  threadId: "th-1",
  peer,
  body: "on behalf of the assistant",
  proxiedBy: "agent-assist",
  proxyVisibility: "shown",
  usdCents: 250,
  sentAt: at + 10,
  expiresAt: at + 86_400_000,
});
check(
  "A6a 代聊：proxiedBy 落库",
  String(
    db.prepare("SELECT proxied_by FROM im_messages WHERE local_message_id = ?").get(proxied.message.localMessageId)
      ?.proxied_by,
  ) === "agent-assist",
  "",
);
check(
  "A6a 代聊：proxyVisibility 落库",
  String(
    db
      .prepare("SELECT proxy_visibility FROM im_messages WHERE local_message_id = ?")
      .get(proxied.message.localMessageId)?.proxy_visibility,
  ) === "shown",
  "",
);
check(
  "A6b 预算：2.5 美元记账",
  driver.proxy.budget(driver.scope("me"), "srv-2/agent-peer", at + 10).spentUsd === 2.5,
  String(driver.proxy.budget(driver.scope("me"), "srv-2/agent-peer", at + 10).spentUsd),
);

driver.sendProxied("me", {
  threadId: "th-1",
  peer,
  body: "rest of budget",
  proxiedBy: "agent-assist",
  proxyVisibility: "hidden",
  usdCents: (IM_PROXY_BUDGET_USD - 2.5) * 100,
  sentAt: at + 11,
  expiresAt: at + 86_400_000,
});
check(
  "A6b 预算：花满 20 美元",
  driver.proxy.budget(driver.scope("me"), "srv-2/agent-peer", at + 11).remainingUsd === 0,
  "",
);

let overBudget = "";
try {
  driver.sendProxied("me", {
    threadId: "th-1",
    peer,
    body: "over budget",
    proxiedBy: "agent-assist",
    proxyVisibility: "shown",
    usdCents: 1,
    sentAt: at + 12,
    expiresAt: at + 86_400_000,
  });
} catch (error) {
  overBudget = error instanceof ImProxyBudgetExceeded ? "ImProxyBudgetExceeded" : String(error);
}
check("A6b 预算：超支拒发（im.budgetExceeded）", overBudget === "ImProxyBudgetExceeded", overBudget);
check(
  "A6b 预算：超支那条没落库",
  record(db.prepare("SELECT COUNT(*) AS n FROM im_messages WHERE body = 'over budget'").get()).n === 0,
  "",
);

const plain = driver.send("me", {
  threadId: "th-1",
  peer,
  body: "still fine",
  sentAt: at + 13,
  expiresAt: at + 86_400_000,
});
check("A6b 预算：预算只管代聊，自己发言不受影响", plain.message.body === "still fine", "");

const chain = new ImPrimaryChain(db);
chain.assign(driver.scope("me"), "th-1", "agent-a", "primary");
check("A6c 主责：唯一主责", chain.primary(driver.scope("me"), "th-1") === "agent-a", "");
check(
  "A6c 主责：转交后读回唯一",
  chain.transfer(driver.scope("me"), "th-1", "agent-a", "agent-b").filter((a) => a.role === "primary").length === 1,
  "",
);

const external: gate.CausalChain = { chainId: "c-ext", rootMessageId: "m-1", trustDomain: "im-peer", createdAt: at };
const local: gate.CausalChain = { chainId: "c-loc", rootMessageId: "m-2", trustDomain: "local", createdAt: at };

let externalTools = "";
try {
  driver.execute(external, () => "ran");
} catch (error) {
  externalTools = error instanceof ImToolRefused ? error.reason : String(error);
}
check("A15：外部会话执行工具被拒", externalTools !== "", externalTools);
check("A15：外部会话可以发言", driver.speak(external, () => "spoken") === "spoken", "");
check("对照组：本地链可执行工具", driver.execute(local, () => "ran") === "ran", "");
check("对照组：本地链可发言", driver.speak(local, () => "spoken") === "spoken", "");

let missingChain = "";
try {
  driver.execute(undefined, () => "ran");
} catch (error) {
  missingChain = error instanceof ImToolRefused ? error.reason : String(error);
}
check("A15：缺声明默认拒", missingChain === "im.unauthorized", missingChain);
check(
  "A15：裁决点就是 toolsDecision",
  gate.toolsDecision(external).toolsEnabled === false && gate.toolsDecision(local).toolsEnabled === true,
  "",
);

const chained = driver.send("me", {
  threadId: "th-1",
  peer,
  body: "with chain",
  causalChainId: external.chainId,
  sentAt: at + 20,
  expiresAt: at + 86_400_000,
});
check(
  "发信链路：因果链随消息落库",
  chained.message.causalChainId === external.chainId,
  String(chained.message.causalChainId),
);

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");

db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
