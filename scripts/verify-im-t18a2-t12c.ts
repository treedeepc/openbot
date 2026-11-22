import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TEAM_CURRENT_CAPABILITIES } from "../packages/contracts/src/team-protocol/current";
import {
  IM_BLOCKLIST_CAPABILITY,
  IM_CONTACTS_CAPABILITY,
  IM_INBOX_CAPABILITY,
  IM_REPORT_CAPABILITY,
  IM_ROUTES_BY_CAPABILITY,
} from "../packages/contracts/src/team-protocol/im-v1";
import { ImInboxService } from "../src/backend/im/inbox";
import { ImSearchService } from "../src/backend/im/search";
import { IM_RATE_LIMITS } from "../src/backend/im/social";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { IM_HANDLED_PATHS } from "../src/main/team-api/route-im";
import { itemAt, record } from "./verify-im-helpers";

const routesByCapability = new Map<string, readonly string[]>(Object.entries(IM_ROUTES_BY_CAPABILITY));
const routesOf = (capability: string): readonly string[] => routesByCapability.get(capability) ?? [];

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-t18a2-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
const peer = { peerServerId: "srv-2", peerAgentId: "agent-peer" };
const hidden = { peerServerId: "srv-3", peerAgentId: "agent-hidden" };
const threadSeeds: { member: string; threadId: string; ref: { peerServerId: string; peerAgentId: string } }[] = [
  { member: "me", threadId: "th-1", ref: peer },
  { member: "other", threadId: "th-2", ref: hidden },
];
for (const seed of threadSeeds) {
  db.prepare(
    "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1', ?, ?, ?, ?, 'open', NULL)",
  ).run(seed.member, seed.threadId, seed.ref.peerServerId, seed.ref.peerAgentId);
}
const peerSeeds: { serverId: string; agentId: string; name: string }[] = [
  { serverId: "srv-2", agentId: "agent-peer", name: "Mira" },
  { serverId: "srv-3", agentId: "agent-hidden", name: "Ghost" },
];
for (const seed of peerSeeds) {
  db.prepare(
    "INSERT INTO peers (peer_server_id, peer_agent_id, public_key, display_name, verified_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, NULL, 1, 1)",
  ).run(seed.serverId, seed.agentId, `pk-${seed.agentId}`, seed.name);
}
db.exec("PRAGMA foreign_keys = ON");

const inbox = new ImInboxService(db, "srv-1");
const search = new ImSearchService(db, "srv-1");
const at = 1_700_000_000_000;

