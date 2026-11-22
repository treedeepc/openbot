import type { ImPresenceState } from "@openbot/contracts/ipc";
import type { ImMessageRow } from "./im-client";

export type ImSendPhase = "settled" | "undelivered" | "resending" | "delivered" | "withdrawn";

export function imWithdrawn(row: ImMessageRow): boolean {
  return row.withdrawn || (row.delivery === "blocked-discarded" && row.deliveryError === "im.messageWithdrawn");
}

export function imSendPhase(row: ImMessageRow, resending = false): ImSendPhase {
  if (imWithdrawn(row)) return "withdrawn";
  switch (row.delivery) {
    case undefined:
    case "blocked-discarded":
      return "settled";
    case "failed":
      return resending ? "resending" : "undelivered";
    case "submitted":
      return resending || row.attempts > 1 ? "resending" : "settled";
    default:
      return row.attempts > 1 ? "delivered" : "settled";
  }
}

export function imResendable(row: ImMessageRow): boolean {
  return !imWithdrawn(row) && row.delivery === "failed" && row.deliveryId !== null;
}

export function imUndeliveredRows(rows: readonly ImMessageRow[]): ImMessageRow[] {
  return rows.filter((row) => imResendable(row));
}

export function imAutoResendTargets(
  rows: readonly ImMessageRow[],
  before: ImPresenceState | null,
  after: ImPresenceState | null,
): ImMessageRow[] {
  if (after !== "online" || before === "online") return [];
  return imUndeliveredRows(rows);
}

export async function imResendOnOnline(
  rows: readonly ImMessageRow[],
  before: ImPresenceState | null,
  after: ImPresenceState | null,
  resend: (row: ImMessageRow) => Promise<void>,
): Promise<ImMessageRow[]> {
  const targets = imAutoResendTargets(rows, before, after);
  for (const row of targets) await resend(row);
  return targets;
}
