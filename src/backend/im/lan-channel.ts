import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { ImLanPeer, ImTurnConfig } from "./lan";

export const IM_LAN_CHANNEL_LABEL = "openbot-im";

export type ImSignalMessage =
  | { kind: "offer"; payload: string }
  | { kind: "answer"; payload: string }
  | { kind: "candidate"; payload: string };

export interface ImDataChannelLike {
  readyState: string;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

export interface ImPeerConnectionLike {
  createDataChannel(label: string, options?: { ordered?: boolean }): ImDataChannelLike;
  createOffer(): Promise<{ type: string; sdp: string }>;
  createAnswer(): Promise<{ type: string; sdp: string }>;
  setLocalDescription(description: { type: string; sdp: string }): Promise<void>;
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void>;
  addIceCandidate(candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }): Promise<void>;
  close(): void;
  onicecandidate:
    | ((event: {
        candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null;
      }) => void)
    | null;
  ondatachannel: ((event: { channel: ImDataChannelLike }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  connectionState: string;
}

export type ImPeerConnectionFactory = (
  iceServers: { urls: string[]; username?: string; credential?: string }[],
) => ImPeerConnectionLike;

export class ImLanChannelRefused extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "ImLanChannelRefused";
    this.reason = reason;
  }
}

function turnServers(
  turn: ImTurnConfig | null | undefined,
): { urls: string[]; username?: string; credential?: string }[] {
  if (!turn) return [];
  return [
    {
      urls: turn.urls,
      ...(turn.username === undefined ? {} : { username: turn.username }),
      ...(turn.credential === undefined ? {} : { credential: turn.credential }),
    },
  ];
}

function asRecord(value: unknown): DynamicRecord {
  if (!isDynamicRecord(value)) throw new ImLanChannelRefused("im.protocolError");
  return value;
}

function parseDescription(value: string): { type: string; sdp: string } {
  const entry: DynamicRecord = asRecord(JSON.parse(value));
  if (typeof entry.type !== "string" || typeof entry.sdp !== "string")
    throw new ImLanChannelRefused("im.protocolError");
  return { type: entry.type, sdp: entry.sdp };
}

function parseCandidate(value: string): { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } {
  const entry: DynamicRecord = asRecord(JSON.parse(value));
  if (typeof entry.candidate !== "string") throw new ImLanChannelRefused("im.protocolError");
  return {
    candidate: entry.candidate,
    sdpMid: typeof entry.sdpMid === "string" ? entry.sdpMid : null,
    sdpMLineIndex: typeof entry.sdpMLineIndex === "number" ? entry.sdpMLineIndex : null,
  };
}

export class ImLanChannel {
  readonly #peer: ImLanPeer;
  readonly #fingerprint: string;
  readonly #turn: ImTurnConfig | null;
  readonly #factory: ImPeerConnectionFactory;
  readonly #onSignal: (signal: ImSignalMessage) => void;
  readonly #onFrame: (frame: unknown) => void;
  #connection: ImPeerConnectionLike | null = null;
  #channel: ImDataChannelLike | null = null;
  #pending: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }[] = [];
  #hasRemote = false;

  constructor(options: {
    peer: ImLanPeer;
    fingerprint: string;
    turn?: ImTurnConfig | null;
    factory: ImPeerConnectionFactory;
    onSignal: (signal: ImSignalMessage) => void;
    onFrame: (frame: unknown) => void;
  }) {
    this.#peer = options.peer;
    this.#fingerprint = options.fingerprint;
    this.#turn = options.turn ?? null;
    this.#factory = options.factory;
    this.#onSignal = options.onSignal;
    this.#onFrame = options.onFrame;
  }

  get transport(): "direct" | "turn" {
    return this.#turn ? "turn" : "direct";
  }

  get state(): string {
    return this.#channel ? this.#channel.readyState : "idle";
  }

  async open(): Promise<void> {
    this.#assertTrusted();
    const connection = this.#factory(turnServers(this.#turn));
    this.#connection = connection;
    connection.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.#onSignal({
        kind: "candidate",
        payload: JSON.stringify({
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        }),
      });
    };
    const channel = connection.createDataChannel(IM_LAN_CHANNEL_LABEL, { ordered: true });
    this.#bind(channel);
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    this.#onSignal({ kind: "offer", payload: JSON.stringify(offer) });
  }

  async accept(signal: ImSignalMessage): Promise<void> {
    this.#assertTrusted();
    if (signal.kind === "offer") {
      const connection = this.#factory(turnServers(this.#turn));
      this.#connection = connection;
      connection.onicecandidate = (event) => {
        if (!event.candidate) return;
        this.#onSignal({
          kind: "candidate",
          payload: JSON.stringify({
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          }),
        });
      };
      connection.ondatachannel = (event) => this.#bind(event.channel);
      const offer = parseDescription(signal.payload);
      await connection.setRemoteDescription(offer);
      this.#hasRemote = true;
      await this.#flush(connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      this.#onSignal({ kind: "answer", payload: JSON.stringify(answer) });
      return;
    }
    const connection = this.#connection;
    if (!connection) throw new ImLanChannelRefused("im.protocolError");
    if (signal.kind === "answer") {
      await connection.setRemoteDescription(parseDescription(signal.payload));
      this.#hasRemote = true;
      await this.#flush(connection);
      return;
    }
    const candidate = parseCandidate(signal.payload);
    if (!this.#hasRemote) {
      this.#pending.push(candidate);
      return;
    }
    await connection.addIceCandidate({ ...candidate, sdpMLineIndex: candidate.sdpMLineIndex ?? 0 });
  }

  send(frame: unknown): void {
    const channel = this.#channel;
    if (!channel) throw new ImLanChannelRefused("im.notDelivered");
    if (channel.readyState !== "open") throw new ImLanChannelRefused("im.notDelivered");
    channel.send(JSON.stringify(frame));
  }

  close(): void {
    this.#channel?.close();
    this.#connection?.close();
    this.#channel = null;
    this.#connection = null;
  }

  async #flush(connection: ImPeerConnectionLike): Promise<void> {
    const pending = this.#pending;
    this.#pending = [];
    for (const candidate of pending) {
      await connection.addIceCandidate({ ...candidate, sdpMLineIndex: candidate.sdpMLineIndex ?? 0 });
    }
  }

  #bind(channel: ImDataChannelLike): void {
    this.#channel = channel;
    channel.onmessage = (event) => {
      this.#onFrame(typeof event.data === "string" ? JSON.parse(event.data) : event.data);
    };
  }

  #assertTrusted(): void {
    if (!this.#peer.trusted) throw new ImLanChannelRefused("im.notVerified");
    if (this.#peer.fingerprint !== this.#fingerprint) throw new ImLanChannelRefused("im.confirmMismatch");
  }
}
