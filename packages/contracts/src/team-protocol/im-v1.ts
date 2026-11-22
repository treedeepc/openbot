import { isDynamicRecord, isString } from "../runtime-values";
import { decodeTeamProtocolV2Json, type TeamProtocolV2Json } from "./webrtc-framing";

export const IM_PEERS_CAPABILITY = "im-peers-v1";
export const IM_PROFILE_CAPABILITY = "im-profile-v1";
export const IM_CONTACTS_CAPABILITY = "im-contacts-v1";
export const IM_BLOCKLIST_CAPABILITY = "im-blocklist-v1";
export const IM_INBOX_CAPABILITY = "im-inbox-v1";
export const IM_MESSAGES_CAPABILITY = "im-messages-v1";
export const IM_DELIVERY_CAPABILITY = "im-delivery-v1";
export const IM_PROXY_CAPABILITY = "im-proxy-v1";
export const IM_PRESENCE_CAPABILITY = "im-presence-v1";
export const IM_NOTIFICATIONS_CAPABILITY = "im-notifications-v1";
export const IM_DEVICES_CAPABILITY = "im-devices-v1";
export const IM_SEARCH_CAPABILITY = "im-search-v1";
export const IM_LAN_DISCOVERY_CAPABILITY = "im-lan-discovery-v1";
export const IM_CHANNELS_ADMIN_CAPABILITY = "im-channels-admin-v1";
export const IM_REPORT_CAPABILITY = "im-report-v1";
export const IM_AUDIT_CAPABILITY = "im-audit-v1";

export const IM_CAPABILITIES = [
  IM_PEERS_CAPABILITY,
  IM_PROFILE_CAPABILITY,
  IM_CONTACTS_CAPABILITY,
  IM_BLOCKLIST_CAPABILITY,
  IM_INBOX_CAPABILITY,
  IM_MESSAGES_CAPABILITY,
  IM_DELIVERY_CAPABILITY,
  IM_PROXY_CAPABILITY,
  IM_PRESENCE_CAPABILITY,
  IM_NOTIFICATIONS_CAPABILITY,
  IM_DEVICES_CAPABILITY,
  IM_SEARCH_CAPABILITY,
  IM_LAN_DISCOVERY_CAPABILITY,
  IM_CHANNELS_ADMIN_CAPABILITY,
  IM_REPORT_CAPABILITY,
  IM_AUDIT_CAPABILITY,
] as const;
export type ImCapability = (typeof IM_CAPABILITIES)[number];

export const IM_CAPABILITY_STAGES = {
  [IM_PEERS_CAPABILITY]: "p0",
  [IM_DEVICES_CAPABILITY]: "p0",
  [IM_INBOX_CAPABILITY]: "p0",
  [IM_MESSAGES_CAPABILITY]: "p0",
  [IM_CONTACTS_CAPABILITY]: "p0",
  [IM_BLOCKLIST_CAPABILITY]: "p0",
  [IM_REPORT_CAPABILITY]: "p0",
  [IM_LAN_DISCOVERY_CAPABILITY]: "p0",
  [IM_PROFILE_CAPABILITY]: "p1",
  [IM_DELIVERY_CAPABILITY]: "p1",
  [IM_PROXY_CAPABILITY]: "p1",
  [IM_PRESENCE_CAPABILITY]: "p1",
  [IM_NOTIFICATIONS_CAPABILITY]: "p1",
  [IM_CHANNELS_ADMIN_CAPABILITY]: "p1",
  [IM_SEARCH_CAPABILITY]: "p2",
  [IM_AUDIT_CAPABILITY]: "p2",
} as const satisfies Record<ImCapability, ImStage>;

export const IM_STAGES = ["p0", "p1", "p2"] as const;
export type ImStage = (typeof IM_STAGES)[number];

const STAGE_ORDER: Readonly<Record<ImStage, number>> = { p0: 0, p1: 1, p2: 2 };

const IM_CAPABILITY_SET: ReadonlySet<string> = new Set(IM_CAPABILITIES);

export function isImCapability(value: string): value is ImCapability {
  return IM_CAPABILITY_SET.has(value);
}

export function imCapabilityStage(capability: ImCapability): ImStage {
  return IM_CAPABILITY_STAGES[capability];
}

export function imCapabilitiesThrough(stage: ImStage): readonly ImCapability[] {
  return IM_CAPABILITIES.filter((capability) => STAGE_ORDER[IM_CAPABILITY_STAGES[capability]] <= STAGE_ORDER[stage]);
}

