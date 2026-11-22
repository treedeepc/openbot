import type { ImNotificationSettings } from "@openbot/contracts/ipc";

export interface ImNotifyDecision {
  notify: boolean;
  showPreview: boolean;
  reason: "sent" | "muted" | "notify-off" | "deduped";
}

export function imNotificationDefaults(threadId: string | null): ImNotificationSettings {
  return { threadId, mutedUntil: null, notifyOn: "all", showPreview: true, sendReadReceipts: true };
}

export interface ImNotifyMessage {
  localMessageId: string;
  body: string;
  senderName: string;
  proxiedBy: string | null;
}

export function imNotifyDecision(
  settings: ImNotificationSettings,
  message: ImNotifyMessage,
  now: number,
  seen: ReadonlySet<string>,
): ImNotifyDecision {
  const showPreview = settings.showPreview;
  if (settings.mutedUntil !== null && settings.mutedUntil > now) return { notify: false, showPreview, reason: "muted" };
  if (settings.notifyOn === "none") return { notify: false, showPreview, reason: "notify-off" };
  if (seen.has(message.localMessageId)) return { notify: false, showPreview, reason: "deduped" };
  return { notify: true, showPreview, reason: "sent" };
}

export function imNotify(
  settings: ImNotificationSettings,
  message: ImNotifyMessage,
  seen: Set<string>,
  deliver: (title: string, body: string) => void,
  now = Date.now(),
): ImNotifyDecision {
  const decision = imNotifyDecision(settings, message, now, seen);
  if (decision.notify) {
    seen.add(message.localMessageId);
    deliver(message.senderName, decision.showPreview ? message.body : "");
  }
  return decision;
}
