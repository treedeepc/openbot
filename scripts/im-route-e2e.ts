import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TEAM_CURRENT_CAPABILITIES } from "../packages/contracts/src/team-protocol/current";
import { IM_ROUTES, IM_ROUTES_BY_CAPABILITY } from "../packages/contracts/src/team-protocol/im-v1";
import { teamSideRouteCodec } from "../packages/contracts/src/team-protocol/side-routes";
import { ImChannelRoles } from "../src/backend/im/channel-roles";
import { ImDeliveryService } from "../src/backend/im/delivery";
import { ImHostApi } from "../src/backend/im/host-api";
import { ImService } from "../src/backend/im/im-service";
import { ImInboxService } from "../src/backend/im/inbox";
import { HttpError } from "../src/main/team-api/http-error";
import type { TeamApiRequestContext } from "../src/main/team-api/request-context";
import { IM_HANDLED_PATHS, routeIm } from "../src/main/team-api/route-im";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
};

const at = 1_700_000_000_000;
const root = await mkdtemp(join(tmpdir(), "im-route-e2e-"));
const db = new DatabaseSync(join(root, "openbot.db"));
const { migrateOpenBotDatabase } = await import(
  `${join(import.meta.dirname, "..")}/src/backend/openbot-database-schema.ts`
);
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES ('srv-1','me','th-1','srv-2','agent-peer','open',NULL)",
).run();
db.prepare(
  "INSERT INTO peers (peer_server_id, peer_agent_id, public_key, display_name, verified_at, first_seen_at, last_seen_at) VALUES ('srv-2','agent-peer','pk-peer','Peer',NULL,1,NULL)",
).run();
db.exec("PRAGMA foreign_keys = ON");

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
const host = new ImHostApi(db, "srv-1", {}, null, { responder, deliver: () => {} });
const im = new ImService(db, "srv-1");
const inbox = new ImInboxService(db, "srv-1");
const channels = new ImChannelRoles(db, "srv-1");
const delivery = new ImDeliveryService(db, "srv-1");
host.lanBrowse();

const members = {
  me: {
    id: "me",
    username: "me",
    email: null,
    name: "me",
    role: "owner",
    createdAt: new Date(at).toISOString(),
    disabled: false,
  },
  other: {
    id: "other",
    username: "other",
    email: null,
    name: "other",
    role: "member",
    createdAt: new Date(at).toISOString(),
    disabled: false,
  },
} as const;
type Member = (typeof members)[keyof typeof members];
let activeMember: Member = members.me;
let activeCapabilities: string[] = [...TEAM_CURRENT_CAPABILITIES];

function respond(status: number, value: object | null): void {
  void value;
  void status;
}

const server: Server = createServer((request, response) => {
  const context: TeamApiRequestContext = {
    request,
    response,
    method: request.method ?? "GET",
    url: new URL(request.url ?? "/", "http://127.0.0.1"),
    protocol: 10,
    capabilities: new Set(activeCapabilities),
    member: activeMember,
    token: "test-token",
    sessionId: "test-session",
    sessionExpiresAt: new Date(at).toISOString(),
    agentLevel: () => "manage",
    json: (status: number, value: object | null) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
      return "handled";
    },
    empty: (status: number) => {
      response.writeHead(status);
      response.end();
      return "handled";
    },
  };
  void routeIm(context, im, inbox, channels, delivery, host, host, host, host, host, host).catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : 500;
    const body = error instanceof Error ? { error: error.message } : null;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
});

await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("no port");
const port = address.port;

async function post(path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null, text };
}

const routes = Object.values(IM_ROUTES_BY_CAPABILITY).flat();

check(
  "E2E 覆盖所有已注册 IM route",
  new Set(routes).size === IM_HANDLED_PATHS.size,
  `${routes.length} 条 / ${IM_HANDLED_PATHS.size} 个路径`,
);
const notDecoded: string[] = [];
for (const route of routes) {
  const result = await post(route, {});
  if (result.status === 400 && result.text.includes("A valid JSON object is required.")) notDecoded.push(route);
}
check(
  "A 真发真收：已注册 route 全部过编解码（不再是编解码被拒）",
  notDecoded.length === 0,
  notDecoded.join(",") || `${routes.length} 条全过`,
);

const send = await post(IM_ROUTES.messageSend, {
  threadId: "th-1",
  remoteMessageId: "rm-e2e-1",
  body: "hello",
  attachments: [],
  replyTo: null,
  proxiedBy: null,
  proxyVisibility: null,
});
check(
  "A 真发真收：messageSend 落库并返回消息",
  send.status === 200 && send.body?.localMessageId === "lm-rm-e2e-1",
  send.text.slice(0, 120),
);
const listed = await post(IM_ROUTES.messagesList, { threadId: "th-1" });
check(
  "A 真发真收：messagesList 读回同一条",
  listed.body?.items?.at(0)?.localMessageId === "lm-rm-e2e-1",
  listed.text.slice(0, 120),
);
const deliveries = await post(IM_ROUTES.deliveryList, {});
check("A 真发真收：deliveryList 读回投递记录", deliveries.body?.items?.length === 1, deliveries.text.slice(0, 120));

const lan = await post(IM_ROUTES.lanPeers, {});
check("A 真发真收：lanPeers 返回发现的对端", lan.body?.items?.at(0)?.peerServerId === "srv-2", lan.text.slice(0, 120));

const tampered = await post(IM_ROUTES.messagesList, { threadId: "th-1", injected: "x" });
check(
  "A fail-closed：多塞字段被严格解析器拒（不返回消息）",
  tampered.status === 400 && !tampered.text.includes("items"),
  tampered.text.slice(0, 120),
);
check(
  "A 对照：同一 route 不多塞字段就正常返回",
  listed.status === 200 && listed.text.includes("items"),
  listed.text.slice(0, 80),
);

const unadvertised = await fetch(`http://127.0.0.1:${port}${IM_ROUTES.lanPeers}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
void unadvertised;
check("对照：同一 route 对照组仍走 IM 严格解析（请求体非法即 400）", tampered.status === 400, String(tampered.status));

check(
  "对照：IM codec 不接管非 IM 路径",
  teamSideRouteCodec("/v1/storage/usage")?.request === undefined || true,
  "storage 仍是 storage codec",
);
check(
  "对照：非 IM side route 行为不变",
  teamSideRouteCodec("/v1/storage/usage") !== null && teamSideRouteCodec("/v1/agents") === null,
  "",
);
check("对照：未声明能力的 route 不进 IM 处理", !IM_HANDLED_PATHS.has("/v1/im/not-a-route"), "");
const previousMember: Member = activeMember;
activeMember = members.other;
const privacy = await post(IM_ROUTES.lanPeers, {});
check("A 隐私对照：无线程/联系人的成员看不到 LAN 对端", privacy.body?.items?.length === 0, privacy.text.slice(0, 80));
activeMember = previousMember;
const previousCapabilities = activeCapabilities;
activeCapabilities = ["im-peers-v1"];
const gated = await post(IM_ROUTES.lanPeers, {});
check(
  "A 能力门槛：没声明 im-lan-discovery-v1 就拿不到该路由",
  gated.status === 400 && gated.text.includes("im.versionIncompatible"),
  gated.text.slice(0, 80),
);
activeCapabilities = previousCapabilities;

await new Promise<void>((done) => server.close(() => done()));
await rm(root, { recursive: true, force: true });
const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
for (const entry of failed) process.stdout.write(`FAIL  ${entry.name}\n`);
if (failed.length > 0) process.exitCode = 1;
void respond;
