import type { DatabaseSync } from "node:sqlite";
import { imEnvelopeNonce, sealImEnvelope } from "@openbot/contracts/im-envelope";
import { databaseRow } from "../database/database-rows";
import { ImLanDiscovery, type ImLanPeer, type ImMdnsResponder, type ImTurnConfig } from "./lan";
import { ImLanChannel, type ImPeerConnectionFactory, type ImSignalMessage } from "./lan-channel";
import { IM_LAN_PEER_OFFLINE, type ImLanDeliverInput, type ImLanDeliverPort, ImLanUndelivered } from "./lan-outbox";
import { createSignalTransport, type ImLanSignalEnvelope, ImSignalServer } from "./lan-signal";
import { ImRelayService } from "./relay";
import { decodeImWireFrame, ImWireForwarder } from "./wire";

export interface ImSignalTransport {
  send(input: { peerServerId: string; peerAgentId: string; signal: ImSignalMessage }): void | Promise<void>;
}

export interface ImLanGatewayOptions {
  db: DatabaseSync;
  localServerId: string;
  signal?: ImSignalTransport | null;
  factory?: ImPeerConnectionFactory | null;
  responder?: ImMdnsResponder | null;
  turn?: ImTurnConfig | null;
  localAgentId?: string;
  localDeviceId?: string | null;
  deviceKeyOf?: (input: { peerServerId: string; peerAgentId: string }) => string | null;
}

function peerKey(peerServerId: string, peerAgentId: string): string {
  return `${peerServerId}/${peerAgentId}`;
}

