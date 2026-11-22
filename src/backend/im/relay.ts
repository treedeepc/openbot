import type { DatabaseSync } from "node:sqlite";
import { databaseRow } from "../database/database-rows";
import { ImAuditLog } from "./audit";
import { decodeImWireFrame, ImWireForwarder, type ImWireFrame, ImWireRejected } from "./wire";

export interface ImRelayScope {
  localServerId: string;
  localMemberId: string;
}

export interface ImRelaySettings {
  enabled: boolean;
  exposedSurface: string[];
  enabledAt: number | null;
  updatedAt: number;
}

export class ImRelayNotEnabled extends Error {
  constructor() {
    super("im.lanDisabled");
    this.name = "ImRelayNotEnabled";
  }
}

export class ImRelaySurfaceRequired extends Error {
  constructor() {
    super("im.protocolError");
    this.name = "ImRelaySurfaceRequired";
  }
}

function parseSurface(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value.split(",").filter((part) => part.length > 0);
}

export class ImRelayService {
  readonly #db: DatabaseSync;
  readonly #localServerId: string;
  readonly #forwarder: ImWireForwarder;
  readonly #audit: ImAuditLog;

  constructor(db: DatabaseSync, localServerId: string) {
    this.#db = db;
    this.#localServerId = localServerId;
    this.#forwarder = new ImWireForwarder(db, localServerId);
    this.#audit = new ImAuditLog(db);
  }

  #record(
    memberId: string,
    action: string,
    before: { enabled: boolean; exposedSurface: readonly string[] },
    after: unknown,
    at: number,
  ): void {
    this.#audit.record(this.scope(memberId), {
      id: `${action}-${at}-${memberId}`,
      actorId: memberId,
      sourceTrustDomain: "local",
      action,
      targetId: memberId,
      result: "ok",
      correlationId: `relay-${memberId}`,
      before,
      after,
      at,
    });
  }

  scope(memberId: string): ImRelayScope {
    return { localServerId: this.#localServerId, localMemberId: memberId };
  }

  settings(memberId: string): ImRelaySettings {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT enabled, exposed_surface, enabled_at, updated_at FROM im_relay_settings WHERE local_server_id = ? AND local_member_id = ?",
        )
        .get(this.#localServerId, memberId),
    );
    if (!row) return { enabled: false, exposedSurface: [], enabledAt: null, updatedAt: 0 };
    return {
      enabled: Number(row.enabled) === 1,
      exposedSurface: parseSurface(row.exposed_surface),
      enabledAt: row.enabled_at === null ? null : Number(row.enabled_at),
      updatedAt: Number(row.updated_at),
    };
  }

  enable(memberId: string, input: { exposedSurface: readonly string[]; at: number }): ImRelaySettings {
    if (input.exposedSurface.length === 0) throw new ImRelaySurfaceRequired();
    this.#db
      .prepare(
        `INSERT INTO im_relay_settings (local_server_id, local_member_id, enabled, exposed_surface, enabled_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(local_server_id, local_member_id) DO UPDATE SET enabled = 1,
           exposed_surface = excluded.exposed_surface, enabled_at = excluded.enabled_at, updated_at = excluded.updated_at`,
      )
      .run(this.#localServerId, memberId, [...input.exposedSurface].join(","), input.at, input.at);
    const after = this.settings(memberId);
    this.#record(memberId, "im.relay.enable", { enabled: false, exposedSurface: [] }, after, input.at);
    return after;
  }

  disable(memberId: string, input: { at: number }): ImRelaySettings {
    const before = this.settings(memberId);
    this.#db
      .prepare(
        `INSERT INTO im_relay_settings (local_server_id, local_member_id, enabled, exposed_surface, enabled_at, updated_at)
         VALUES (?, ?, 0, '', NULL, ?)
         ON CONFLICT(local_server_id, local_member_id) DO UPDATE SET enabled = 0, exposed_surface = '',
           enabled_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(this.#localServerId, memberId, input.at);
    const after = this.settings(memberId);
    this.#record(memberId, "im.relay.disable", before, after, input.at);
    return after;
  }

  relay(
    memberId: string,
    input: { frame: unknown; deviceIds: readonly string[]; at: number; expiresAt: number },
  ): { forwarded: number; exposedSurface: string[] } {
    const settings = this.settings(memberId);
    if (!settings.enabled) throw new ImRelayNotEnabled();
    const frame: ImWireFrame = decodeImWireFrame(input.frame);
    if (frame.sealed.length === 0) throw new ImWireRejected("im.protocolError");
    const result = this.#forwarder.forward(memberId, {
      frame,
      deviceIds: input.deviceIds,
      at: input.at,
      expiresAt: input.expiresAt,
    });
    this.#record(
      memberId,
      "im.relay.forward",
      { enabled: settings.enabled, exposedSurface: settings.exposedSurface },
      { forwarded: result.outcomes.length, devices: [...input.deviceIds], nonce: frame.nonce },
      input.at,
    );
    return { forwarded: result.outcomes.length, exposedSurface: settings.exposedSurface };
  }
}
