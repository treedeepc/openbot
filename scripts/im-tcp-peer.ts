import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { ImWireFrame } from "../src/backend/im/wire";
import { decodeImWireFrame, ImWireForwarder } from "../src/backend/im/wire";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { text } from "./verify-im-helpers";

const role = text(process.argv[2]);
const port = Number(process.argv[3]);
const mode = process.argv[4] ?? "clean";

const root = await mkdtemp(join(tmpdir(), `im-tcp-${role}-`));
const db = new DatabaseSync(join(root, "peer.db"));
migrateOpenBotDatabase(db, { appliedAt: new Date().toISOString() });
db.exec("PRAGMA foreign_keys = OFF");
db.prepare(
  "INSERT INTO local_devices (local_server_id, local_member_id, device_id, public_key, status, cert_ref, enrolled_at, revoked_at, pairing_expires_at, pairing_code) VALUES ('srv-1','me','device-a','pk','active',NULL,1,NULL,NULL,NULL)",
).run();
db.exec("PRAGMA foreign_keys = ON");
const forwarder = new ImWireForwarder(db, "srv-1");

function asRecord(value: unknown): DynamicRecord {
  if (!isDynamicRecord(value)) throw new Error("im.protocolError");
  return value;
}

function write(socket: import("node:net").Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

function frame(nonce: string): ImWireFrame {
  return {
    type: "forward",
    fromServerId: role === "server" ? "srv-1" : "srv-2",
    fromAgentId: role,
    toServerId: role === "server" ? "srv-2" : "srv-1",
    toAgentId: role === "server" ? "client" : "server",
    sealed: `ciphertext-${nonce}`,
    remoteMessageId: `rm-${nonce}`,
    nonce,
    sentAt: 1_700_000_000_000,
  };
}

async function finish(payload: unknown): Promise<void> {
  process.stdout.write(`${JSON.stringify(payload)}\n\n`);
  db.close();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}

if (role === "server") {
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index === -1) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const parsed = asRecord(JSON.parse(line));
        if (parsed.kind === "frame") {
          let decoded: ImWireFrame | null = null;
          try {
            decoded = decodeImWireFrame(
              mode === "tamper" ? { ...asRecord(parsed.payload), injected: "x" } : parsed.payload,
            );
          } catch {
            write(socket, { kind: "rejected", reason: "im.protocolError" });
            return;
          }
          const queued = forwarder.forward("me", {
            frame: decoded,
            deviceIds: ["device-a"],
            at: 1_700_000_000_000,
            expiresAt: 1_700_000_086_400,
          });
          write(socket, { kind: "ack", nonce: decoded.nonce, sealed: decoded.sealed, queued: queued.outcomes.length });
        }
        if (parsed.kind === "bye") {
          void finish({
            role: "server",
            received: 1,
            dbRows: db.prepare("SELECT COUNT(*) AS n FROM offline_queue").get(),
          });
          socket.end();
          server.close();
        }
      }
    });
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write("ready\n");
  });
} else {
  const socket = connect(port, "127.0.0.1", () => {
    write(socket, { kind: "frame", payload: frame("tcp-1") });
  });
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += String(chunk);
    const index = buffer.indexOf("\n");
    if (index === -1) return;
    const reply = asRecord(JSON.parse(buffer.slice(0, index)));
    write(socket, { kind: "bye" });
    void finish({
      role: "client",
      acked: reply.kind === "ack",
      nonce: reply.nonce,
      sealed: reply.sealed,
      queued: reply.queued,
      localQueue: db.prepare("SELECT COUNT(*) AS n FROM offline_queue").get(),
    });
  });
}