export class ImLanGateway {
  readonly discovery: ImLanDiscovery;
  onPeerOnline: ((peer: { peerServerId: string; peerAgentId: string }) => void) | null = null;
  #signalRelay: ((envelope: ImLanSignalEnvelope) => void | Promise<void>) | null = null;
  readonly #db: DatabaseSync;
  readonly #localServerId: string;
  readonly #factory: ImPeerConnectionFactory | null;
  readonly #deviceKeyOf: (input: { peerServerId: string; peerAgentId: string }) => string | null;
  readonly #localAgentId: string;
  readonly #localDeviceId: string | null;
  readonly #signal: ImSignalTransport;
  readonly #signalServer = new ImSignalServer((envelope) => {
    void this.receiveSignal({
      peerServerId: envelope.fromServerId,
      peerAgentId: envelope.fromAgentId,
      signal: envelope.signal,
    });
  });
  readonly #turn: ImTurnConfig | null;
  readonly #forwarder: ImWireForwarder;
  readonly #relay: ImRelayService;
  readonly #channels = new Map<string, ImLanChannel>();

  constructor(options: ImLanGatewayOptions) {
    this.#db = options.db;
    this.#localServerId = options.localServerId;
    this.#factory = options.factory ?? null;
    this.#deviceKeyOf =
      options.deviceKeyOf ??
      ((input) => {
        const row = databaseRow(
          this.#db
            .prepare(
              `SELECT public_key FROM peers_devices
               WHERE peer_server_id = ? AND peer_agent_id = ? AND revoked_at IS NULL
               ORDER BY device_id LIMIT 1`,
            )
            .get(input.peerServerId, input.peerAgentId),
        );
        return row && typeof row.public_key === "string" ? row.public_key : null;
      });
    this.#localAgentId = options.localAgentId ?? "me";
    this.#localDeviceId = options.localDeviceId ?? null;
    this.#signal =
      options.signal ??
      createSignalTransport({
        localServerId: options.localServerId,
        localAgentId: options.localAgentId ?? "me",
        endpointOf: (input) => {
          const peer = this.peer(input.peerServerId, input.peerAgentId);
          return peer ? { host: peer.host, port: peer.port } : null;
        },
        relay: (envelope) => {
          const relay = this.#signalRelay;
          if (!relay) throw new ImLanUndelivered("im.peerOffline");
          return relay(envelope);
        },
      });
    this.#turn = options.turn ?? null;
    this.#forwarder = new ImWireForwarder(options.db, options.localServerId);
    this.#relay = new ImRelayService(options.db, options.localServerId);
    this.discovery = new ImLanDiscovery({
      responder: options.responder ?? null,
      turn: options.turn ?? null,
      onPeerOnline: (peer) => {
        this.open(peer.peerServerId, peer.peerAgentId);
        this.onPeerOnline?.(peer);
      },
    });
  }

  async start(input: { name: string; publicKey: string; port?: number }): Promise<number> {
    const port = await this.#signalServer.listen(input.port ?? 0);
    this.discovery.announce({
      name: input.name,
      port,
      peerServerId: this.#localServerId,
      peerAgentId: input.name,
      publicKey: input.publicKey,
    });
    this.discovery.browse();
    return port;
  }

  stop(): void {
    this.#signalServer.stop();
    this.discovery.stop();
    for (const channel of this.#channels.values()) channel.close();
    this.#channels.clear();
  }

  get transport(): "direct" | "turn" {
    return this.#turn ? "turn" : "direct";
  }

  deliver: ImLanDeliverPort = async (input: ImLanDeliverInput): Promise<void> => {
    const channel = this.#channels.get(peerKey(input.peerServerId, input.peerAgentId));
    if (channel?.state !== "open") throw new ImLanUndelivered(IM_LAN_PEER_OFFLINE);
    const deviceKey = this.#deviceKeyOf({ peerServerId: input.peerServerId, peerAgentId: input.peerAgentId });
    if (!deviceKey) throw new ImLanUndelivered(IM_LAN_PEER_OFFLINE);
    const sealed = await sealImEnvelope(deviceKey, imEnvelopeNonce(input.threadId, input.deliveryId), {
      kind: "message",
      remoteMessageId: input.remoteMessageId,
      body: input.body,
      sentAt: input.sentAt,
      deviceId: null,
      causalChainId: null,
    });
    channel.send(
      decodeImWireFrame({
        type: "forward",
        fromServerId: this.#localServerId,
        fromAgentId: input.memberId,
        toServerId: input.peerServerId,
        toAgentId: input.peerAgentId,
        sealed,
        nonce: input.nonce,
        remoteMessageId: input.remoteMessageId,
        sentAt: input.sentAt,
      }),
    );
  };

  setSignalRelay(relay: (envelope: ImLanSignalEnvelope) => void | Promise<void>): void {
    this.#signalRelay = relay;
  }

  channelState(peerServerId: string, peerAgentId: string): string {
    return this.#channels.get(peerKey(peerServerId, peerAgentId))?.state ?? "idle";
  }

  open(peerServerId: string, peerAgentId: string): ImLanChannel | null {
    const channel = this.#attach(peerServerId, peerAgentId);
    if (channel) void channel.open();
    return channel;
  }

  #attach(peerServerId: string, peerAgentId: string): ImLanChannel | null {
    const key = peerKey(peerServerId, peerAgentId);
    const existing = this.#channels.get(key);
    if (existing) return existing;
    const peer = this.peer(peerServerId, peerAgentId);
    if (!peer?.trusted) return null;
    const channel = new ImLanChannel({
      peer,
      fingerprint: peer.fingerprint,
      turn: this.#turn,
      factory: (iceServers) => {
        const factory = this.#factory;
        if (!factory) throw new ImLanUndelivered(IM_LAN_PEER_OFFLINE);
        return factory(iceServers);
      },
      onSignal: (signal) => {
        void this.#signal.send({ peerServerId, peerAgentId, signal });
      },
      onFrame: (frame) => {
        this.receive(this.#localAgentId, frame);
      },
    });
    this.#channels.set(key, channel);
    return channel;
  }

  async receiveSignal(input: { peerServerId: string; peerAgentId: string; signal: ImSignalMessage }): Promise<void> {
    let channel =
      this.#channels.get(peerKey(input.peerServerId, input.peerAgentId)) ??
      this.#attach(input.peerServerId, input.peerAgentId);
    for (let round = 0; round < 40 && !channel; round += 1) {
      await new Promise((done) => setTimeout(done, 50));
      channel = this.#attach(input.peerServerId, input.peerAgentId);
    }
    if (!channel) throw new ImLanUndelivered("im.notVerified");
    await channel.accept(input.signal);
  }

  receive(memberId: string, value: unknown): void {
    const frame = decodeImWireFrame(value);
    if (frame.toServerId !== this.#localServerId) {
      this.#relay.relay(memberId, {
        frame,
        deviceIds: [frame.toAgentId],
        at: frame.sentAt,
        expiresAt: frame.sentAt,
      });
      return;
    }
    this.#forwarder.forward(memberId, {
      frame,
      deviceIds: [this.#localDeviceId ?? frame.toAgentId],
      at: frame.sentAt,
      expiresAt: frame.sentAt,
    });
  }

  peer(peerServerId: string, peerAgentId: string): ImLanPeer | undefined {
    return this.discovery
      .discovered()
      .find((peer) => peer.peerServerId === peerServerId && peer.peerAgentId === peerAgentId);
  }

  close(peerServerId: string, peerAgentId: string): void {
    const key = peerKey(peerServerId, peerAgentId);
    this.#channels.get(key)?.close();
    this.#channels.delete(key);
  }
}
