import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { databaseRow, databaseRows } from "../database/database-rows";
import type { ImDeviceCertificate, ImDeviceRecord, ImDeviceState } from "./identity";

const COLUMNS = [
  "local_server_id",
  "local_member_id",
  "device_id",
  "public_key",
  "status",
  "cert_ref",
  "enrolled_at",
  "revoked_at",
  "pairing_expires_at",
  "pairing_code",
] as const;

function readCertificate(value: unknown): ImDeviceCertificate | null {
  if (value === null || value === undefined) return null;
  const parsed = JSON.parse(String(value));
  if (!isDynamicRecord(parsed)) return null;
  if (!isString(parsed.deviceId) || !isString(parsed.publicKey) || !isString(parsed.rootPublicKey)) return null;
  if (!isNumber(parsed.issuedAt) || !isNumber(parsed.expiresAt) || !isString(parsed.signature)) return null;
  return {
    deviceId: parsed.deviceId,
    publicKey: parsed.publicKey,
    rootPublicKey: parsed.rootPublicKey,
    issuedAt: parsed.issuedAt,
    expiresAt: parsed.expiresAt,
    signature: parsed.signature,
  };
}

function readState(value: unknown): ImDeviceState {
  return value === "active" ? "active" : value === "revoked" ? "revoked" : "pending";
}

export class ImDeviceStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #row(record: ImDeviceRecord) {
    return [
      record.localServerId,
      record.localMemberId,
      record.deviceId,
      record.publicKey,
      record.status,
      record.cert ? JSON.stringify(record.cert) : null,
      record.enrolledAt,
      record.revokedAt,
      record.pairingExpiresAt,
      record.pairingCode,
    ] satisfies SQLInputValue[];
  }

  #read(row: DynamicRecord): ImDeviceRecord {
    const cert = readCertificate(row.cert_ref);
    return {
      localServerId: String(row.local_server_id),
      localMemberId: String(row.local_member_id),
      deviceId: String(row.device_id),
      publicKey: String(row.public_key),
      status: readState(row.status),
      cert,
      enrolledAt: row.enrolled_at === null ? null : Number(row.enrolled_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
      pairingExpiresAt: row.pairing_expires_at === null ? null : Number(row.pairing_expires_at),
      pairingCode: row.pairing_code === null ? null : String(row.pairing_code),
    };
  }

  save(record: ImDeviceRecord): void {
    this.#db
      .prepare(
        `INSERT INTO local_devices (${COLUMNS.join(", ")})
         VALUES (${COLUMNS.map(() => "?").join(", ")})
         ON CONFLICT(local_server_id, local_member_id, device_id) DO UPDATE SET
           public_key = excluded.public_key,
           status = excluded.status,
           cert_ref = excluded.cert_ref,
           enrolled_at = excluded.enrolled_at,
           revoked_at = excluded.revoked_at,
           pairing_expires_at = excluded.pairing_expires_at,
           pairing_code = excluded.pairing_code`,
      )
      .run(...this.#row(record));
  }

  remove(localServerId: string, localMemberId: string, deviceId: string): void {
    this.#db
      .prepare("DELETE FROM local_devices WHERE local_server_id = ? AND local_member_id = ? AND device_id = ?")
      .run(localServerId, localMemberId, deviceId);
  }

  read(localServerId: string, localMemberId: string, deviceId: string): ImDeviceRecord | null {
    const row = databaseRow(
      this.#db
        .prepare("SELECT * FROM local_devices WHERE local_server_id = ? AND local_member_id = ? AND device_id = ?")
        .get(localServerId, localMemberId, deviceId),
    );
    return row ? this.#read(row) : null;
  }

  list(localServerId: string, localMemberId: string): ImDeviceRecord[] {
    return databaseRows(
      this.#db
        .prepare("SELECT * FROM local_devices WHERE local_server_id = ? AND local_member_id = ? ORDER BY device_id")
        .all(localServerId, localMemberId),
    ).map((row) => this.#read(row));
  }

  activePublicKeys(localServerId: string, localMemberId: string): string[] {
    return this.list(localServerId, localMemberId)
      .filter((record) => record.status === "active")
      .map((record) => record.publicKey);
  }
}
