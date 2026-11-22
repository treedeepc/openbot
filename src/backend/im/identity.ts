import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

export const IM_DEVICE_STATES = ["pending", "active", "revoked"] as const;
export type ImDeviceState = (typeof IM_DEVICE_STATES)[number];

export interface ImRootIdentity {
  publicKey: string;
  privateKey: string;
}

export interface ImDeviceCertificate {
  deviceId: string;
  publicKey: string;
  rootPublicKey: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface ImDeviceRecord {
  localServerId: string;
  localMemberId: string;
  deviceId: string;
  publicKey: string;
  status: ImDeviceState;
  cert: ImDeviceCertificate | null;
  enrolledAt: number | null;
  revokedAt: number | null;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
}

export class ImPairingExpired extends Error {
  constructor() {
    super("im.pairingExpired");
    this.name = "ImPairingExpired";
  }
}

export class ImPairingRateLimited extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("im.rateLimited");
    this.name = "ImPairingRateLimited";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ImApprovalRatePort {
  checkApproval(input: { deviceId: string; at: number }): { allowed: boolean; retryAfterMs: number };
  recordApprovalFailure(input: { deviceId: string; at: number }): void;
}

export class ImDeviceUnknown extends Error {
  constructor() {
    super("im.deviceUnknown");
    this.name = "ImDeviceUnknown";
  }
}

export class ImEnrollPending extends Error {
  constructor() {
    super("im.enrollPending");
    this.name = "ImEnrollPending";
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1)
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

export function createImIdentity(): ImRootIdentity {
  const privateKey = ed25519.utils.randomSecretKey();
  return { privateKey: toHex(privateKey), publicKey: toHex(ed25519.getPublicKey(privateKey)) };
}

export function imNewPairingCode(): string {
  const hex = toHex(randomBytes(4));
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`.toUpperCase();
}

export function imFingerprint(publicKey: string): string {
  const bytes = fromHex(publicKey);
  const groups: string[] = [];
  for (let index = 0; index < 8; index += 1) groups.push(toHex(bytes.slice(index * 4, index * 4 + 4)).slice(0, 4));
  return groups.join(" ").toUpperCase();
}

function certBody(certificate: Omit<ImDeviceCertificate, "signature">): string {
  return [
    "openbot-im-device-cert-v1",
    certificate.deviceId,
    certificate.publicKey,
    certificate.rootPublicKey,
    String(certificate.issuedAt),
    String(certificate.expiresAt),
  ].join("\n");
}

export function issueDeviceCertificate(
  root: ImRootIdentity,
  input: { deviceId: string; publicKey: string; issuedAt: number; expiresAt: number },
): ImDeviceCertificate {
  const unsigned = {
    deviceId: input.deviceId,
    publicKey: input.publicKey,
    rootPublicKey: root.publicKey,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
  const signature = toHex(ed25519.sign(new TextEncoder().encode(certBody(unsigned)), fromHex(root.privateKey)));
  return { ...unsigned, signature };
}

export function verifyDeviceCertificate(
  certificate: ImDeviceCertificate,
  now: number,
  trustedRootPublicKey: string,
): boolean {
  if (certificate.expiresAt <= now) return false;
  if (certificate.rootPublicKey !== trustedRootPublicKey) return false;
  const { signature, ...unsigned } = certificate;
  return ed25519.verify(
    fromHex(signature),
    new TextEncoder().encode(certBody(unsigned)),
    fromHex(trustedRootPublicKey),
  );
}

export function revokedDeviceCertificate(certificate: ImDeviceCertificate): ImDeviceCertificate {
  return { ...certificate, expiresAt: 0 };
}

export interface ImDeviceStorePort {
  save(record: ImDeviceRecord): void;
  remove(localServerId: string, localMemberId: string, deviceId: string): void;
  read(localServerId: string, localMemberId: string, deviceId: string): ImDeviceRecord | null;
  list(localServerId: string, localMemberId: string): ImDeviceRecord[];
}

export interface ImDeviceScope {
  localServerId: string;
  localMemberId: string;
}

export class ImDeviceScopeRequired extends Error {
  constructor() {
    super("im.protocolError");
    this.name = "ImDeviceScopeRequired";
  }
}

export class ImDeviceRegistry {
  readonly #root: ImRootIdentity;
  readonly #devices = new Map<string, ImDeviceRecord>();
  readonly #store: ImDeviceStorePort | null;
  readonly #scope: ImDeviceScope | null;
  readonly #rate: ImApprovalRatePort | null;

  constructor(root: ImRootIdentity, store?: ImDeviceStorePort, scope?: ImDeviceScope, rate?: ImApprovalRatePort) {
    this.#root = root;
    if (store && !scope) throw new ImDeviceScopeRequired();
    this.#store = store ?? null;
    this.#scope = scope ?? null;
    this.#rate = rate ?? null;
    if (store && scope) {
      for (const record of store.list(scope.localServerId, scope.localMemberId)) {
        this.#devices.set(this.#key(record.deviceId, record), record);
      }
    }
  }

  #key(deviceId: string, record?: Pick<ImDeviceRecord, "localServerId" | "localMemberId">): string {
    const scope = record ?? this.#scope;
    return scope ? `${scope.localServerId}\u0000${scope.localMemberId}\u0000${deviceId}` : deviceId;
  }

  #find(deviceId: string): ImDeviceRecord | undefined {
    const direct = this.#devices.get(this.#key(deviceId));
    if (direct) return direct;
    if (this.#scope) return undefined;
    return [...this.#devices.values()].find((record) => record.deviceId === deviceId);
  }

  #inScope(record: ImDeviceRecord): boolean {
    return this.#scope
      ? record.localServerId === this.#scope.localServerId && record.localMemberId === this.#scope.localMemberId
      : true;
  }

  #persist(record: ImDeviceRecord): ImDeviceRecord {
    this.#devices.set(this.#key(record.deviceId, record), record);
    this.#store?.save(record);
    return { ...record };
  }

  enrollBegin(input: {
    localServerId: string;
    localMemberId: string;
    deviceId: string;
    publicKey: string;
    now: number;
    ttlMs: number;
  }): ImDeviceRecord {
    const existing = this.#find(input.deviceId);
    if (existing && existing.status === "pending") throw new ImEnrollPending();
    const record: ImDeviceRecord = {
      localServerId: input.localServerId,
      localMemberId: input.localMemberId,
      deviceId: input.deviceId,
      publicKey: input.publicKey,
      status: "pending",
      cert: null,
      enrolledAt: null,
      revokedAt: null,
      pairingCode: imNewPairingCode(),
      pairingExpiresAt: input.now + input.ttlMs,
    };
    return this.#persist(record);
  }

  enrollApprove(input: { deviceId: string; pairingCode: string; now: number; ttlMs: number }): ImDeviceRecord {
    const gate = this.#rate?.checkApproval({ deviceId: input.deviceId, at: input.now });
    if (gate && !gate.allowed) throw new ImPairingRateLimited(gate.retryAfterMs);
    try {
      const record = this.#find(input.deviceId);
      if (!record) throw new ImDeviceUnknown();
      if (record.status !== "pending") return { ...record };
      if (record.pairingCode === null || record.pairingExpiresAt === null) throw new ImPairingExpired();
      if (record.pairingExpiresAt <= input.now) throw new ImPairingExpired();
      if (record.pairingCode !== input.pairingCode) throw new ImPairingExpired();
      const cert = issueDeviceCertificate(this.#root, {
        deviceId: record.deviceId,
        publicKey: record.publicKey,
        issuedAt: input.now,
        expiresAt: input.now + input.ttlMs,
      });
      const approved: ImDeviceRecord = {
        ...record,
        status: "active",
        cert,
        enrolledAt: input.now,
        pairingCode: null,
        pairingExpiresAt: null,
      };
      return this.#persist(approved);
    } catch (error) {
      this.#rate?.recordApprovalFailure({ deviceId: input.deviceId, at: input.now });
      throw error;
    }
  }

  enrollStatus(deviceId: string): ImDeviceState {
    const record = this.#find(deviceId);
    if (!record) throw new ImDeviceUnknown();
    return record.status;
  }

  enrollCancel(deviceId: string): void {
    const record = this.#find(deviceId);
    if (!record) throw new ImDeviceUnknown();
    if (record.status !== "pending") return;
    this.#devices.delete(this.#key(deviceId, record));
    this.#store?.remove(record.localServerId, record.localMemberId, deviceId);
  }

  revoke(deviceId: string, now: number): ImDeviceRecord {
    const record = this.#find(deviceId);
    if (!record) throw new ImDeviceUnknown();
    const revoked: ImDeviceRecord = {
      ...record,
      status: "revoked",
      revokedAt: now,
      cert: record.cert ? revokedDeviceCertificate(record.cert) : null,
    };
    return this.#persist(revoked);
  }

  activeDevices(): ImDeviceRecord[] {
    return [...this.#devices.values()].filter((record) => record.status === "active" && this.#inScope(record));
  }

  verifyDevice(deviceId: string, now: number): boolean {
    const record = this.#find(deviceId);
    if (!record) return false;
    if (record.status !== "active" || !record.cert) return false;
    return verifyDeviceCertificate(record.cert, now, this.#root.publicKey);
  }
}
