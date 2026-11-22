import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importHostGrantPrivateKey, openHostGrant } from "../packages/contracts/src/host-grant";
import { imEnvelopeNonce, isImEnvelopePayload } from "../packages/contracts/src/im-envelope";
import { imFingerprint } from "../src/backend/im/identity";
import { ImLanGateway } from "../src/backend/im/lan-gateway";
import { ImLanUndelivered } from "../src/backend/im/lan-outbox";
import { createMdnsResponder } from "../src/backend/im/mdns-responder";
import { createWrtcFactory } from "../src/backend/im/webrtc-factory";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { count, record, text } from "./verify-im-helpers";

const [serverId, agentId, peerServerId, peerAgentId, mode, verifyMode] = [
  process.argv[2] ?? "srv-a",
  process.argv[3] ?? "agent-a",
  process.argv[4] ?? "srv-b",
  process.argv[5] ?? "agent-b",
  process.argv[6] ?? "send",
  process.argv[7] ?? "verify",
];
const root = await mkdtemp(join(tmpdir(), `im-lan-${agentId}-`));
const db = new DatabaseSync(join(root, "peer.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
db.prepare(
  "INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status, cert_ref, enrolled_at, revoked_at, pairing_expires_at, pairing_code) VALUES (?,?,?,?,'active',NULL,1,NULL,NULL,NULL)",
).run(serverId, agentId, `device-${agentId}`, process.env.IM_DEVICE_KEY ?? "");
db.prepare(
  "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state, last_message_at) VALUES (?,?,?,?,'th-peer','open',NULL)",
).run(serverId, agentId, `th-${agentId}`, peerServerId);
db.prepare(
  "INSERT INTO peers_devices (device_id, peer_server_id, peer_agent_id, public_key, cert_ref, endorsed_by, revoked_at) VALUES (?,?,?,?,?,?,NULL)",
).run(`peer-device-${peerAgentId}`, peerServerId, peerAgentId, process.env.IM_PEER_DEVICE_KEY ?? "", "cert", agentId);
db.exec("PRAGMA foreign_keys = ON");

const received: unknown[] = [];
let sent = false;
const gateway = new ImLanGateway({
  db,
  localServerId: serverId,
  factory: createWrtcFactory(),
  responder: createMdnsResponder(),
  localAgentId: agentId,
  localDeviceId: `device-${agentId}`,
});

type ImLanPeerReport =
  | { ok: false; stage: "open"; error: string }
  | { ok: false; stage: "channel"; discovered: number }
  | { ok: false; stage: "deliver"; error: string }
  | {
      ok: boolean;
      queued: number;
      sent: boolean;
      port: number;
      discovered: number;
      sentBody: string;
      sealedText: string;
      openedBody: string;
      remoteMessageId: string;
      queuePeer: string;
      queueDevice: string;
      channelState: string;
    };

async function finish(payload: ImLanPeerReport): Promise<void> {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  gateway.stop();
  db.close();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}

const port = await gateway.start({ name: agentId, publicKey: process.env.IM_DEVICE_KEY ?? "" });
process.stdout.write(`ready ${port}\n`);

for (let round = 0; round < 120; round += 1) {
  const peer = gateway.peer(peerServerId, peerAgentId);
  if (peer) {
    if (verifyMode === "verify") {
      gateway.discovery.verify({ peerServerId, peerAgentId }, imFingerprint(peer.publicKey));
    }
    break;
  }
  await new Promise((done) => setTimeout(done, 50));
}

if (mode === "send") {
  try {
    gateway.open(peerServerId, peerAgentId);
  } catch (error) {
    await finish({ ok: false, stage: "open", error: error instanceof Error ? error.message : String(error) });
  }
}

let open = false;
for (let round = 0; round < 240; round += 1) {
  if (gateway.channelState(peerServerId, peerAgentId) === "open") {
    open = true;
    break;
  }
  await new Promise((done) => setTimeout(done, 50));
}

if (!open) {
  await finish({ ok: false, stage: "channel", discovered: gateway.discovery.discovered().length });
}

try {
  await gateway.deliver({
    deliveryId: `dl-${agentId}`,
    memberId: agentId,
    remoteMessageId: `rm-${agentId}`,
    threadId: `th-${agentId}`,
    peerServerId,
    peerAgentId,
    body: `hello-from-${agentId}`,
    nonce: `nonce-${agentId}`,
    sentAt: Date.now(),
  });
  sent = true;
} catch (error) {
  await finish({
    ok: false,
    stage: "deliver",
    error: error instanceof ImLanUndelivered ? error.reason : error instanceof Error ? error.message : String(error),
  });
}

for (let round = 0; round < 120 && received.length === 0; round += 1) {
  const row = record(db.prepare("SELECT COUNT(*) AS n FROM offline_queue").get());
  if (count(row.n) > 0) received.push(row);
  await new Promise((done) => setTimeout(done, 50));
}

const queued = record(
  db
    .prepare(
      "SELECT sealed_payload, remote_message_id, peer_server_id, peer_agent_id, recipient_device_id FROM offline_queue LIMIT 1",
    )
    .get(),
);
const sealedBytes = queued.sealed_payload instanceof Uint8Array ? queued.sealed_payload : new Uint8Array();
const sealedText = new TextDecoder().decode(sealedBytes);
let openedBody: string | null = null;
try {
  const privateKey = await importHostGrantPrivateKey(process.env.IM_DEVICE_PRIVATE_KEY ?? "");
  const payload = await openHostGrant(
    { version: 1, info: "openbot-im-envelope-v1" },
    privateKey,
    imEnvelopeNonce(`th-${peerAgentId}`, `dl-${peerAgentId}`),
    sealedText,
    (value) => {
      if (!isImEnvelopePayload(value)) throw new Error("im.protocolError");
      return value;
    },
  );
  openedBody = payload.body;
} catch (error) {
  openedBody = `open-failed:${error instanceof Error ? error.message : String(error)}`;
}

await finish({
  ok: received.length > 0 && sent,
  queued: received.length,
  sent,
  port,
  discovered: gateway.discovery.discovered().length,
  sentBody: `hello-from-${agentId}`,
  sealedText,
  openedBody,
  remoteMessageId: text(queued.remote_message_id),
  queuePeer: `${text(queued.peer_server_id)}/${text(queued.peer_agent_id)}`,
  queueDevice: text(queued.recipient_device_id),
  channelState: gateway.channelState(peerServerId, peerAgentId),
});
