import { createRequire } from "node:module";
import { hostname, networkInterfaces } from "node:os";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { ImMdnsResponder } from "./lan";

export const IM_MDNS_SERVICE_TYPE = "_openbot-im._tcp.local";

interface ImMdnsQuestion {
  name: string;
  type: string;
}

interface ImMdnsRecord {
  name: string;
  type: string;
  ttl?: number;
  data?: unknown;
}

interface ImMdnsPacket {
  questions?: ImMdnsQuestion[];
  answers?: ImMdnsRecord[];
  additionals?: ImMdnsRecord[];
}

interface ImMdnsSocket {
  on(event: "response", handler: (packet: ImMdnsPacket) => void): void;
  on(event: "query", handler: (packet: ImMdnsPacket) => void): void;
  query(input: { questions: ImMdnsQuestion[] }): void;
  respond(input: { answers: ImMdnsRecord[] }): void;
  destroy(): void;
}

function isMdnsSocket(value: unknown): value is ImMdnsSocket {
  if (!isDynamicRecord(value)) return false;
  const entry: DynamicRecord = value;
  return typeof entry.on === "function" && typeof entry.query === "function" && typeof entry.respond === "function";
}

function loadMdns(): ImMdnsSocket {
  const required = createRequire(import.meta.url)("multicast-dns");
  if (typeof required !== "function") throw new Error("im.protocolError");
  const created = required({});
  if (!isMdnsSocket(created)) throw new Error("im.protocolError");
  return created;
}

function lanAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

function txtOf(data: unknown): Record<string, string> {
  const txt: Record<string, string> = {};
  const items: unknown[] = Array.isArray(data) ? data : isDynamicRecord(data) ? Object.values(data) : [];
  for (const item of items) {
    const entry = typeof item === "string" ? item : item instanceof Uint8Array ? new TextDecoder().decode(item) : null;
    if (entry === null) continue;
    const split = entry.indexOf("=");
    if (split > 0) txt[entry.slice(0, split)] = entry.slice(split + 1);
  }
  return txt;
}

function srvOf(record: ImMdnsRecord): { target: string; port: number } | null {
  const data = record.data;
  if (!isDynamicRecord(data)) return null;
  if (typeof data.target !== "string" || typeof data.port !== "number") return null;
  return { target: data.target, port: data.port };
}

export function createMdnsResponder(options: { serviceType?: string } = {}): ImMdnsResponder {
  const serviceType = options.serviceType ?? IM_MDNS_SERVICE_TYPE;
  const host = `${hostname()}.local`;
  const address = lanAddress();
  const socket = loadMdns();
  const announced = new Map<string, { name: string; port: number; txt: Record<string, string> }>();
  const seen = new Set<string>();

  function answers(): ImMdnsRecord[] {
    const records: ImMdnsRecord[] = [];
    for (const instance of announced.values()) {
      const instanceName = `${instance.name}.${serviceType}`;
      records.push({ name: serviceType, type: "PTR", ttl: 120, data: instanceName });
      records.push({
        name: instanceName,
        type: "SRV",
        ttl: 120,
        data: { target: host, port: instance.port, weight: 0, priority: 0 },
      });
      records.push({
        name: instanceName,
        type: "TXT",
        ttl: 120,
        data: Object.entries(instance.txt).map(([key, value]) => `${key}=${value}`),
      });
      records.push({ name: host, type: "A", ttl: 120, data: address });
    }
    return records;
  }

  function handle(
    packet: ImMdnsPacket,
    onPeer?: (peer: { host: string; port: number; txt: Record<string, string> }) => void,
  ): void {
    const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])];
    const targets = new Map<string, { target: string; port: number }>();
    const texts = new Map<string, Record<string, string>>();
    const addresses = new Map<string, string>();
    for (const record of records) {
      if (record.type === "SRV") {
        const srv = srvOf(record);
        if (srv) targets.set(record.name, srv);
      }
      if (record.type === "TXT") texts.set(record.name, txtOf(record.data));
      if (record.type === "A" && typeof record.data === "string") addresses.set(record.name, record.data);
    }
    if (onPeer) {
      for (const [name, srv] of targets) {
        const txt = texts.get(name);
        if (!txt) continue;
        const key = `${txt.peerServerId ?? ""}/${txt.peerAgentId ?? ""}/${srv.target}:${srv.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        onPeer({ host: addresses.get(srv.target) ?? srv.target, port: srv.port, txt });
      }
      return;
    }
    const wanted = (packet.questions ?? []).some((question) => question.name === serviceType);
    if (wanted && announced.size > 0) socket.respond({ answers: answers() });
  }

  return {
    announce(input) {
      announced.set(`${input.name}:${input.port}`, input);
      socket.respond({ answers: answers() });
    },
    browse(onPeer) {
      socket.on("response", (packet) => {
        handle(packet, onPeer);
      });
      socket.on("query", (packet) => {
        handle(packet);
      });
      socket.query({ questions: [{ name: serviceType, type: "PTR" }] });
    },
    stop() {
      socket.destroy();
    },
  };
}
