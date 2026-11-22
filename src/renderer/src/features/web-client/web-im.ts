import type { ImEntrySupport } from "@openbot/team-client/im-client";

export type {
  ImChannelMemberRow,
  ImEntrySupport,
  ImHostPort,
  ImMessageRow,
  ImPeerRef,
  ImPeerSummary,
} from "@openbot/team-client/im-client";
export {
  imDeliveryOf,
  imEntryAvailable,
  imEntrySupport,
  imEntrySupportFor,
  imMessageRows,
  imPeerRef,
  toImChannelMemberRow,
  toImMessageRow,
  toImPeerSummary,
} from "@openbot/team-client/im-client";

export type ImPane = "inbox" | "contacts" | "session" | "devices";

export function imPanes(support: ImEntrySupport): ImPane[] {
  const panes: ImPane[] = [];
  if (support.inbox) panes.push("inbox");
  if (support.contacts) panes.push("contacts");
  if (support.session) panes.push("session");
  if (support.devices) panes.push("devices");
  return panes;
}