export const IM_ROUTES = {
  peersList: "/v1/im/peers",
  peerVerify: "/v1/im/peers/verify",
  profileGet: "/v1/im/profile",
  profileUpdate: "/v1/im/profile",
  profileDeactivate: "/v1/im/profile/deactivate",
  contactsList: "/v1/im/contacts",
  contactRequest: "/v1/im/contacts/requests",
  contactAccept: "/v1/im/contacts/requests/accept",
  contactReject: "/v1/im/contacts/requests/reject",
  contactRemove: "/v1/im/contacts/remove",
  blocklistList: "/v1/im/blocklist",
  blocklistAdd: "/v1/im/blocklist",
  blocklistRemove: "/v1/im/blocklist/remove",
  threadsList: "/v1/im/threads",
  threadGet: "/v1/im/threads/get",
  threadAssign: "/v1/im/threads/assign",
  threadTransfer: "/v1/im/threads/transfer",
  messagesList: "/v1/im/messages/list",
  messageSend: "/v1/im/messages/send",
  messageWithdraw: "/v1/im/messages/withdraw",
  deliveryList: "/v1/im/delivery/list",
  deliveryAck: "/v1/im/delivery/ack",
  deliveryRead: "/v1/im/delivery/read",
  deliveryResend: "/v1/im/delivery/resend",
  proxyGet: "/v1/im/proxy",
  proxySet: "/v1/im/proxy",
  presenceGet: "/v1/im/presence",
  presenceHidden: "/v1/im/presence/hidden",
  notificationsGet: "/v1/im/notifications",
  notificationsSet: "/v1/im/notifications",
  devicesList: "/v1/im/devices",
  enrollBegin: "/v1/im/devices/enroll/begin",
  enrollApprove: "/v1/im/devices/enroll/approve",
  enrollStatus: "/v1/im/devices/enroll/status",
  enrollCancel: "/v1/im/devices/enroll/cancel",
  deviceRevoke: "/v1/im/devices/revoke",
  searchQuery: "/v1/im/search",
  lanPeers: "/v1/im/lan/peers",
  lanSignal: "/v1/im/lan/signal",
  peersDevicesList: "/v1/im/peers/devices",
  channelMembersList: "/v1/im/channels/members",
  channelMemberAdd: "/v1/im/channels/members/add",
  channelMemberRemove: "/v1/im/channels/members/remove",
  reportCreate: "/v1/im/reports",
  reportsList: "/v1/im/reports",
  auditList: "/v1/im/audit",
  auditExport: "/v1/im/audit/export",
} as const;

export const IM_ROUTES_BY_CAPABILITY: Readonly<Record<ImCapability, readonly string[]>> = {
  [IM_PEERS_CAPABILITY]: [IM_ROUTES.peersList, IM_ROUTES.peerVerify],
  [IM_PROFILE_CAPABILITY]: [IM_ROUTES.profileGet, IM_ROUTES.profileUpdate, IM_ROUTES.profileDeactivate],
  [IM_CONTACTS_CAPABILITY]: [
    IM_ROUTES.contactsList,
    IM_ROUTES.contactRequest,
    IM_ROUTES.contactAccept,
    IM_ROUTES.contactReject,
    IM_ROUTES.contactRemove,
  ],
  [IM_BLOCKLIST_CAPABILITY]: [IM_ROUTES.blocklistList, IM_ROUTES.blocklistAdd, IM_ROUTES.blocklistRemove],
  [IM_INBOX_CAPABILITY]: [IM_ROUTES.threadsList, IM_ROUTES.threadGet, IM_ROUTES.threadAssign, IM_ROUTES.threadTransfer],
  [IM_MESSAGES_CAPABILITY]: [IM_ROUTES.messagesList, IM_ROUTES.messageSend, IM_ROUTES.messageWithdraw],
  [IM_DELIVERY_CAPABILITY]: [
    IM_ROUTES.deliveryList,
    IM_ROUTES.deliveryAck,
    IM_ROUTES.deliveryRead,
    IM_ROUTES.deliveryResend,
  ],
  [IM_PROXY_CAPABILITY]: [IM_ROUTES.proxyGet, IM_ROUTES.proxySet],
  [IM_PRESENCE_CAPABILITY]: [IM_ROUTES.presenceGet, IM_ROUTES.presenceHidden],
  [IM_NOTIFICATIONS_CAPABILITY]: [IM_ROUTES.notificationsGet, IM_ROUTES.notificationsSet],
  [IM_DEVICES_CAPABILITY]: [
    IM_ROUTES.devicesList,
    IM_ROUTES.enrollBegin,
    IM_ROUTES.enrollApprove,
    IM_ROUTES.enrollStatus,
    IM_ROUTES.enrollCancel,
    IM_ROUTES.deviceRevoke,
    IM_ROUTES.peersDevicesList,
  ],
  [IM_SEARCH_CAPABILITY]: [IM_ROUTES.searchQuery],
  [IM_LAN_DISCOVERY_CAPABILITY]: [IM_ROUTES.lanPeers, IM_ROUTES.lanSignal],
  [IM_CHANNELS_ADMIN_CAPABILITY]: [
    IM_ROUTES.channelMembersList,
    IM_ROUTES.channelMemberAdd,
    IM_ROUTES.channelMemberRemove,
  ],
  [IM_REPORT_CAPABILITY]: [IM_ROUTES.reportCreate, IM_ROUTES.reportsList],
  [IM_AUDIT_CAPABILITY]: [IM_ROUTES.auditList, IM_ROUTES.auditExport],
};

export function imCapabilityOfRoute(route: string): ImCapability | null {
  for (const capability of IM_CAPABILITIES) {
    if (IM_ROUTES_BY_CAPABILITY[capability].includes(route)) return capability;
  }
  return null;
}

const IM_ROUTE_PATHS: ReadonlySet<string> = new Set(Object.values(IM_ROUTES));

export function isImRoute(path: string): boolean {
  return IM_ROUTE_PATHS.has(new URL(path, "http://openbot.invalid").pathname);
}

export function imRequest(path: string, value: unknown): TeamProtocolV2Json {
  if (!isImRoute(path)) throw new Error("Invalid IM route.");
  return decodeTeamProtocolV2Json(value);
}

export function imResponse(path: string, status: number, value: unknown): TeamProtocolV2Json {
  if (!isImRoute(path)) throw new Error("Invalid IM route.");
  const decoded = decodeTeamProtocolV2Json(value);
  if (status >= 400 && !(isDynamicRecord(decoded) && isString(decoded.error)))
    throw new Error("Invalid IM error response.");
  return decoded;
}
