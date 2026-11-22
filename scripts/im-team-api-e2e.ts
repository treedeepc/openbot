import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { TEAM_APP_VERSION_HEADER, TEAM_PROTOCOL_VERSION_HEADER } from "@openbot/contracts/team-protocol";
import { teamCapabilityHeaders } from "@openbot/contracts/team-protocol/current";
import { IM_CAPABILITIES, IM_ROUTES, IM_ROUTES_BY_CAPABILITY } from "@openbot/contracts/team-protocol/im-v1";
import { imEntrySupportFor } from "@openbot/team-client/im-client";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { ImHostApi } from "../src/backend/im/host-api";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import { AGENT_ACCESS_FILE, AgentAccessStore } from "../src/main/agent-access-store";
import { createImTeamApiServices, imCapabilityOptions, imTeamApiOptions } from "../src/main/team-api/im-services";
import { TeamApiServer } from "../src/main/team-api-server";
import { TeamStore } from "../src/main/team-store";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
};

function recordOf(value: unknown): DynamicRecord {
  return isDynamicRecord(value) ? value : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function rows(value: unknown): DynamicRecord[] {
  return Array.isArray(value) ? value.filter(isDynamicRecord) : [];
}

const OWNER = { username: "owner-user", password: "owner-password-123" };
const HOST_VERSION = "0.0.0-e2e";
const CLIENT_VERSION = "0.75.0";

function unused(): never {
  throw new Error("not used in this run");
}

const agentBrowser: AgentBrowserHost = {
  listTabs: () => [],
  toolCanUseTab: () => false,
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
  shareTab: () => undefined,
  unshareThread: () => undefined,
  agentTab: () => null,
};

const teamBrowser = {
  listTabs: () => [],
  getControlState: () => ({ sessions: [] }),
  open: unused,
  activate: unused,
  navigate: unused,
  reload: unused,
  stop: unused,
  takeUserControl: unused,
  startTeach: unused,
  stopTeach: () => [],
  releaseUserControl: () => {},
  releaseUserControlHeldBy: () => {},
  releaseUserControlRefused: () => {},
  close: unused,
  capturePreview: unused,
  setVisible: unused,
  getDisplayState: () => ({ tabs: [], activeTabId: null }),
  loadUrl: unused,
  isPrivate: () => false,
  startView: unused,
  dispatchViewInput: unused,
  copyViewSelection: unused,
  importSignIn: unused,
};

const root = await mkdtemp(join(tmpdir(), "im-team-api-e2e-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const database = new OpenBotDatabase(userData);
await runCauseEffect(database.initialize());
migrateOpenBotDatabase(database.connection, { appliedAt: new Date().toISOString() });
const agentStore = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, agentStore.sharedRoot, agentStore.database);
const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
const team = new TeamStore(join(userData, "openbot-team-server-v2.json"));
const access = new AgentAccessStore(join(userData, AGENT_ACCESS_FILE));
await runCauseEffect(sidebar.initialize());
await runCauseEffect(agentStore.initialize());
await runCauseEffect(mailbox.initialize());
await runCauseEffect(team.initialize());
const agents = new AgentService({ store: agentStore, mailbox, browser: agentBrowser, sidebarLayout: sidebar });
const identity = await runCauseEffect(team.configure("E2E Host", OWNER.username, OWNER.password));
const ownerMemberId = team.getOwnerMemberId();
database.connection
  .prepare(
    "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES (?, ?, ?, ?, ?, 'open', NULL)",
  )
  .run(identity.serverId, ownerMemberId, "th-remote-1", "srv-remote", "agent-remote");

const imServices = createImTeamApiServices({
  database: () => database.connection,
  identity: () => team.getIdentity(),
  hostApi: (connection, localServerId) =>
    new ImHostApi(connection, localServerId, {}, null, {
      responder: { announce: () => {}, browse: () => {}, stop: () => {} },
      turn: null,
      factory: null,
    }),
});

const shared = {
  store: team,
  agents,
  mailbox,
  browser: teamBrowser,
  sidebarLayout: sidebar,
  agentAccess: access,
  appVersion: HOST_VERSION,
};

const wired = new TeamApiServer({ ...shared, ...imTeamApiOptions(imServices) });
const bare = new TeamApiServer({ ...shared });
const wiredPort = await Effect.runPromise(wired.start());
const barePort = await Effect.runPromise(bare.start());

async function call(
  port: number,
  input: { path: string; method?: string; body?: unknown; token?: string },
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${input.path}`, {
    method: input.method ?? "POST",
    headers: {
      Accept: "application/json",
      [TEAM_PROTOCOL_VERSION_HEADER]: "10",
      [TEAM_APP_VERSION_HEADER]: CLIENT_VERSION,
      ...teamCapabilityHeaders(10, IM_CAPABILITIES),
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(input.token === undefined ? {} : { Authorization: `Bearer ${input.token}` }),
    },
    body: input.body === undefined ? null : JSON.stringify(input.body),
  });
  const body = await response.text();
  return { status: response.status, body: body.length > 0 ? JSON.parse(body) : null, text: body };
}

const login = await call(wiredPort, {
  path: "/v1/auth/login",
  body: { username: OWNER.username, password: OWNER.password },
});
const token = text(recordOf(login.body).sessionToken);
check("前置：远端用账号登录拿到会话", login.status === 200 && token.length > 0, `status=${login.status}`);

const compatibility = await call(wiredPort, { path: "/v1/compatibility", method: "GET", token });
const advertised = strings(recordOf(compatibility.body).capabilities);
check(
  "① 接上服务后：16 条 IM 能力全部广告",
  IM_CAPABILITIES.every((capability) => advertised.includes(capability)),
  `${IM_CAPABILITIES.filter((capability) => !advertised.includes(capability)).join(",") || "全在"}`,
);

process.stdout.write("\n== ② 远端真发一条 IM 消息到本机 ==\n");
const sent = await call(wiredPort, {
  path: IM_ROUTES.messageSend,
  token,
  body: {
    threadId: "th-remote-1",
    remoteMessageId: "rm-remote-1",
    body: "hello-from-remote",
    attachments: [],
    replyTo: null,
    proxiedBy: null,
    proxyVisibility: null,
  },
});
check("② 远端 messageSend 真发成功（不是 im.versionIncompatible）", sent.status === 200, sent.text.slice(0, 160));
check("② 本机真收到：返回消息带正文", text(recordOf(sent.body).body) === "hello-from-remote", sent.text.slice(0, 160));
const listed = await call(wiredPort, { path: IM_ROUTES.messagesList, token, body: { threadId: "th-remote-1" } });
const items = rows(recordOf(listed.body).items);
check(
  "② 真回看：messagesList 读回同一条正文",
  items.some((item) => item.body === "hello-from-remote"),
  `${items.length} 条 / ${listed.text.slice(0, 120)}`,
);

process.stdout.write("\n== ③ 广告与可用一致（不只抽一条）==\n");
const routes = Object.values(IM_ROUTES_BY_CAPABILITY).flat();
let refused = 0;
for (const route of routes) {
  const reply = await call(wiredPort, { path: route, token, body: {} });
  if (reply.status === 400 && reply.text.includes("im.versionIncompatible")) refused += 1;
}
check("③ 广告的 IM 能力没有一条路由回 im.versionIncompatible", refused === 0, `refused=${refused}`);

process.stdout.write("\n== ④ 对照：服务没接就不广告、也发不进 ==\n");
const bareLogin = await call(barePort, {
  path: "/v1/auth/login",
  body: { username: OWNER.username, password: OWNER.password },
});
const bareToken = text(recordOf(bareLogin.body).sessionToken);
const bareCompatibility = await call(barePort, { path: "/v1/compatibility", method: "GET", token: bareToken });
const bareAdvertised = strings(recordOf(bareCompatibility.body).capabilities);
check(
  "④ 服务没接时：im-* 一条都不广告",
  IM_CAPABILITIES.every((capability) => !bareAdvertised.includes(capability)),
  `泄漏=${IM_CAPABILITIES.filter((capability) => bareAdvertised.includes(capability)).join(",") || "无"}`,
);
const bareSend = await call(barePort, {
  path: IM_ROUTES.messageSend,
  token: bareToken,
  body: {
    threadId: "th-remote-1",
    remoteMessageId: "rm-remote-2",
    body: "should-not-land",
    attachments: [],
    replyTo: null,
    proxiedBy: null,
    proxyVisibility: null,
  },
});
check(
  "④ 服务没接时：真发被拒且不落库",
  bareSend.status === 400 && bareSend.text.includes("im.versionIncompatible"),
  `status=${bareSend.status}`,
);

process.stdout.write("\n== ⑤ 旧 host 缺 im-* 时全端仍不显示入口 ==\n");
const oldHostSupport = imEntrySupportFor({ kind: "remote", compatibility: { capabilities: bareAdvertised } });
check("⑤ 远端没声明 im-* → 入口全否", !oldHostSupport.session && !oldHostSupport.inbox, JSON.stringify(oldHostSupport));
const newHostSupport = imEntrySupportFor({ kind: "remote", compatibility: { capabilities: advertised } });
check("⑤ 远端声明了 im-* → 入口出现", newHostSupport.session === true, JSON.stringify(newHostSupport));

process.stdout.write("\n== ⑥ 守卫的覆盖面（通用、但不越界）==\n");
check(
  "⑥ 守卫覆盖 IM 全家：16 条一条不漏",
  IM_CAPABILITIES.every((capability) => imCapabilityOptions(capability) !== null),
  `漏=${IM_CAPABILITIES.filter((capability) => imCapabilityOptions(capability) === null).join(",") || "无"}`,
);
check(
  "⑥ 对照：守卫不越界到别的能力（非 IM 不被它挡）",
  imCapabilityOptions("agent-tasks-v1") === null && imCapabilityOptions("crm-v1") === null,
  "",
);

await runCauseEffect(wired.stop());
await runCauseEffect(bare.stop());
database.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
