import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseImSendMessage } from "../packages/contracts/src/ipc-im";
import { ImMessagingDriver } from "../src/backend/im/messaging-driver";
import { IM_PROXY_BUDGET_USD } from "../src/backend/im/proxy";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { record } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-send-proxied-"));
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
const base = { threadId: "th-1", peer, sentAt: at, expiresAt: at + 86_400_000 };
const count = () => Number(record(db.prepare("SELECT COUNT(*) AS n FROM im_messages").get()).n);

const ok = driver.sendProxied("me", {
  ...base,
  body: "on behalf",
  proxiedBy: "agent-assist",
  proxyVisibility: "shown",
  usdCents: 100,
});
check(
  "① 返回值带代聊标记（不再 null）",
  ok.message.proxiedBy === "agent-assist" && ok.message.proxyVisibility === "shown",
  JSON.stringify({ proxiedBy: ok.message.proxiedBy, v: ok.message.proxyVisibility }),
);
check(
  "② 一次写：落库即带标记（不靠事后 UPDATE）",
  String(
    db.prepare("SELECT proxied_by FROM im_messages WHERE local_message_id = ?").get(ok.message.localMessageId)
      ?.proxied_by,
  ) === "agent-assist",
  "",
);
check(
  "② 一次写：visibility 同批落库",
  String(
    db.prepare("SELECT proxy_visibility FROM im_messages WHERE local_message_id = ?").get(ok.message.localMessageId)
      ?.proxy_visibility,
  ) === "shown",
  "",
);

const before = count();
function refused(name: string, run: () => unknown | Promise<unknown>, expected: string): void {
  let code = "";
  try {
    void run();
  } catch (error) {
    code = error instanceof Error ? error.name : String(error);
  }
  check(name, code === expected && count() === before, `${code || "没有报错"}｜库内条数 ${count()}`);
}

refused(
  "③ 成对校验在写库前：缺 visibility 抛错且不落库",
  () => driver.sendProxied("me", { ...base, body: "x", proxiedBy: "a", proxyVisibility: null, usdCents: 1 }),
  "ImProxyNotAllowed",
);
refused(
  "④ 金额校验在发信前：负数拒且不落库",
  () => driver.sendProxied("me", { ...base, body: "x", proxiedBy: "a", proxyVisibility: "shown", usdCents: -1 }),
  "ImProxyBudgetExceeded",
);
refused(
  "④ 金额校验在发信前：小数拒且不落库",
  () => driver.sendProxied("me", { ...base, body: "x", proxiedBy: "a", proxyVisibility: "shown", usdCents: 1.5 }),
  "ImProxyBudgetExceeded",
);

const spentAfterValid = driver.proxy.budget(driver.scope("me"), "srv-2/agent-peer", at).spentUsd;
check("⑤ 失败的尝试不扣费", spentAfterValid === 1, String(spentAfterValid));

driver.proxy.charge(driver.scope("me"), "srv-2/agent-peer", IM_PROXY_BUDGET_USD * 100 - 100, at);
refused(
  "⑥ 超支拒发在写库前：不落库",
  () => driver.sendProxied("me", { ...base, body: "over", proxiedBy: "a", proxyVisibility: "shown", usdCents: 200 }),
  "ImProxyBudgetExceeded",
);
check(
  "⑥ 超支拒发：预算没被扣成负数",
  driver.proxy.budget(driver.scope("me"), "srv-2/agent-peer", at).remainingUsd === 0,
  String(driver.proxy.budget(driver.scope("me"), "srv-2/agent-peer", at).remainingUsd),
);

const oneMore = driver.sendProxied("me", {
  ...base,
  sentAt: at + 1,
  body: "last cent",
  proxiedBy: "agent-assist",
  proxyVisibility: "hidden",
  usdCents: 0,
});
check(
  "⑦ 扣费与判定同额：0 分也能发（预算边界内）",
  oneMore.message.proxiedBy === "agent-assist" && oneMore.message.proxyVisibility === "hidden",
  "",
);
check(
  "⑦ 自己发言不受预算影响",
  driver.send("me", { ...base, sentAt: at + 2, body: "plain" }).message.proxiedBy === null,
  "",
);

function decodeRefused(name: string, value: unknown): void {
  let code = "";
  try {
    parseImSendMessage(value);
  } catch (error) {
    code = error instanceof Error ? error.name : String(error);
  }
  check(name, code === "ImProtocolError", code || "没有报错");
}

process.stdout.write("\n== ⑧ 解码层那半（拍板1：运行时 + 解码层两层都要）==\n");
decodeRefused("⑧ 解码层：代聊缺 visibility 在解码就拒", {
  threadId: "th-1",
  remoteMessageId: "rm-8a",
  body: "x",
  proxiedBy: "agent-assist",
  proxyVisibility: null,
});
decodeRefused("⑧ 解码层：代聊整个没带 visibility 字段也拒", {
  threadId: "th-1",
  remoteMessageId: "rm-8b",
  body: "x",
  proxiedBy: "agent-assist",
});
check(
  "⑧ 对照：非代聊消息 visibility 可空（没矫枉过正）",
  parseImSendMessage({ threadId: "th-1", remoteMessageId: "rm-8c", body: "x", proxiedBy: null, proxyVisibility: null })
    .proxiedBy === null,
  "",
);
check(
  "⑧ 对照：代聊带 visibility 正常通过",
  parseImSendMessage({
    threadId: "th-1",
    remoteMessageId: "rm-8d",
    body: "x",
    proxiedBy: "agent-assist",
    proxyVisibility: "shown",
  }).proxyVisibility === "shown",
  "",
);

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");

db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
