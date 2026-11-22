import type { AppTextKey } from "@openbot/i18n";
import type { ImNetworkState, ImThreadFilter } from "@openbot/team-client/im-client";

export type {
  ImAgentOption,
  ImAssignee,
  ImContactRow,
  ImContactViewState,
  ImInboxRow,
  ImNetworkState,
  ImPeerRef,
  ImPeerSummary,
  ImReportCategory,
  ImThreadFilter,
} from "@openbot/team-client/im-client";
export {
  IM_CONTACT_REQUEST_TTL_MS,
  IM_CONTACT_STATE_LABEL,
  IM_REPORT_CATEGORY_LABEL,
  imContactName,
  imContactViewState,
  imInboxMatches,
  imPeerRef,
  imSetPrimary,
  imToggleAssignee,
  toImAssignees,
  toImContactRow,
  toImInboxRow,
} from "@openbot/team-client/im-client";

export const IM_INBOX_FILTER_LABEL = {
  all: "im.inbox.filter.all",
  unread: "im.inbox.filter.unread",
  assigned: "im.inbox.filter.assigned",
  unassigned: "im.inbox.filter.unassigned",
} as const satisfies Record<ImThreadFilter, AppTextKey>;

export const IM_NETWORK_LABEL = {
  lan: "im.network.lan",
  server: "im.network.server",
  offline: "im.network.offline",
} as const satisfies Record<ImNetworkState, AppTextKey>;
