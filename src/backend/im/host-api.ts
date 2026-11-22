import type { DatabaseSync } from "node:sqlite";
import { isRawP256PublicKey } from "@openbot/contracts/host-grant";
import type { ImKeyAlgorithm, ImNotificationSettings, ImProfile, ImProxySettings } from "@openbot/contracts/ipc";
import { databaseRow, databaseRows } from "../database/database-rows";
import { ImAuditAdmin } from "./audit-admin";
import { ImDeactivateService } from "./deactivate";
import { ImDeviceStore } from "./device-store";
import { type ImDeviceRecord, ImDeviceRegistry, type ImRootIdentity, imFingerprint } from "./identity";
import { ImService } from "./im-service";
import { type ImLanPeerView, type ImMdnsResponder, type ImTurnConfig, lanPeerView } from "./lan";
import type { ImPeerConnectionFactory } from "./lan-channel";
import { ImLanGateway, type ImSignalTransport } from "./lan-gateway";
import {
  IM_LAN_PEER_OFFLINE,
  type ImLanDeliverPort,
  type ImLanDraft,
  ImLanOutbox,
  type ImLanResendResult,
  ImLanUndelivered,
} from "./lan-outbox";
import type { ImLanSignalEnvelope } from "./lan-signal";
import { ImNotificationService } from "./notifications";
import { ImProxySettingsStore } from "./proxy";
import { ImSearchService } from "./search";
import { type ImDirectoryPort, ImDirectoryStore, ImPresenceStore } from "./server-mode";
import { ImRateLimiter, imApprovalRatePort } from "./social";

export interface DeviceView {
  deviceId: string;
  publicKey: string;
  state: string;
  enrolledAt: number | null;
  certExpiresAt: number | null;
  fingerprint: string;
  algorithm: ImKeyAlgorithm | null;
}

export interface ImPeerDeviceView {
  peerServerId: string;
  peerAgentId: string;
  deviceId: string;
  name: string;
  publicKey: string;
  algorithm: string;
  status: string;
  enrolledAt: number | null;
}

export interface EnrollChallengeView {
  deviceId: string;
  pairingCode: string;
  fingerprint: string;
  expiresAt: number;
  devicePublicKey: string;
  algorithm: ImKeyAlgorithm | null;
}

export const IM_ENROLL_TTL_MS = 900_000;

export class ImDevicesUnavailable extends Error {
  constructor() {
    super("im.notRegistered");
    this.name = "ImDevicesUnavailable";
  }
}

function algorithmOf(publicKey: string): ImKeyAlgorithm | null {
  return isRawP256PublicKey(publicKey) ? "p256-base64url" : "ed25519-hex";
}

function toDeviceView(record: ImDeviceRecord): DeviceView {
  return {
    deviceId: record.deviceId,
    publicKey: record.publicKey,
    state: record.status,
    enrolledAt: record.enrolledAt,
    certExpiresAt: record.cert ? record.cert.expiresAt : null,
    fingerprint: imFingerprint(record.publicKey),
    algorithm: algorithmOf(record.publicKey),
  };
}

export interface ImHostApiScope {
  localServerId: string;
  localMemberId: string;
}

export interface ImLanHostOptions {
  responder?: ImMdnsResponder | null;
  turn?: ImTurnConfig | null;
  factory?: ImPeerConnectionFactory | null;
  signal?: ImSignalTransport | null;
  deliver?: ImLanDeliverPort;
}

export class ImHostApi {
  readonly #db: DatabaseSync;
  readonly #localServerId: string;
  readonly #settings: ImProxySettingsStore;
  readonly #notifications: ImNotificationService;
  readonly #directory: ImDirectoryStore;
  readonly #deactivate: ImDeactivateService;
  readonly #presence: ImPresenceStore;
  readonly #audit: ImAuditAdmin;
  readonly #search: ImSearchService;
  readonly #registries = new Map<string, ImDeviceRegistry>();
  readonly #identity: ImRootIdentity | null;
  readonly #peers: ImService;
  readonly #lan: ImLanGateway | null;
  readonly #outbox: ImLanOutbox;

