import type {
  ImBlockRule,
  ImChannelMember,
  ImContact,
  ImDelivery,
  ImDevice,
  ImKeyAlgorithm,
  ImMessage,
  ImNotificationSettings,
  ImPage,
  ImPeer,
  ImPresence,
  ImProfile,
  ImProxySettings,
  ImReportCategory,
  ImThread,
  ImThreadFilter,
} from "@openbot/contracts/ipc";
import type { ImCapability } from "@openbot/contracts/team-protocol/im-v1";
import {
  IM_BLOCKLIST_CAPABILITY,
  IM_CAPABILITIES,
  IM_CONTACTS_CAPABILITY,
  IM_DEVICES_CAPABILITY,
  IM_INBOX_CAPABILITY,
  IM_MESSAGES_CAPABILITY,
  IM_PEERS_CAPABILITY,
  IM_REPORT_CAPABILITY,
} from "@openbot/contracts/team-protocol/im-v1";

export interface ImEnrollChallenge {
  deviceId: string;
  pairingCode: string;
  fingerprint: string;
  expiresAt: number;
  devicePublicKey?: string | null;
  algorithm?: ImKeyAlgorithm | null;
}

export interface ImEnrollApproval {
  device: ImDevice;
  cert: string;
}

export interface ImProxySend {
  proxiedBy: string;
  visibility: ImMessage["proxyVisibility"];
}

export interface ImPeerRef {
  peerServerId: string;
  peerAgentId: string;
}

export interface ImHostPort {
  peers: {
    list(): Promise<ImPage<ImPeer>>;
  };
  threads: {
    list(): Promise<ImPage<ImThread>>;
    assign(threadId: string, assignees: readonly string[], primary: string): Promise<ImThread>;
  };
  messages: {
    list(threadId: string): Promise<ImPage<ImMessage>>;
    send(threadId: string, body: string, proxy?: ImProxySend | undefined): Promise<ImMessage>;
    withdraw(threadId: string, localMessageId: string): Promise<void>;
  };
  delivery: {
    list(threadId: string): Promise<ImPage<ImDelivery>>;
    read(threadId: string, lastReadLocalMessageId: string): Promise<void>;
    resend(deliveryId: string): Promise<ImDelivery>;
  };
  presence: {
    list(peers: readonly ImPeerRef[]): Promise<ImPage<ImPresence>>;
  };
  devices: {
    list(): Promise<ImPage<ImDevice>>;
    enrollBegin(deviceName: string, publicKey: string): Promise<ImEnrollChallenge>;
    enrollApprove(deviceId: string, pairingCode: string): Promise<void>;
    enrollStatus(deviceId: string): Promise<ImDevice>;
    enrollCancel(deviceId: string): Promise<void>;
    revoke(deviceId: string): Promise<ImDevice>;
  };
  contacts: {
    list(): Promise<ImPage<ImContact>>;
    request(peer: ImPeerRef): Promise<void>;
    accept(contactId: string): Promise<void>;
    reject(contactId: string): Promise<void>;
  };
  blocklist: {
    list(): Promise<ImPage<ImBlockRule>>;
    add(peer: ImPeerRef): Promise<void>;
  };
  channels: {
    listMembers(channelId: string): Promise<ImPage<ImChannelMember>>;
    addMember(channelId: string, member: ImPeerRef, role: ImChannelMember["role"]): Promise<void>;
    removeMember(channelId: string, member: ImPeerRef): Promise<void>;
  };
  reports: {
    create(targetPeer: string, category: ImReportCategory): Promise<void>;
  };
  proxy: {
    get(): Promise<ImProxySettings>;
    set(next: ImProxySettings): Promise<ImProxySettings>;
  };
  notifications: {
    get(threadId: string | null): Promise<ImNotificationSettings>;
    set(next: ImNotificationSettings): Promise<ImNotificationSettings>;
  };
  profile: {
    get(): Promise<ImProfile>;
    update(next: ImProfile): Promise<ImProfile>;
  };
}

export interface ImEntrySupport {
  inbox: boolean;
  contacts: boolean;
  session: boolean;
  devices: boolean;
  assign: boolean;
  block: boolean;
  report: boolean;
}

export function imEntrySupport(capabilities: readonly string[]): ImEntrySupport {
  return imEntrySupportFrom((capability) => capabilities.includes(capability));
}

export interface ImServerCapabilityView {
  kind: string;
  compatibility?: { capabilities: readonly string[] } | null;
}

export function imEntrySupportFor(server: ImServerCapabilityView | undefined): ImEntrySupport {
  return imEntrySupport(server?.kind === "local" ? IM_CAPABILITIES : (server?.compatibility?.capabilities ?? []));
}

