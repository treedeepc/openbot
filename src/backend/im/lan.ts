import { imFingerprint } from "./identity";

export const IM_LAN_SERVICE_TYPE = "openbot-im";
export const IM_LAN_PROTOCOL = "tcp";

export interface ImTurnConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface ImLanPeer {
  host: string;
  port: number;
  peerServerId: string;
  peerAgentId: string;
  publicKey: string;
  fingerprint: string;
  trusted: boolean;
  transport: "direct" | "turn";
}

export interface ImLanPeerView {
  peerServerId: string;
  peerAgentId: string;
  host: string;
  port: number;
  fingerprint: string;
  trusted: boolean;
  transport: "direct" | "turn";
}

export function lanPeerView(peer: ImLanPeer): ImLanPeerView {
  return {
    peerServerId: peer.peerServerId,
    peerAgentId: peer.peerAgentId,
    host: peer.host,
    port: peer.port,
    fingerprint: peer.fingerprint,
    trusted: peer.trusted,
    transport: peer.transport,
  };
}

export class ImFingerprintMismatch extends Error {
  constructor() {
    super("im.confirmMismatch");
    this.name = "ImFingerprintMismatch";
  }
}

export class ImLanPeerUnverified extends Error {
  constructor() {
    super("im.notVerified");
    this.name = "ImLanPeerUnverified";
  }
}

export interface ImMdnsResponder {
  announce(input: { name: string; port: number; txt: Record<string, string> }): void;
  browse(onPeer: (peer: { host: string; port: number; txt: Record<string, string> }) => void): void;
  stop(): void;
}

function txtOf(entry: { txt: Record<string, string> }): {
  peerServerId: string;
  peerAgentId: string;
  publicKey: string;
} {
  const peerServerId = entry.txt.peerServerId ?? "";
  const peerAgentId = entry.txt.peerAgentId ?? "";
  const publicKey = entry.txt.publicKey ?? "";
  return { peerServerId, peerAgentId, publicKey };
}

export class ImLanDiscovery {
  readonly #responder: ImMdnsResponder | null;
  readonly #turn: ImTurnConfig | null;
  readonly #onPeerOnline: ((peer: { peerServerId: string; peerAgentId: string }) => void) | null;
  readonly #peers = new Map<string, ImLanPeer>();

  constructor(
    options: {
      responder?: ImMdnsResponder | null;
      turn?: ImTurnConfig | null;
      onPeerOnline?: (peer: { peerServerId: string; peerAgentId: string }) => void;
    } = {},
  ) {
    this.#responder = options.responder ?? null;
    this.#turn = options.turn ?? null;
    this.#onPeerOnline = options.onPeerOnline ?? null;
  }

  announce(input: { name: string; port: number; peerServerId: string; peerAgentId: string; publicKey: string }): void {
    this.#responder?.announce({
      name: input.name,
      port: input.port,
      txt: {
        peerServerId: input.peerServerId,
        peerAgentId: input.peerAgentId,
        publicKey: input.publicKey,
      },
    });
  }

  browse(): void {
    this.#responder?.browse((entry) => {
      const identity = txtOf(entry);
      if (!identity.peerServerId || !identity.peerAgentId || !identity.publicKey) return;
      const key = `${identity.peerServerId}/${identity.peerAgentId}`;
      const known = this.#peers.get(key);
      const fingerprint = imFingerprint(identity.publicKey);
      const peer: ImLanPeer = {
        host: entry.host,
        port: entry.port,
        ...identity,
        fingerprint,
        trusted: known ? known.trusted && known.fingerprint === fingerprint : false,
        transport: this.#turn ? "turn" : "direct",
      };
      this.#peers.set(key, peer);
      if (!known || known.host !== peer.host || known.port !== peer.port || known.fingerprint !== fingerprint) {
        this.#onPeerOnline?.({ peerServerId: identity.peerServerId, peerAgentId: identity.peerAgentId });
      }
    });
  }

  stop(): void {
    this.#responder?.stop();
  }

  discovered(): ImLanPeer[] {
    return [...this.#peers.values()].map((peer) => ({ ...peer }));
  }

  verify(peer: { peerServerId: string; peerAgentId: string }, fingerprint: string): ImLanPeer {
    const known = this.#peers.get(`${peer.peerServerId}/${peer.peerAgentId}`);
    if (!known) throw new ImLanPeerUnverified();
    if (known.fingerprint !== fingerprint) throw new ImFingerprintMismatch();
    const trusted: ImLanPeer = { ...known, trusted: true };
    this.#peers.set(`${peer.peerServerId}/${peer.peerAgentId}`, trusted);
    return trusted;
  }

  connect(peer: { peerServerId: string; peerAgentId: string }): ImLanPeer {
    const known = this.#peers.get(`${peer.peerServerId}/${peer.peerAgentId}`);
    if (!known) throw new ImLanPeerUnverified();
    if (!known.trusted) throw new ImLanPeerUnverified();
    return { ...known };
  }
}
