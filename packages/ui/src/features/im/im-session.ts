import type { ImDeliveryState, ImSenderKind } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import type { ImMessageRow } from "@openbot/team-client/im-client";
import type { ImSendPhase } from "@openbot/team-client/im-resend";

export type { ImMessageRow, ImPeerSummary } from "@openbot/team-client/im-client";
export {
  imAutoResendTargets,
  imResendable,
  imResendOnOnline,
  imSendPhase,
  imUndeliveredRows,
  imWithdrawn,
} from "@openbot/team-client/im-resend";
export type { ImDeliveryState, ImSenderKind, ImSendPhase };

export const IM_DELIVERY_LABEL = {
  submitted: "im.delivery.submitted",
  persisted: "im.delivery.persisted",
  acked: "im.delivery.acked",
  read: "im.delivery.read",
  "blocked-discarded": "im.delivery.blockedDiscarded",
  failed: "im.delivery.failed",
} as const satisfies Record<ImDeliveryState, AppTextKey>;

export const IM_SEND_PHASE_LABEL: Record<ImSendPhase, AppTextKey | null> = {
  settled: null,
  withdrawn: null,
  undelivered: "im.delivery.failed",
  resending: "im.message.resending",
  delivered: "im.message.delivered",
};

const OFFLINE_ERRORS = ["im.peerOffline", "im.notDelivered"];

export function imUndeliveredHintKey(row: ImMessageRow): AppTextKey {
  const error = row.deliveryError ?? null;
  return error === null || OFFLINE_ERRORS.includes(error) ? "im.message.undeliveredHint" : "im.message.retryHint";
}