export function imEntrySupportFrom(has: (capability: ImCapability) => boolean): ImEntrySupport {
  return {
    inbox: has(IM_INBOX_CAPABILITY) && has(IM_PEERS_CAPABILITY),
    contacts: has(IM_CONTACTS_CAPABILITY),
    session: has(IM_PEERS_CAPABILITY) && has(IM_MESSAGES_CAPABILITY),
    devices: has(IM_DEVICES_CAPABILITY),
    assign: has(IM_INBOX_CAPABILITY),
    block: has(IM_BLOCKLIST_CAPABILITY),
    report: has(IM_REPORT_CAPABILITY),
  };
}

export function imEntryAvailable(support: ImEntrySupport): boolean {
  return support.inbox || support.contacts || support.session || support.devices;
}

export function imFingerprintText(value: string): string {
  const hex = value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  const bytes =
    hex.length === 64
      ? (hex
          .match(/.{4}/g)
          ?.map((pair) => pair.slice(0, 2))
          .join("") ?? hex)
      : hex;
  const groups = bytes.match(/.{1,4}/g) ?? [];
  return groups.slice(0, 8).join(" ");
}

export function imPeerRef(peer: { peerServerId: string; peerAgentId: string }): string {
  return `${peer.peerServerId}/${peer.peerAgentId}`;
}

export interface ImDraft {
  text: string;
  from: string | null;
}

export function imDraftKey(peer: ImPeerRef, threadId: string): string {
  return `${peer.peerServerId}:${peer.peerAgentId}\u0000${threadId}`;
}

export interface ImPeerSummary {
  name: string;
  verified: boolean;
  fingerprint?: string;
}

export type { ImChannelMember, ImContact, ImReportCategory, ImThreadFilter };

export interface ImMessageRow {
  id: string;
  deliveryId: string | null;
  proxiedBy: string | null;
  senderKind: ImMessage["senderKind"];
  senderName: string;
  body: string;
  sentAt: number;
  verified: boolean;
  withdrawn: boolean;
  attempts: number;
  proxyVisibility?: ImMessage["proxyVisibility"];
  delivery?: ImDelivery["state"];
  deliveryError?: string | null;
}

export function toImPeerSummary(peer: ImPeer): ImPeerSummary {
  return { name: peer.displayName, verified: peer.verified, fingerprint: peer.fingerprint };
}

export function toImMessageRow(message: ImMessage, delivery: ImDelivery | undefined, senderName: string): ImMessageRow {
  return {
    id: message.localMessageId,
    deliveryId: delivery?.deliveryId ?? null,
    proxiedBy: message.proxiedBy,
    senderKind: message.senderKind,
    senderName,
    body: message.body,
    sentAt: message.sentAt,
    verified: message.verified,
    withdrawn: message.withdrawnAt !== null,
    attempts: delivery?.attempts ?? 0,
    proxyVisibility: message.proxyVisibility,
    delivery: delivery?.state,
    deliveryError: delivery?.error ?? null,
  };
}

export function imDeliveryOf(deliveries: readonly ImDelivery[], localMessageId: string): ImDelivery | undefined {
  return deliveries.find((delivery) => delivery.localMessageId === localMessageId);
}

export function imMessageRows(
  messages: readonly ImMessage[],
  deliveries: readonly ImDelivery[],
  senderName: (message: ImMessage) => string,
): ImMessageRow[] {
  return messages.map((message) =>
    toImMessageRow(message, imDeliveryOf(deliveries, message.localMessageId), senderName(message)),
  );
}

export interface ImAgentOption {
  id: string;
  name: string;
}

export interface ImAssignee {
  id: string;
  name: string;
  primary: boolean;
}

export type ImNetworkState = "lan" | "server" | "offline";

export interface ImInboxRow {
  threadId: string;
  peer: ImPeerSummary;
  peerRef: ImPeerRef;
  lastMessage: string;
  lastMessageAt: number | null;
  unread: number;
  proxiedBy: string | null;
  assignees: readonly ImAssignee[];
}

export function toImAssignees(
  assignees: readonly string[],
  primary: string | null,
  agents: readonly ImAgentOption[],
): ImAssignee[] {
  return assignees.map((id) => ({
    id,
    name: agents.find((agent) => agent.id === id)?.name ?? id,
    primary: id === primary,
  }));
}

export function toImInboxRow(
  thread: ImThread,
  peer: ImPeer,
  last: ImMessage | undefined,
  agents: readonly ImAgentOption[],
): ImInboxRow {
  return {
    threadId: thread.threadId,
    peer: toImPeerSummary(peer),
    peerRef: { peerServerId: thread.peerServerId, peerAgentId: thread.peerAgentId },
    lastMessage: last?.body ?? "",
    lastMessageAt: thread.lastMessageAt,
    unread: thread.unread,
    proxiedBy: last?.proxiedBy ?? null,
    assignees: toImAssignees(thread.assignees, thread.primary, agents),
  };
}

