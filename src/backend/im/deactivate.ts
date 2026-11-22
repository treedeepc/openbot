import type { DatabaseSync } from "node:sqlite";
import { databaseRow, databaseRows } from "../database/database-rows";
import { ImDeviceStore } from "./device-store";
import { revokedDeviceCertificate } from "./identity";
import { type ImDirectoryPort, ImDirectoryStore } from "./server-mode";

export interface ImDeactivateScope {
  localServerId: string;
  localMemberId: string;
}

export interface ImDeactivateResult {
  queueCleared: number;
  targetsCleared: number;
  devicesRevoked: number;
  profileDeactivated: boolean;
}

export class ImDeactivateService {
  readonly #db: DatabaseSync;
  readonly #localServerId: string;
  readonly #directory: ImDirectoryStore;

  constructor(db: DatabaseSync, localServerId: string, port: ImDirectoryPort = {}) {
    this.#db = db;
    this.#localServerId = localServerId;
    this.#directory = new ImDirectoryStore(db, port);
  }

  deactivate(memberId: string, input: { at: number }): ImDeactivateResult {
    const scope: ImDeactivateScope = { localServerId: this.#localServerId, localMemberId: memberId };
    this.#directory.deactivate({ peerServerId: scope.localServerId, peerAgentId: memberId });
    const queue = Number(
      this.#db
        .prepare("DELETE FROM offline_queue WHERE local_server_id = ? AND local_member_id = ?")
        .run(scope.localServerId, scope.localMemberId).changes,
    );

    const targets = Number(
      this.#db
        .prepare("DELETE FROM offline_targets WHERE local_server_id = ? AND local_member_id = ?")
        .run(scope.localServerId, scope.localMemberId).changes,
    );

    const devices = new ImDeviceStore(this.#db);
    let revoked = 0;
    for (const record of devices.list(scope.localServerId, scope.localMemberId)) {
      if (record.status === "revoked") continue;
      devices.save({
        ...record,
        status: "revoked",
        revokedAt: input.at,
        cert: record.cert ? revokedDeviceCertificate(record.cert) : null,
      });
      revoked += 1;
    }
    return { queueCleared: queue, targetsCleared: targets, devicesRevoked: revoked, profileDeactivated: true };
  }

  queueCount(memberId: string): number {
    const row = databaseRow(
      this.#db
        .prepare("SELECT COUNT(*) AS n FROM offline_queue WHERE local_server_id = ? AND local_member_id = ?")
        .get(this.#localServerId, memberId),
    );
    return row ? Number(row.n) : 0;
  }

  activeDevices(memberId: string): number {
    return databaseRows(
      this.#db
        .prepare(
          "SELECT device_id FROM local_devices WHERE local_server_id = ? AND local_member_id = ? AND status = 'active'",
        )
        .all(this.#localServerId, memberId),
    ).length;
  }
}
