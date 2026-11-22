import type { AppTextKey } from "@openbot/i18n";

export type ImPairingFailure = "expired" | "failed";

export function imPairingExpired(expiresAt: number, now: number): boolean {
  return now >= expiresAt;
}

export function imPairingCountdown(expiresAt: number, now: number): string {
  const left = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const minutes = Math.floor(left / 60);
  const seconds = left % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function imPairingFailure(error: unknown): ImPairingFailure {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!(current instanceof Error)) return "failed";
    if (current.message.includes("im.pairingExpired")) return "expired";
    current = current.cause;
  }
  return "failed";
}

export const IM_PAIRING_FAILURE_LABEL = {
  expired: "im.devices.expired",
  failed: "im.devices.approveFailed",
} as const satisfies Record<ImPairingFailure, AppTextKey>;