export function imInboxMatches(filter: ImThreadFilter, row: ImInboxRow): boolean {
  if (filter === "unread") return row.unread > 0;
  if (filter === "assigned") return row.assignees.length > 0;
  if (filter === "unassigned") return row.assignees.length === 0;
  return true;
}

export function imToggleAssignee(assignees: readonly ImAssignee[], agent: ImAgentOption): ImAssignee[] {
  const present = assignees.some((item) => item.id === agent.id);
  const next = present
    ? assignees.filter((item) => item.id !== agent.id)
    : [...assignees, { id: agent.id, name: agent.name, primary: false }];
  return imNormalizeAssignees(next);
}

export function imSetPrimary(assignees: readonly ImAssignee[], id: string): ImAssignee[] {
  return imNormalizeAssignees(assignees.map((item) => ({ ...item, primary: item.id === id })));
}

function imNormalizeAssignees(assignees: readonly ImAssignee[]): ImAssignee[] {
  const next = assignees.map((item) => ({ ...item }));
  const primaryId = next.find((item) => item.primary)?.id ?? next[0]?.id ?? null;
  return next.map((item) => ({ ...item, primary: item.id === primaryId }));
}

export const IM_CONTACT_REQUEST_TTL_MS = 7 * 86_400_000;

export type ImContactViewState = "pending" | "accepted" | "rejected" | "expired";

export interface ImContactRow {
  contactId: string;
  peerRef: ImPeerRef;
  name: string;
  alias: string | null;
  state: ImContactViewState;
  addedAt: number;
}

export function imContactViewState(
  contact: ImContact,
  now: number,
  ttlMs = IM_CONTACT_REQUEST_TTL_MS,
): ImContactViewState {
  if (contact.state === "accepted") return "accepted";
  if (contact.state === "removed") return "rejected";
  return contact.addedAt + ttlMs <= now ? "expired" : "pending";
}

export function toImContactRow(contact: ImContact, name: string, now: number): ImContactRow {
  return {
    contactId: contact.contactId,
    peerRef: { peerServerId: contact.peerServerId, peerAgentId: contact.peerAgentId },
    name,
    alias: contact.alias,
    state: imContactViewState(contact, now),
    addedAt: contact.addedAt,
  };
}

export interface ImChannelMemberRow {
  id: string;
  name: string;
  role: ImChannelMember["role"];
  external: boolean;
}

export function toImChannelMemberRow(
  member: ImChannelMember,
  peers: readonly ImPeer[],
  external: (member: ImChannelMember) => boolean,
): ImChannelMemberRow {
  const peer = peers.find(
    (item) => item.peerServerId === member.peerServerId && item.peerAgentId === member.peerAgentId,
  );
  return {
    id: `${member.peerServerId}/${member.peerAgentId}`,
    name: peer?.displayName ?? imPeerRef(member),
    role: member.role,
    external: external(member),
  };
}

export function imChannelCanInvite(rows: readonly ImChannelMemberRow[], viewer: ImPeerRef | null): boolean {
  const row = viewer === null ? undefined : rows.find((item) => item.id === imPeerRef(viewer));
  if (row === undefined) return true;
  return row.role === "admin" && !row.external;
}

export function imChannelInviteTargets(peers: readonly ImPeer[], members: readonly ImChannelMember[]): ImPeer[] {
  const taken = new Set(members.map((member) => imPeerRef(member)));
  return peers.filter((peer) => !taken.has(imPeerRef(peer)));
}

export const IM_MUTE_WINDOW_MS = 8 * 3_600_000;

export function imMuteToggle(mutedUntil: number | null, now: number): number | null {
  return mutedUntil === null ? now + IM_MUTE_WINDOW_MS : null;
}

export function imContactName(contact: ImContact, peers: readonly ImPeer[]): string {
  const peer = peers.find(
    (item) => item.peerServerId === contact.peerServerId && item.peerAgentId === contact.peerAgentId,
  );
  return contact.alias ?? peer?.displayName ?? imPeerRef(contact);
}

export const IM_CONTACT_STATE_LABEL = {
  pending: "im.contacts.state.pending",
  accepted: "im.contacts.state.accepted",
  rejected: "im.contacts.state.rejected",
  expired: "im.contacts.state.expired",
} as const satisfies Record<ImContactViewState, string>;

export const IM_REPORT_CATEGORY_LABEL = {
  spam: "im.report.spam",
  abuse: "im.report.abuse",
  impersonation: "im.report.impersonation",
  other: "im.report.other",
} as const;
