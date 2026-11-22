import { connect, createServer, type Server, type Socket } from "node:net";
import type { ImSignalEnvelope } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { ImSignalMessage } from "./lan-channel";
import type { ImSignalTransport } from "./lan-gateway";

export interface ImLanSignalEnvelope {
  fromServerId: string;
  fromAgentId: string;
  toServerId: string;
  toAgentId: string;
  signal: ImSignalMessage;
}

export function imSignalEnvelopeToWire(envelope: ImLanSignalEnvelope): ImSignalEnvelope {
  return {
    fromServerId: envelope.fromServerId,
    fromAgentId: envelope.fromAgentId,
    toServerId: envelope.toServerId,
    toAgentId: envelope.toAgentId,
    kind: envelope.signal.kind,
    payload: envelope.signal.payload,
  };
}

export interface ImSignalEndpoint {
  host: string;
  port: number;
}

export class ImSignalServer {
  readonly #onSignal: (envelope: ImLanSignalEnvelope) => void;
  #server: Server | null = null;

  constructor(onSignal: (envelope: ImLanSignalEnvelope) => void) {
    this.#onSignal = onSignal;
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
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
            const envelope = decodeEnvelope(line);
            if (envelope) this.#onSignal(envelope);
          }
        });
        socket.on("error", () => {});
      });
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => {
        const address = server.address();
        this.#server = server;
        resolve(typeof address === "object" && address !== null ? address.port : port);
      });
    });
  }

  stop(): void {
    this.#server?.close();
    this.#server = null;
  }
}

export function createSignalTransport(options: {
  localServerId: string;
  localAgentId: string;
  endpointOf: (input: { peerServerId: string; peerAgentId: string }) => ImSignalEndpoint | null;
  relay?: (envelope: ImLanSignalEnvelope) => void | Promise<void>;
}): ImSignalTransport {
  return {
    send(input) {
      const endpoint = options.endpointOf({ peerServerId: input.peerServerId, peerAgentId: input.peerAgentId });
      const envelope: ImLanSignalEnvelope = {
        fromServerId: options.localServerId,
        fromAgentId: options.localAgentId,
        toServerId: input.peerServerId,
        toAgentId: input.peerAgentId,
        signal: input.signal,
      };
      if (!endpoint) {
        if (options.relay) return options.relay(envelope);
        throw new Error("im.peerOffline");
      }
      return new Promise<void>((resolve, reject) => {
        const socket: Socket = connect(endpoint.port, endpoint.host, () => {
          socket.write(`${JSON.stringify(envelope)}\n`);
          socket.end();
          resolve();
        });
        socket.once("error", (error) => {
          if (options.relay) {
            void options.relay(envelope);
            resolve();
            return;
          }
          reject(error);
        });
      });
    },
  };
}

function decodeEnvelope(line: string): ImLanSignalEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isDynamicRecord(parsed)) return null;
  const entry = parsed;
  const signal = entry.signal;
  if (!isDynamicRecord(signal)) return null;
  const message = signal;
  if (
    typeof entry.fromServerId !== "string" ||
    typeof entry.fromAgentId !== "string" ||
    typeof entry.toServerId !== "string" ||
    typeof entry.toAgentId !== "string" ||
    typeof message.payload !== "string"
  ) {
    return null;
  }
  if (message.kind !== "offer" && message.kind !== "answer" && message.kind !== "candidate") return null;
  return {
    fromServerId: entry.fromServerId,
    fromAgentId: entry.fromAgentId,
    toServerId: entry.toServerId,
    toAgentId: entry.toAgentId,
    signal: { kind: message.kind, payload: message.payload },
  };
}
