import type { DatabaseSync } from "node:sqlite";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { databaseRow } from "../database/database-rows";
import { ImAuditLog } from "./audit";
import { ImNotificationService, type ImNotifyOn } from "./notifications";
import { type ImProxySettings, ImProxySettingsStore } from "./proxy";
import { ImBlockStore, ImContactStore, type ImSocialScope } from "./social";

export interface ImSyncPeer {
  peerServerId: string;
  peerAgentId: string;
}

export interface ImContactSyncEntry {
  peer: ImSyncPeer;
  state: "pending" | "accepted" | "removed";
  updatedAt: number;
}

export interface ImBlockSyncEntry {
  peer: ImSyncPeer;
  reason: string | null;
  addedAt: number;
}

export interface ImSyncResult<T> {
  merged: T[];
  kept: number;
  replaced: number;
  audited: string;
}

export class ImSyncService {
  readonly #db: DatabaseSync;
  readonly #localServerId: string;
  readonly #contacts: ImContactStore;
  readonly #blocks: ImBlockStore;
  readonly #settings: ImProxySettingsStore;
  readonly #notifications: ImNotificationService;
  readonly #audit: ImAuditLog;

  constructor(db: DatabaseSync, localServerId: string) {
    this.#db = db;
    this.#localServerId = localServerId;
    this.#contacts = new ImContactStore(db);
    this.#blocks = new ImBlockStore(db);
    this.#settings = new ImProxySettingsStore(db);
    this.#notifications = new ImNotificationService(db, localServerId);
    this.#audit = new ImAuditLog(db);
  }

  scope(memberId: string): ImSocialScope {
    return { localServerId: this.#localServerId, localMemberId: memberId };
  }

  mergeContacts(
    memberId: string,
    input: { entries: ImContactSyncEntry[]; deviceId: string; at: number },
  ): ImSyncResult<ImContactSyncEntry> {
    const scope = this.scope(memberId);
    const merged: ImContactSyncEntry[] = [];
    const seen = new Set<string>();
    let replaced = 0;
    for (const entry of input.entries) {
      const key = `${entry.peer.peerServerId}/${entry.peer.peerAgentId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = this.#contacts.find(scope, entry.peer);
      if (!existing || entry.updatedAt >= existing.updatedAt) {
        if (existing && entry.updatedAt >= existing.updatedAt && existing.state !== entry.state) replaced += 1;
        const saved = existing ? this.#applyState(scope, entry, existing) : this.#createWithState(scope, entry);
        merged.push({ peer: entry.peer, state: saved.state, updatedAt: entry.updatedAt });
      } else if (existing) {
        merged.push({ peer: entry.peer, state: existing.state, updatedAt: existing.updatedAt });
      }
    }
    const audited = this.#record(memberId, "im.syncContacts", input.deviceId, input.at, {
      entries: merged.length,
      replaced,
    });
    return { merged, kept: merged.length - replaced, replaced, audited };
  }

  mergeBlocklist(
    memberId: string,
    input: { entries: ImBlockSyncEntry[]; deviceId: string; at: number },
  ): ImSyncResult<ImBlockSyncEntry> {
    const scope = this.scope(memberId);
    const merged: ImBlockSyncEntry[] = [];
    for (const entry of input.entries) {
      const rule = this.#blocks.add({
        ...scope,
        ruleId: `b-${entry.peer.peerServerId}-${entry.peer.peerAgentId}`,
        peer: entry.peer,
        reason: entry.reason,
        at: entry.addedAt,
      });
      merged.push({ peer: entry.peer, reason: rule.reason, addedAt: rule.createdAt });
    }
    const audited = this.#record(memberId, "im.syncBlocklist", input.deviceId, input.at, { entries: merged.length });
    return { merged, kept: merged.length, replaced: 0, audited };
  }

  mergeProxySettings(
    memberId: string,
    input: { settings: ImProxySettings; updatedAt: number; deviceId: string; at: number },
  ): ImSyncResult<ImProxySettings> {
    const scope = this.scope(memberId);
    const current = this.#settings.read(scope);
    const localUpdatedAt = this.#updatedAt(scope);
    const incomingWins = localUpdatedAt === null || input.updatedAt >= localUpdatedAt;
    const merged = incomingWins ? input.settings : current;
    if (incomingWins) this.#settings.write(scope, { ...merged, at: input.updatedAt });
    const audited = this.#record(memberId, "im.syncProxySettings", input.deviceId, input.at, {
      budget: merged.monthlyBudgetUsd,
      previous: current.monthlyBudgetUsd,
    });
    return {
      merged: [merged],
      kept: 1,
      replaced: current.monthlyBudgetUsd === merged.monthlyBudgetUsd ? 0 : 1,
      audited,
    };
  }

  mergeNotifications(
    memberId: string,
    input: {
      threadId: string;
      notifyOn: ImNotifyOn;
      showPreview: boolean;
      mutedUntil: number | null;
      deviceId: string;
      at: number;
    },
  ): ImSyncResult<string> {
    this.#notifications.setOverride(memberId, {
      threadId: input.threadId,
      mutedUntil: input.mutedUntil,
      notifyOn: input.notifyOn,
      showPreview: input.showPreview,
    });
    const audited = this.#record(memberId, "im.syncNotifications", input.deviceId, input.at, {
      threadId: input.threadId,
      notifyOn: input.notifyOn,
    });
    return { merged: [input.threadId], kept: 1, replaced: 1, audited };
  }

  revokeDevice(memberId: string, input: { deviceId: string; at: number }): { dropped: number; audited: string } {
    const dropped = Number(
      this.#db
        .prepare(
          "DELETE FROM offline_queue WHERE local_server_id = ? AND local_member_id = ? AND recipient_device_id = ?",
        )
        .run(this.#localServerId, memberId, input.deviceId).changes,
    );
    const audited = this.#record(memberId, "im.syncDeviceRevoked", input.deviceId, input.at, { dropped });
    return { dropped, audited };
  }

  #createWithState(scope: ImSocialScope, entry: ImContactSyncEntry) {
    const created = this.#contacts.request({
      ...scope,
      contactId: `c-${entry.peer.peerServerId}-${entry.peer.peerAgentId}`,
      peer: entry.peer,
      at: entry.updatedAt,
    });
    return this.#applyState(scope, entry, created);
  }

  #applyState(
    scope: ImSocialScope,
    entry: ImContactSyncEntry,
    existing: { state: "pending" | "accepted" | "removed" },
  ) {
    if (entry.state === "removed") return this.#contacts.remove({ ...scope, peer: entry.peer, at: entry.updatedAt });
    if (entry.state === "accepted") return this.#contacts.accept({ ...scope, peer: entry.peer, at: entry.updatedAt });
    return existing;
  }

  #updatedAt(scope: ImSocialScope): number | null {
    const row = databaseRow(
      this.#db
        .prepare("SELECT updated_at FROM im_proxy_settings WHERE local_server_id = ? AND local_member_id = ?")
        .get(scope.localServerId, scope.localMemberId),
    );
    return row ? Number(row.updated_at) : null;
  }

  #record(memberId: string, action: string, deviceId: string, at: number, detail: DynamicRecord): string {
    const id = `${action}-${at}-${deviceId}`;
    this.#audit.record(this.scope(memberId), {
      id,
      actorId: deviceId,
      sourceTrustDomain: "local",
      action,
      targetId: memberId,
      result: "ok",
      correlationId: `sync-${memberId}`,
      before: null,
      after: detail,
      at,
    });
    return id;
  }
}