  constructor(
    db: DatabaseSync,
    localServerId: string,
    directoryPort: ImDirectoryPort = {},
    identity: ImRootIdentity | null = null,
    lan: ImLanHostOptions | null = null,
  ) {
    this.#db = db;
    this.#localServerId = localServerId;
    this.#settings = new ImProxySettingsStore(db);
    this.#notifications = new ImNotificationService(db, localServerId);
    this.#directory = new ImDirectoryStore(db, directoryPort);
    this.#deactivate = new ImDeactivateService(db, localServerId, directoryPort);
    this.#presence = new ImPresenceStore(db);
    this.#identity = identity;
    this.#audit = new ImAuditAdmin(db, localServerId);
    this.#search = new ImSearchService(db, localServerId);
    this.#peers = new ImService(db, localServerId);
    const gateway = lan
      ? new ImLanGateway({
          db,
          localServerId,
          factory: lan.factory ?? null,
          signal: lan.signal ?? null,
          responder: lan.responder ?? null,
          turn: lan.turn ?? null,
        })
      : null;
    this.#lan = gateway;
    this.#outbox = new ImLanOutbox(
      db,
      localServerId,
      lan?.deliver ??
        gateway?.deliver ??
        (() => {
          throw new ImLanUndelivered(IM_LAN_PEER_OFFLINE);
        }),
    );
    if (gateway) {
      gateway.onPeerOnline = (peer) => {
        void this.#outbox.onPeerOnline({ ...peer, at: Date.now() });
      };
    }
  }

  scope(memberId: string): ImHostApiScope {
    return { localServerId: this.#localServerId, localMemberId: memberId };
  }

  readProxy(memberId: string): ImProxySettings {
    return this.#settings.read(this.scope(memberId));
  }

  writeProxy(memberId: string, input: Partial<ImProxySettings> & { at: number }): ImProxySettings {
    return this.#settings.write(this.scope(memberId), input);
  }

  readNotifications(memberId: string, threadId: string | null): ImNotificationSettings {
    const over = threadId === null ? null : this.#notifications.override(memberId, threadId);
    const base = this.#notifications.defaults(memberId);
    return {
      threadId,
      notifyOn: over?.notifyOn ?? base.notifyOn,
      showPreview: over?.showPreview ?? base.showPreview,
      mutedUntil: over?.mutedUntil ?? null,
      sendReadReceipts: over?.sendReadReceipts ?? true,
    };
  }

  writeNotifications(memberId: string, input: ImNotificationSettings): ImNotificationSettings {
    if (input.threadId === null) {
      this.#notifications.setDefaults(memberId, { notifyOn: input.notifyOn, showPreview: input.showPreview });
      return { ...input };
    }
    this.#notifications.setOverride(memberId, {
      threadId: input.threadId,
      mutedUntil: input.mutedUntil,
      notifyOn: input.notifyOn,
      showPreview: input.showPreview,
      sendReadReceipts: input.sendReadReceipts ?? null,
    });
    return {
      threadId: input.threadId,
      notifyOn: input.notifyOn,
      showPreview: input.showPreview,
      mutedUntil: input.mutedUntil,
      sendReadReceipts: input.sendReadReceipts ?? true,
    };
  }

  readProfile(memberId: string): ImProfile {
    const peer = { peerServerId: this.#localServerId, peerAgentId: memberId };
    const profile = this.#directory.profile(peer);
    return {
      displayName: profile?.displayName ?? memberId,
      bio: profile?.bio ?? "",
      avatar: profile?.avatar ?? null,
      searchable: this.#searchable(memberId),
      registered: profile !== null,
    };
  }

  updateProfile(
    memberId: string,
    input: { displayName: string; bio: string; avatar: string | null; searchable: boolean },
  ): ImProfile {
    const peer = { peerServerId: this.#localServerId, peerAgentId: memberId };
    this.#db
      .prepare(
        `INSERT INTO directory_profiles (peer_server_id, peer_agent_id, display_name, bio, avatar, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(peer_server_id, peer_agent_id) DO UPDATE SET display_name = excluded.display_name,
           bio = excluded.bio, avatar = excluded.avatar, updated_at = excluded.updated_at`,
      )
      .run(peer.peerServerId, peer.peerAgentId, input.displayName, input.bio, input.avatar, Date.now());
    this.#db
      .prepare(
        `INSERT INTO audit_aggregates (local_server_id, local_member_id, bucket, actor_id, action, target_id, result,
          count, first_at, last_at, summary)
         VALUES (?, ?, ?, ?, 'im.profileSearchable', ?, ?, 1, ?, ?, NULL)
         ON CONFLICT(local_server_id, local_member_id, bucket, actor_id, action, target_id, result) DO UPDATE SET
           count = audit_aggregates.count + 1, last_at = excluded.last_at`,
      )
      .run(
        this.#localServerId,
        memberId,
        "settings",
        memberId,
        memberId,
        input.searchable ? "on" : "off",
        Date.now(),
        Date.now(),
      );
    return this.readProfile(memberId);
  }

  readPresence(
    memberId: string,
    peers: readonly { peerServerId: string; peerAgentId: string }[],
    at: number,
  ): { items: { peerServerId: string; peerAgentId: string; state: string; hidden: boolean }[]; next: null } {
    const items = peers.map((peer) => {
      const view = this.#presence.visible(this.scope(memberId), peer, at);
      return { peerServerId: view.peerServerId, peerAgentId: view.peerAgentId, state: view.state, hidden: view.hidden };
    });
    return { items, next: null };
  }

  setHidden(memberId: string, input: { hidden: boolean; at: number }): { hidden: boolean } {
    const peer = { peerServerId: this.#localServerId, peerAgentId: memberId };
    this.#presence.hide(peer, input.hidden, input.at);
    return { hidden: this.#presence.current(peer).hidden };
  }

  listAudit(
    memberId: string,
    input: { cursor?: string; action: string | null; from: number | null; to: number | null },
  ): {
    items: { id: string; action: string; targetId: string; result: string; at: number }[];
    next: null;
  } {
    const entries = this.#audit.export(memberId, { from: input.from, to: input.to, format: "json" });
    const parsed: {
      entries: { id: string; action: string; targetId: string; result: string; at: number }[];
    } = JSON.parse(entries);
    return {
      items: parsed.entries.filter((entry) => input.action === null || entry.action === input.action),
      next: null,
    };
  }

  exportAudit(memberId: string, input: { from: number | null; to: number | null; format: "json" | "csv" }): string {
    return this.#audit.export(memberId, input);
  }

  search(memberId: string, q: string, at: number): ReturnType<ImSearchService["search"]> {
    return this.#search.search(memberId, { q, at });
  }

  deactivate(memberId: string, at: number): ReturnType<ImDeactivateService["deactivate"]> {
    return this.#deactivate.deactivate(memberId, { at });
  }

  lanDrafts(memberId: string, input: { threadId?: string } = {}): ImLanDraft[] {
    return this.#outbox.drafts(memberId, input);
  }

  lanResend(memberId: string, input: { deliveryId: string; at: number }): Promise<ImLanResendResult> {
    return this.#outbox.resend(memberId, input);
  }

  lanPeerOnline(input: { peerServerId: string; peerAgentId: string; at: number }): Promise<ImLanResendResult[]> {
    return this.#outbox.onPeerOnline(input);
  }

  lanBrowse(): void {
    this.#lan?.discovery.browse();
  }

  setSignalRelay(relay: (envelope: ImLanSignalEnvelope) => void | Promise<void>): void {
    this.#lan?.setSignalRelay(relay);
  }

  lanSignal(input: {
    peerServerId: string;
    peerAgentId: string;
    signal: { kind: "offer" | "answer" | "candidate"; payload: string };
  }): Promise<void> | null {
    return this.#lan?.receiveSignal(input) ?? null;
  }

  peerDevices(peer: { peerServerId: string; peerAgentId: string }): { items: ImPeerDeviceView[]; next: null } {
    const rows = databaseRows(
      this.#db
        .prepare(
          `SELECT device_id, public_key, cert_ref, revoked_at FROM peers_devices
           WHERE peer_server_id = ? AND peer_agent_id = ? ORDER BY device_id`,
        )
        .all(peer.peerServerId, peer.peerAgentId),
    );
    return {
      items: rows.map((row) => ({
        peerServerId: peer.peerServerId,
        peerAgentId: peer.peerAgentId,
        deviceId: String(row.device_id),
        name: String(row.device_id),
        publicKey: String(row.public_key),
        algorithm: isRawP256PublicKey(String(row.public_key)) ? "p256-base64url" : "ed25519-hex",
        status: row.revoked_at === null || row.revoked_at === undefined ? "active" : "revoked",
        enrolledAt: null,
      })),
      next: null,
    };
  }

  lanStart(input: { name: string; publicKey: string; port?: number }): Promise<number> | null {
    return this.#lan?.start(input) ?? null;
  }

  lanStop(): void {
    this.#lan?.stop();
  }

  lanPeers(memberId: string): { items: ImLanPeerView[]; next: null } {
    const gateway = this.#lan;
    if (!gateway) return { items: [], next: null };
    const items = gateway.discovery
      .discovered()
      .filter((peer) =>
        this.#peers.visiblePeer(memberId, { peerServerId: peer.peerServerId, peerAgentId: peer.peerAgentId }),
      )
      .map(lanPeerView);
    return { items, next: null };
  }

  #registry(memberId: string): ImDeviceRegistry {
    const existing = this.#registries.get(memberId);
    if (existing) return existing;
    const identity = this.#identity;
    if (!identity) throw new ImDevicesUnavailable();
    const scope = this.scope(memberId);
    const created = new ImDeviceRegistry(
      identity,
      new ImDeviceStore(this.#db),
      scope,
      imApprovalRatePort(new ImRateLimiter(this.#db), scope),
    );
    this.#registries.set(memberId, created);
    return created;
  }

  listDevices(memberId: string): { items: DeviceView[]; next: null } {
    return {
      items: new ImDeviceStore(this.#db).list(this.#localServerId, memberId).map(toDeviceView),
      next: null,
    };
  }

  enrollBegin(memberId: string, input: { deviceName: string; publicKey: string; now: number }): EnrollChallengeView {
    const record = this.#registry(memberId).enrollBegin({
      ...this.scope(memberId),
      deviceId: input.deviceName,
      publicKey: input.publicKey,
      now: input.now,
      ttlMs: IM_ENROLL_TTL_MS,
    });
    return {
      deviceId: record.deviceId,
      pairingCode: record.pairingCode ?? "",
      fingerprint: imFingerprint(record.publicKey),
      expiresAt: record.pairingExpiresAt ?? input.now + IM_ENROLL_TTL_MS,
      devicePublicKey: record.publicKey,
      algorithm: algorithmOf(record.publicKey),
    };
  }

  enrollApprove(memberId: string, input: { deviceId: string; pairingCode: string; now: number }): DeviceView {
    return toDeviceView(this.#registry(memberId).enrollApprove({ ...input, ttlMs: IM_ENROLL_TTL_MS }));
  }

  enrollStatus(memberId: string, input: { deviceId: string }): { deviceId: string; state: string } {
    return { deviceId: input.deviceId, state: this.#registry(memberId).enrollStatus(input.deviceId) };
  }

  enrollCancel(memberId: string, input: { deviceId: string }): { deviceId: string; cancelled: boolean } {
    this.#registry(memberId).enrollCancel(input.deviceId);
    return { deviceId: input.deviceId, cancelled: true };
  }

  deviceRevoke(memberId: string, input: { deviceId: string; now: number }): DeviceView {
    return toDeviceView(this.#registry(memberId).revoke(input.deviceId, input.now));
  }

  #searchable(memberId: string): boolean {
    const row = databaseRow(
      this.#db
        .prepare(
          `SELECT result FROM audit_aggregates WHERE local_server_id = ? AND local_member_id = ? AND bucket = 'settings'
           AND actor_id = ? AND action = 'im.profileSearchable' AND target_id = ?
         ORDER BY last_at DESC LIMIT 1`,
        )
        .get(this.#localServerId, memberId, memberId, memberId),
    );
    return row ? String(row.result) === "on" : false;
  }
}
