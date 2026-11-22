import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeImAccepted, parseImSignal } from "../packages/contracts/src/ipc-im";
import { TEAM_CURRENT_CAPABILITIES } from "../packages/contracts/src/team-protocol/current";
import { IM_ROUTES } from "../packages/contracts/src/team-protocol/im-v1";
import { ImChannelRoles } from "../src/backend/im/channel-roles";
import { ImDeliveryService } from "../src/backend/im/delivery";
import { ImHostApi } from "../src/backend/im/host-api";
import { ImService } from "../src/backend/im/im-service";
import { ImInboxService } from "../src/backend/im/inbox";
import { createSignalTransport, type ImLanSignalEnvelope, imSignalEnvelopeToWire } from "../src/backend/im/lan-signal";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { HttpError } from "../src/main/team-api/http-error";
import type { TeamApiRequestContext } from "../src/main/team-api/request-context";
import { routeIm } from "../src/main/team-api/route-im";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
};

const at = 1_700_000_000_000;
const root = await mkdtemp(join(tmpdir(), "im-signal-relay-"));
const db = new DatabaseSync(join(root, "openbot.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });

const received: { peerServerId: string; peerAgentId: string; kind: string; payload: string }[] = [];
const host = new ImHostApi(db, "srv-b", {}, null);
const im = new ImService(db, "srv-b");
const inbox = new ImInboxService(db, "srv-b");
const channels = new ImChannelRoles(db, "srv-b");
const delivery = new ImDeliveryService(db, "srv-b");
const lan = {
  lanPeers: () => ({ items: [], next: null }),
  lanSignal: (input: {
    peerServerId: string;
    peerAgentId: string;
    signal: { kind: "offer" | "answer" | "candidate"; payload: string };
  }) => {
    received.push({
      peerServerId: input.peerServerId,
      peerAgentId: input.peerAgentId,
      kind: input.signal.kind,
      payload: input.signal.payload,
    });
    return null;
  },
};

const server: Server = createServer((request, response) => {
  const context: TeamApiRequestContext = {
    request,
    response,
    method: request.method ?? "GET",
    url: new URL(request.url ?? "/", "http://127.0.0.1"),
    protocol: 10,
    capabilities: new Set(TEAM_CURRENT_CAPABILITIES),
    member: {
      id: "me",
      username: "me",
      email: null,
      name: "me",
      role: "owner",
      createdAt: new Date(at).toISOString(),
      disabled: false,
    },
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
  void routeIm(context, im, inbox, channels, delivery, host, host, host, host, host, lan).catch((error: unknown) => {
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

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

async function relaySignal(envelope: ImLanSignalEnvelope): Promise<void> {
  const reply = await post(IM_ROUTES.lanSignal, imSignalEnvelopeToWire(envelope));
  decodeImAccepted(reply.body);
}

const transport = createSignalTransport({
  localServerId: "srv-a",
  localAgentId: "me",
  endpointOf: () => null,
  relay: relaySignal,
});

process.stdout.write("== 主链路：真走中转 ==\n");
await transport.send({
  peerServerId: "srv-b",
  peerAgentId: "agent-peer",
  signal: { kind: "offer", payload: "sdp-offer-1" },
});
check("走中转：对端不在局域网时回落到中转（没去直连）", received.length === 1, JSON.stringify(received));
check(
  "走中转：中转后对端真收到 offer 与载荷",
  received[0]?.kind === "offer" && received[0]?.payload === "sdp-offer-1",
  JSON.stringify(received[0]),
);
check(
  "走中转：中转后对端拿到的是发起方身份",
  received[0]?.peerServerId === "srv-a" && received[0]?.peerAgentId === "me",
  JSON.stringify(received[0]),
);

process.stdout.write("\n== 对照：中转那层不是随便糊过去的 ==\n");
const wire = imSignalEnvelopeToWire({
  fromServerId: "srv-a",
  fromAgentId: "me",
  toServerId: "srv-b",
  toAgentId: "agent-peer",
  signal: { kind: "answer", payload: "sdp-answer-1" },
});
check("转换后是线上形状（平铺 kind/payload）", "kind" in wire && !("signal" in wire), JSON.stringify(wire));
const internalShape = {
  fromServerId: "srv-a",
  fromAgentId: "me",
  toServerId: "srv-b",
  toAgentId: "agent-peer",
  signal: { kind: "answer", payload: "sdp-answer-1" },
};
const beforeCount = received.length;
const rawReply = await post(IM_ROUTES.lanSignal, internalShape);
check(
  "对照：内部信封原样发上网会被对端拒（旧 bug 真修了）",
  rawReply.status !== 200 && received.length === beforeCount,
  `status=${rawReply.status} body=${JSON.stringify(rawReply.body)}`,
);
const smuggledReply = await post(IM_ROUTES.lanSignal, { ...wire, extra: 1 });
check("对照：多塞未知字段仍拒（fail-closed 没放松）", smuggledReply.status !== 200, `status=${smuggledReply.status}`);
check(
  "对照：远端请求解码器同样拒内部信封",
  (() => {
    try {
      parseImSignal(internalShape);
      return false;
    } catch (error) {
      return error instanceof Error && error.name === "ImProtocolError";
    }
  })(),
  "",
);

server.close();
db.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