check(
  "T18a2 收件箱：列线程",
  inbox.listThreads("me").items.length === 1 && itemAt(inbox.listThreads("me").items, 0).threadId === "th-1",
  "",
);
check("T18a2 收件箱：取单个线程", inbox.getThread("me", { threadId: "th-1" }).peerAgentId === "agent-peer", "");
check(
  "跨成员隔离：B 列不到 A 的线程",
  inbox.listThreads("other").items.length === 1 && itemAt(inbox.listThreads("other").items, 0).threadId === "th-2",
  "",
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
threw("跨成员隔离：B 取不到 A 的线程", () => inbox.getThread("other", { threadId: "th-1" }), "ImThreadUnknown");

const assigned = inbox.assignThread("me", { threadId: "th-1", assignees: ["agent-a", "agent-b"], primary: "agent-a" });
check(
  "T18a2 收件箱：指派落主责",
  assigned.primary === "agent-a" && assigned.assignees.length === 2,
  JSON.stringify(assigned.assignees),
);
const transferred = inbox.transferThread("me", { threadId: "th-1", toAgent: "agent-b" });
check(
  "T18a2 收件箱：转交后主责唯一",
  transferred.primary === "agent-b" && transferred.assignees.filter((a) => a === "agent-b").length === 1,
  transferred.primary ?? "null",
);

const contact = inbox.requestContact("me", { contactId: "c-1", peer, note: "hi", at });
check("T18a2 联系人：请求落 pending", contact.state === "pending", contact.state);
check("T18a2 联系人：列表", inbox.listContacts("me").items.length === 1, "");
check(
  "T18a2 联系人：接受后 accepted",
  inbox.acceptContact("me", { contactId: "c-1", at: at + 1 }).state === "accepted",
  "",
);
check(
  "T18a2 联系人：拒绝转 removed",
  inbox.rejectContact("me", { contactId: "c-1", at: at + 2 }).state === "removed",
  "",
);
threw(
  "T18a2 联系人：未知联系人拒",
  () => inbox.acceptContact("me", { contactId: "nope", at: at + 3 }),
  "ImContactNotFound",
);
check("跨成员隔离：B 看不到 A 的联系人", inbox.listContacts("other").items.length === 0, "");

const rule = inbox.addBlock("me", { ruleId: "b-1", peer, reason: "spam", at: at + 4 });
check("T18a2 拉黑：落规则", inbox.listBlocklist("me").items.length === 1 && rule.reason === "spam", "");
check(
  "T18a2 拉黑：移除",
  inbox.removeBlock("me", { peer }) === true && inbox.listBlocklist("me").items.length === 0,
  "",
);
inbox.removeBlock("me", { peer });

const report = inbox.createReport("me", {
  reportId: "rp-1",
  targetPeer: "srv-2/agent-peer",
  category: "spam",
  detail: "ads",
  at: at + 6,
});
check("T18a2 举报：落 open", report.status === "open" && inbox.listReports("me").items.length === 1, "");

const found = search.search("me", { q: "mira", at: at + 10 });
check(
  "T12c 搜索：可见对端可搜到",
  found.items.length === 1 && itemAt(found.items, 0).displayName === "Mira",
  JSON.stringify(found.items),
);
check(
  "T12c 搜索：不可见对端搜不到（可见性过滤）",
  search.search("me", { q: "ghost", at: at + 11 }).items.length === 0,
  "",
);
check("对照组：B 能搜到自己的对端", search.search("other", { q: "ghost", at: at + 12 }).items.length === 1, "");

inbox.addBlock("me", { ruleId: "b-search", peer, reason: "spam", at: at + 13 });
check("T12c 搜索：被我拉黑的对象必须搜不到", search.search("me", { q: "mira", at: at + 14 }).items.length === 0, "");
check("对照组：我拉黑不影响别的成员", search.search("other", { q: "ghost", at: at + 15 }).items.length === 1, "");
inbox.removeBlock("me", { peer });
check("T12c 搜索：解除拉黑后恢复可搜", search.search("me", { q: "mira", at: at + 16 }).items.length === 1, "");

db.prepare(
  "INSERT INTO block_rules (local_server_id, local_member_id, rule_id, peer_server_id, peer_agent_id, created_at, reason) VALUES ('srv-3', 'agent-hidden', 'b-them', 'srv-1', 'other', 1, 'muted')",
).run();
check("对照组：对方拉黑别的成员不影响我", search.search("me", { q: "mira", at: at + 17 }).items.length === 1, "");
check("两层：被拉黑的成员自己搜不到", search.search("other", { q: "ghost", at: at + 18 }).items.length === 0, "");
db.prepare("DELETE FROM block_rules WHERE rule_id = 'b-them'").run();

db.prepare(
  "INSERT INTO block_rules (local_server_id, local_member_id, rule_id, peer_server_id, peer_agent_id, created_at, reason) VALUES ('srv-2', 'agent-peer', 'b-against-me', 'srv-1', 'me', 1, 'nope')",
).run();
check("T12c 搜索：对方拉黑我也搜不到（两层）", search.search("me", { q: "mira", at: at + 19 }).items.length === 0, "");
db.prepare("DELETE FROM block_rules WHERE rule_id = 'b-against-me'").run();
check("对照组：对方解除后恢复", search.search("me", { q: "mira", at: at + 20 }).items.length === 1, "");

const policy = IM_RATE_LIMITS.search;
db.exec("PRAGMA foreign_keys = OFF");
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1', 'rate', 'th-rate', 'srv-2', 'agent-peer', 'open', NULL)",
).run();
db.exec("PRAGMA foreign_keys = ON");
for (let index = 0; index < policy.max; index += 1) search.search("rate", { q: "mira", at: at + 100 + index });
threw(
  "T12c 限速：超额度被拦（im.rateLimited）",
  () => search.search("rate", { q: "mira", at: at + 100 + policy.max }),
  "ImSearchRateLimited",
);
check(
  "T12c 限速审计：每次查询都记账",
  Number(
    record(db.prepare("SELECT count FROM audit_aggregates WHERE action = 'im.search' AND actor_id = 'rate'").get())
      .count,
  ) === policy.max,
  String(
    record(db.prepare("SELECT count FROM audit_aggregates WHERE action = 'im.search' AND actor_id = 'rate'").get())
      .count,
  ),
);
check("T12c 限速：按成员分开计数", search.search("other", { q: "ghost", at: at + 200 }).items.length === 1, "");

for (const capability of [IM_INBOX_CAPABILITY, IM_CONTACTS_CAPABILITY, IM_BLOCKLIST_CAPABILITY, IM_REPORT_CAPABILITY]) {
  const missing = routesOf(capability).filter((route) => !IM_HANDLED_PATHS.has(route));
  check(
    `T18a2 route 全通：${capability}`,
    missing.length === 0,
    missing.join(",") || `${routesOf(capability).length} 条`,
  );
}
check(
  "口径：这四条能力已注册（route 全通后合法注册，基线跟上变更）",
  [IM_INBOX_CAPABILITY, IM_CONTACTS_CAPABILITY, IM_BLOCKLIST_CAPABILITY, IM_REPORT_CAPABILITY].every((capability) =>
    TEAM_CURRENT_CAPABILITIES.some((entry) => entry === capability),
  ),
  "",
);
check(
  "口径：已注册的都是 route 全通的",
  TEAM_CURRENT_CAPABILITIES.filter((c) => c.startsWith("im-")).every((c) =>
    routesOf(c).every((r) => IM_HANDLED_PATHS.has(r)),
  ),
  "",
);

check("迁移后 foreign_key_check 为空", db.prepare("PRAGMA foreign_key_check").all().length === 0, "");

db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
