import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { type DynamicRecord, isDynamicRecord, isNumber, isOneOf } from "./runtime-values";

export const IM_CAPABILITY = "im-v1";

export const IM_ERROR_CODES = [
  "im.unauthorized",
  "im.rateLimited",
  "im.protocolError",
  "im.versionIncompatible",
  "im.notFound",
] as const;
export type ImErrorCode = (typeof IM_ERROR_CODES)[number];

export const IM_SPECIFIC_ERROR_CODES = [
  "im.invalidProfile",
  "im.confirmMismatch",
  "im.notRegistered",
  "im.alreadyContact",
  "im.blocked",
  "im.notVisible",
  "im.requestExpired",
  "im.requestNotFound",
  "im.contactNotFound",
  "im.alreadyBlocked",
  "im.ruleNotFound",
  "im.threadNotFound",
  "im.notAssignee",
  "im.primaryRequired",
  "im.unknownAgent",
  "im.tooLarge",
  "im.toolDenied",
  "im.duplicateMessage",
  "im.withdrawExpired",
  "im.messageNotFound",
  "im.notDelivered",
  "im.notResendable",
  "im.budgetExceeded",
  "im.notFriend",
  "im.enrollPending",
  "im.pairingExpired",
  "im.pairingInvalid",
  "im.deviceUnknown",
  "im.lanDisabled",
  "im.unsupportedPlatform",
  "im.notAdmin",
  "im.peerBlocked",
  "im.duplicateReport",
  "im.exportTooLarge",
  "im.notVerified",
  "im.peerOffline",
  "im.messageWithdrawn",
] as const;
export type ImSpecificErrorCode = (typeof IM_SPECIFIC_ERROR_CODES)[number];

export type ImError = ImErrorCode | ImSpecificErrorCode;

export const IM_LIMITS = {
  displayName: 64,
  bio: 280,
  note: 200,
  detail: 500,
  body: 8_000,
  remoteMessageId: 64,
  fingerprint: 64,
  pairingCode: 12,
  query: 64,
  cursor: 256,
  ackBatch: 200,
  monthlyBudgetUsd: 1_000,
  deviceName: 64,
} as const;

export const IM_SENDER_KINDS = ["self", "local-assistant", "peer"] as const;
export type ImSenderKind = (typeof IM_SENDER_KINDS)[number];

export const IM_DELIVERY_STATES = ["submitted", "persisted", "acked", "read", "blocked-discarded", "failed"] as const;
export type ImDeliveryState = (typeof IM_DELIVERY_STATES)[number];

export const IM_DEVICE_STATES = ["pending", "active", "revoked"] as const;
export type ImDeviceState = (typeof IM_DEVICE_STATES)[number];

export const IM_CONTACT_STATES = ["pending", "accepted", "removed"] as const;
export type ImContactState = (typeof IM_CONTACT_STATES)[number];

export const IM_PRESENCE_STATES = ["online", "away", "offline"] as const;
export type ImPresenceState = (typeof IM_PRESENCE_STATES)[number];

export const IM_PROXY_VISIBILITY = ["shown", "hidden"] as const;
export type ImProxyVisibility = (typeof IM_PROXY_VISIBILITY)[number];

export const IM_NOTIFY_ON = ["all", "mentions", "none"] as const;
export type ImNotifyOn = (typeof IM_NOTIFY_ON)[number];

export const IM_REPORT_CATEGORIES = ["spam", "abuse", "impersonation", "other"] as const;
export type ImReportCategory = (typeof IM_REPORT_CATEGORIES)[number];

export const IM_REPORT_STATES = ["open", "reviewed", "actioned", "dismissed"] as const;
export type ImReportState = (typeof IM_REPORT_STATES)[number];

export const IM_CHANNEL_ROLES = ["admin", "member", "readonly"] as const;
export type ImChannelRole = (typeof IM_CHANNEL_ROLES)[number];

export const IM_THREAD_FILTERS = ["all", "unread", "assigned", "unassigned"] as const;
export type ImThreadFilter = (typeof IM_THREAD_FILTERS)[number];

export const IM_KEY_ALGORITHMS = ["p256-base64url", "ed25519-hex"] as const;
export type ImKeyAlgorithm = (typeof IM_KEY_ALGORITHMS)[number];

export interface ImPeer {
  peerServerId: string;
  peerAgentId: string;
  displayName: string;
  verified: boolean;
  fingerprint: string;
  peerVerifiedUs?: boolean;
}

export interface ImPeerDevice {
  peerServerId: string;
  peerAgentId: string;
  deviceId: string;
  name: string;
  publicKey: string;
  algorithm: ImKeyAlgorithm;
  status: string;
  enrolledAt: number | null;
}

export interface ImLanPeer {
  peerServerId: string;
  peerAgentId: string;
  host: string;
  port: number;
  fingerprint: string;
  algorithm: ImKeyAlgorithm;
  trusted: boolean;
  seenAt: number;
}

export interface ImSignalEnvelope {
  fromServerId: string;
  fromAgentId: string;
  toServerId: string;
  toAgentId: string;
  kind: "offer" | "answer" | "candidate";
  payload: string;
}

export interface ImAccepted {
  accepted: true;
}

export interface ImProfile {
  displayName: string;
  bio: string;
  avatar: string | null;
  searchable: boolean;
  registered: boolean;
}

export interface ImDevice {
  deviceId: string;
  publicKey: string;
  status: ImDeviceState;
  enrolledAt: number | null;
  certExpiresAt: number | null;
  fingerprint?: string | null;
  algorithm?: ImKeyAlgorithm | null;
}

export interface ImAttachment {
  name: string;
  digest: string;
  size: number;
}

export interface ImMessage {
  localMessageId: string;
  remoteMessageId: string;
  threadId: string;
  senderKind: ImSenderKind;
  senderAgentId: string | null;
  deviceId: string | null;
  body: string;
  attachments: ImAttachment[];
  replyTo: string | null;
  proxiedBy: string | null;
  proxyVisibility: ImProxyVisibility | null;
  causalChainId: string | null;
  sentAt: number;
  expiresAt: number;
  withdrawnAt: number | null;
  verified: boolean;
}

export interface ImDelivery {
  deliveryId: string;
  localMessageId: string;
  state: ImDeliveryState;
  attempts: number;
  createdAt: number;
  ackedAt: number | null;
  error: string | null;
}

export interface ImThread {
  threadId: string;
  peerServerId: string;
  peerAgentId: string;
  assignees: string[];
  primary: string | null;
  lastMessageAt: number | null;
  unread: number;
}

export interface ImContact {
  contactId: string;
  peerServerId: string;
  peerAgentId: string;
  alias: string | null;
  state: ImContactState;
  addedAt: number;
}

export interface ImBlockRule {
  ruleId: string;
  peerServerId: string;
  peerAgentId: string;
  createdAt: number;
  reason: string | null;
}

export interface ImReport {
  reportId: string;
  targetPeer: string;
  category: ImReportCategory;
  detail: string | null;
  status: ImReportState;
  createdAt: number;
  resolvedAt: number | null;
}

export interface ImPresence {
  peerServerId: string;
  peerAgentId: string;
  state: ImPresenceState;
}

export interface ImProxySettings {
  enabled: boolean;
  visibility: ImProxyVisibility;
  monthlyBudgetUsd: number;
}

export interface ImNotificationSettings {
  threadId: string | null;
  mutedUntil: number | null;
  notifyOn: ImNotifyOn;
  showPreview: boolean;
  sendReadReceipts?: boolean;
}

export interface ImSearchResult {
  peerServerId: string;
  peerAgentId: string;
  displayName: string;
  searchable: boolean;
}

export interface ImAuditEntry {
  id: string;
  actorId: string;
  sourceTrustDomain: string;
  action: string;
  targetId: string;
  result: string;
  correlationId: string;
  at: number;
  redactedDetail: string | null;
}

export interface ImChannelMember {
  channelId: string;
  peerServerId: string;
  peerAgentId: string;
  role: ImChannelRole;
}

export interface ImEnrollChallenge {
  deviceId: string;
  pairingCode: string;
  fingerprint: string;
  expiresAt: number;
  devicePublicKey?: string | null;
  algorithm?: ImKeyAlgorithm | null;
}

export interface ImPage<Item> {
  items: Item[];
  next: string | null;
}

export interface ImSendMessageRequest {
  threadId: string;
  remoteMessageId: string;
  body: string;
  attachments: ImAttachment[];
  replyTo: string | null;
  proxiedBy: string | null;
  proxyVisibility: ImProxyVisibility | null;
}

export interface ImMessageListRequest {
  threadId: string;
  cursor?: string;
}

export interface ImPeersListRequest {
  cursor?: string;
}

export interface ImThreadsListRequest {
  cursor?: string;
}

export interface ImThreadGetRequest {
  threadId: string;
}

export interface ImThreadAssignRequest {
  threadId: string;
  assignees: string[];
  primary: string;
}

export interface ImThreadTransferRequest {
  threadId: string;
  toAgent: string;
}

export interface ImContactsListRequest {
  cursor?: string;
}

export interface ImContactRequestInput {
  peerServerId: string;
  peerAgentId: string;
  note: string | null;
}

export interface ImChannelIdRequest {
  channelId: string;
}

export interface ImContactIdRequest {
  contactId: string;
}

export interface ImBlocklistListRequest {
  cursor?: string;
}

export interface ImBlockAddRequest {
  peerServerId: string;
  peerAgentId: string;
  reason: string | null;
}

export interface ImPeerRefRequest {
  peerServerId: string;
  peerAgentId: string;
}

export interface ImReportCreateRequest {
  targetPeer: string;
  category: ImReportCategory;
  detail: string | null;
}

export interface ImReportsListRequest {
  cursor?: string;
}

export interface ImDeviceIdRequest {
  deviceId: string;
}

export interface ImPeerVerifyRequest {
  peerServerId: string;
  peerAgentId: string;
  fingerprint: string;
}

export class ImProtocolError extends Error {
  readonly code = "im.protocolError";
  readonly label: string;

  constructor(label: string) {
    super(`Invalid ${label}.`);
    this.name = "ImProtocolError";
    this.label = label;
  }
}

function invalid(label: string): never {
  throw new ImProtocolError(label);
}

function strictObject(value: unknown, names: readonly string[], label: string): DynamicRecord {
  if (!isDynamicRecord(value)) invalid(label);
  if (Object.keys(value).some((key) => !names.includes(key))) invalid(label);
  return value;
}

function optionalAlgorithm(value: unknown, label: string): ImKeyAlgorithm | null {
  return value === null || value === undefined ? null : enumOf(value, IM_KEY_ALGORITHMS, label);
}

function decodePeerDevice(value: unknown): ImPeerDevice {
  const entry = strictObject(
    value,
    ["peerServerId", "peerAgentId", "deviceId", "name", "publicKey", "algorithm", "status", "enrolledAt"],
    "IM peer device",
  );
  return {
    peerServerId: identifier(entry.peerServerId, "IM peer device"),
    peerAgentId: identifier(entry.peerAgentId, "IM peer device"),
    deviceId: identifier(entry.deviceId, "IM peer device"),
    name: string(entry.name, "IM peer device", IM_LIMITS.deviceName),
    publicKey: string(entry.publicKey, "IM peer device", 256),
    algorithm: enumOf(entry.algorithm, IM_KEY_ALGORITHMS, "IM peer device"),
    status: string(entry.status, "IM peer device", 32),
    enrolledAt: optionalTimestamp(entry.enrolledAt, "IM peer device"),
  };
}

function decodeLanPeer(value: unknown): ImLanPeer {
  const entry = strictObject(
    value,
    ["peerServerId", "peerAgentId", "host", "port", "fingerprint", "algorithm", "trusted", "seenAt"],
    "IM lan peer",
  );
  return {
    peerServerId: identifier(entry.peerServerId, "IM lan peer"),
    peerAgentId: identifier(entry.peerAgentId, "IM lan peer"),
    host: string(entry.host, "IM lan peer", 255),
    port: timestamp(entry.port, "IM lan peer"),
    fingerprint: string(entry.fingerprint, "IM lan peer", IM_LIMITS.fingerprint),
    algorithm: enumOf(entry.algorithm, IM_KEY_ALGORITHMS, "IM lan peer"),
    trusted: flag(entry.trusted, "IM lan peer"),
    seenAt: timestamp(entry.seenAt, "IM lan peer"),
  };
}

function decodeSignal(value: unknown): ImSignalEnvelope {
  const entry = strictObject(
    value,
    ["fromServerId", "fromAgentId", "toServerId", "toAgentId", "kind", "payload"],
    "IM signal",
  );
  return {
    fromServerId: identifier(entry.fromServerId, "IM signal"),
    fromAgentId: identifier(entry.fromAgentId, "IM signal"),
    toServerId: identifier(entry.toServerId, "IM signal"),
    toAgentId: identifier(entry.toAgentId, "IM signal"),
    kind: enumOf(entry.kind, ["offer", "answer", "candidate"], "IM signal"),
    payload: string(entry.payload, "IM signal", 256 * 1024),
  };
}

function string(value: unknown, label: string, limit: number): string {
  if (!isBoundedString(value, limit)) invalid(label);
  return value;
}

function optionalString(value: unknown, label: string, limit: number): string | null {
  return value === null || value === undefined ? null : string(value, label, limit);
}

function identifier(value: unknown, label: string): string {
  if (!isIdentifier(value)) invalid(label);
  return value;
}

function optionalIdentifier(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : identifier(value, label);
}

function timestamp(value: unknown, label: string): number {
  if (!isNumber(value) || !Number.isFinite(value)) invalid(label);
  return value;
}

function optionalTimestamp(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : timestamp(value, label);
}

function flag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(label);
  return value;
}

function enumOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (!isOneOf(values, value)) invalid(label);
  return value;
}

function optionalEnum<T extends string>(value: unknown, values: readonly T[], label: string): T | null {
  return value === null || value === undefined ? null : enumOf(value, values, label);
}

function list<T>(value: unknown, decode: (item: unknown) => T, label: string): T[] {
  if (!Array.isArray(value)) invalid(label);
  return value.map(decode);
}

function page<T>(value: unknown, decodeItem: (item: unknown) => T, label: string): ImPage<T> {
  const entry = strictObject(value, ["items", "next"], label);
  return {
    items: list(entry.items, decodeItem, label),
    next: entry.next === null ? null : string(entry.next, label, IM_LIMITS.cursor),
  };
}

function decodeAttachment(value: unknown): ImAttachment {
  const entry = strictObject(value, ["name", "digest", "size"], "IM attachment");
  return {
    name: string(entry.name, "IM attachment", 255),
    digest: string(entry.digest, "IM attachment", 128),
    size: timestamp(entry.size, "IM attachment"),
  };
}

function decodePeer(value: unknown): ImPeer {
  const entry = strictObject(
    value,
    ["peerServerId", "peerAgentId", "displayName", "verified", "fingerprint", "peerVerifiedUs"],
    "IM peer",
  );
  return {
    peerServerId: identifier(entry.peerServerId, "IM peer"),
    peerAgentId: identifier(entry.peerAgentId, "IM peer"),
    displayName: string(entry.displayName, "IM peer", IM_LIMITS.displayName),
    verified: flag(entry.verified, "IM peer"),
    fingerprint: string(entry.fingerprint, "IM peer", IM_LIMITS.fingerprint),
    ...(entry.peerVerifiedUs === undefined ? {} : { peerVerifiedUs: flag(entry.peerVerifiedUs, "IM peer") }),
  };
}

function decodeProfile(value: unknown): ImProfile {
  const entry = strictObject(value, ["displayName", "bio", "avatar", "searchable", "registered"], "IM profile");
  return {
    displayName: string(entry.displayName, "IM profile", IM_LIMITS.displayName),
    bio: string(entry.bio, "IM profile", IM_LIMITS.bio),
    avatar: optionalString(entry.avatar, "IM profile", 512),
    searchable: flag(entry.searchable, "IM profile"),
    registered: flag(entry.registered, "IM profile"),
  };
}

function decodeDevice(value: unknown): ImDevice {
  const entry = strictObject(
    value,
    ["deviceId", "publicKey", "status", "enrolledAt", "certExpiresAt", "fingerprint", "algorithm"],
    "IM device",
  );
  return {
    deviceId: identifier(entry.deviceId, "IM device"),
    publicKey: string(entry.publicKey, "IM device", 256),
    status: enumOf(entry.status, IM_DEVICE_STATES, "IM device"),
    enrolledAt: optionalTimestamp(entry.enrolledAt, "IM device"),
    certExpiresAt: optionalTimestamp(entry.certExpiresAt, "IM device"),
    fingerprint: optionalString(entry.fingerprint, "IM device", IM_LIMITS.fingerprint),
    algorithm: optionalAlgorithm(entry.algorithm, "IM device"),
  };
}

function decodeMessage(value: unknown): ImMessage {
  const entry = strictObject(
    value,
    [
      "localMessageId",
      "remoteMessageId",
      "threadId",
      "senderKind",
      "senderAgentId",
      "deviceId",
      "body",
      "attachments",
      "replyTo",
      "proxiedBy",
      "proxyVisibility",
      "causalChainId",
      "sentAt",
      "expiresAt",
      "withdrawnAt",
      "verified",
    ],
    "IM message",
  );
  return {
    localMessageId: identifier(entry.localMessageId, "IM message"),
    remoteMessageId: string(entry.remoteMessageId, "IM message", IM_LIMITS.remoteMessageId),
    threadId: identifier(entry.threadId, "IM message"),
    senderKind: enumOf(entry.senderKind, IM_SENDER_KINDS, "IM message"),
    senderAgentId: optionalIdentifier(entry.senderAgentId, "IM message"),
    deviceId: optionalIdentifier(entry.deviceId, "IM message"),
    body: string(entry.body, "IM message", IM_LIMITS.body),
    attachments: list(entry.attachments, decodeAttachment, "IM message"),
    replyTo: optionalIdentifier(entry.replyTo, "IM message"),
    proxiedBy: optionalIdentifier(entry.proxiedBy, "IM message"),
    proxyVisibility: optionalEnum(entry.proxyVisibility, IM_PROXY_VISIBILITY, "IM message"),
    causalChainId: optionalIdentifier(entry.causalChainId, "IM message"),
    sentAt: timestamp(entry.sentAt, "IM message"),
    expiresAt: timestamp(entry.expiresAt, "IM message"),
    withdrawnAt: optionalTimestamp(entry.withdrawnAt, "IM message"),
    verified: flag(entry.verified, "IM message"),
  };
}

function decodeDelivery(value: unknown): ImDelivery {
  const entry = strictObject(
    value,
    ["deliveryId", "localMessageId", "state", "attempts", "createdAt", "ackedAt", "error"],
    "IM delivery",
  );
  return {
    deliveryId: identifier(entry.deliveryId, "IM delivery"),
    localMessageId: identifier(entry.localMessageId, "IM delivery"),
    state: enumOf(entry.state, IM_DELIVERY_STATES, "IM delivery"),
    attempts: timestamp(entry.attempts, "IM delivery"),
    createdAt: timestamp(entry.createdAt, "IM delivery"),
    ackedAt: optionalTimestamp(entry.ackedAt, "IM delivery"),
    error: optionalString(entry.error, "IM delivery", 2_000),
  };
}

function decodeThread(value: unknown): ImThread {
  const entry = strictObject(
    value,
    ["threadId", "peerServerId", "peerAgentId", "assignees", "primary", "lastMessageAt", "unread"],
    "IM thread",
  );
  return {
    threadId: identifier(entry.threadId, "IM thread"),
    peerServerId: identifier(entry.peerServerId, "IM thread"),
    peerAgentId: identifier(entry.peerAgentId, "IM thread"),
    assignees: list(entry.assignees, (item) => identifier(item, "IM thread"), "IM thread"),
    primary: optionalIdentifier(entry.primary, "IM thread"),
    lastMessageAt: optionalTimestamp(entry.lastMessageAt, "IM thread"),
    unread: timestamp(entry.unread, "IM thread"),
  };
}

function decodeContact(value: unknown): ImContact {
  const entry = strictObject(
    value,
    ["contactId", "peerServerId", "peerAgentId", "alias", "state", "addedAt"],
    "IM contact",
  );
  return {
    contactId: identifier(entry.contactId, "IM contact"),
    peerServerId: identifier(entry.peerServerId, "IM contact"),
    peerAgentId: identifier(entry.peerAgentId, "IM contact"),
    alias: optionalString(entry.alias, "IM contact", IM_LIMITS.displayName),
    state: enumOf(entry.state, IM_CONTACT_STATES, "IM contact"),
    addedAt: timestamp(entry.addedAt, "IM contact"),
  };
}

function decodeBlockRule(value: unknown): ImBlockRule {
  const entry = strictObject(value, ["ruleId", "peerServerId", "peerAgentId", "createdAt", "reason"], "IM block rule");
  return {
    ruleId: identifier(entry.ruleId, "IM block rule"),
    peerServerId: identifier(entry.peerServerId, "IM block rule"),
    peerAgentId: identifier(entry.peerAgentId, "IM block rule"),
    createdAt: timestamp(entry.createdAt, "IM block rule"),
    reason: optionalString(entry.reason, "IM block rule", IM_LIMITS.note),
  };
}

function decodeReport(value: unknown): ImReport {
  const entry = strictObject(
    value,
    ["reportId", "targetPeer", "category", "detail", "status", "createdAt", "resolvedAt"],
    "IM report",
  );
  return {
    reportId: identifier(entry.reportId, "IM report"),
    targetPeer: string(entry.targetPeer, "IM report", 512),
    category: enumOf(entry.category, IM_REPORT_CATEGORIES, "IM report"),
    detail: optionalString(entry.detail, "IM report", IM_LIMITS.detail),
    status: enumOf(entry.status, IM_REPORT_STATES, "IM report"),
    createdAt: timestamp(entry.createdAt, "IM report"),
    resolvedAt: optionalTimestamp(entry.resolvedAt, "IM report"),
  };
}

function decodePresence(value: unknown): ImPresence {
  const entry = strictObject(value, ["peerServerId", "peerAgentId", "state"], "IM presence");
  return {
    peerServerId: identifier(entry.peerServerId, "IM presence"),
    peerAgentId: identifier(entry.peerAgentId, "IM presence"),
    state: enumOf(entry.state, IM_PRESENCE_STATES, "IM presence"),
  };
}

function decodeProxySettings(value: unknown): ImProxySettings {
  const entry = strictObject(value, ["enabled", "visibility", "monthlyBudgetUsd"], "IM proxy settings");
  return {
    enabled: flag(entry.enabled, "IM proxy settings"),
    visibility: enumOf(entry.visibility, IM_PROXY_VISIBILITY, "IM proxy settings"),
    monthlyBudgetUsd: timestamp(entry.monthlyBudgetUsd, "IM proxy settings"),
  };
}

function decodeNotificationSettings(value: unknown): ImNotificationSettings {
  const entry = strictObject(value, ["threadId", "mutedUntil", "notifyOn", "showPreview"], "IM notification settings");
  return {
    threadId: optionalIdentifier(entry.threadId, "IM notification settings"),
    mutedUntil: optionalTimestamp(entry.mutedUntil, "IM notification settings"),
    notifyOn: enumOf(entry.notifyOn, IM_NOTIFY_ON, "IM notification settings"),
    showPreview: flag(entry.showPreview, "IM notification settings"),
  };
}

function decodeSearchResult(value: unknown): ImSearchResult {
  const entry = strictObject(value, ["peerServerId", "peerAgentId", "displayName", "searchable"], "IM search result");
  return {
    peerServerId: identifier(entry.peerServerId, "IM search result"),
    peerAgentId: identifier(entry.peerAgentId, "IM search result"),
    displayName: string(entry.displayName, "IM search result", IM_LIMITS.displayName),
    searchable: flag(entry.searchable, "IM search result"),
  };
}

function decodeAuditEntry(value: unknown): ImAuditEntry {
  const entry = strictObject(
    value,
    ["id", "actorId", "sourceTrustDomain", "action", "targetId", "result", "correlationId", "at", "redactedDetail"],
    "IM audit entry",
  );
  return {
    id: identifier(entry.id, "IM audit entry"),
    actorId: string(entry.actorId, "IM audit entry", 512),
    sourceTrustDomain: string(entry.sourceTrustDomain, "IM audit entry", 128),
    action: string(entry.action, "IM audit entry", 128),
    targetId: string(entry.targetId, "IM audit entry", 512),
    result: string(entry.result, "IM audit entry", 64),
    correlationId: string(entry.correlationId, "IM audit entry", 128),
    at: timestamp(entry.at, "IM audit entry"),
    redactedDetail: optionalString(entry.redactedDetail, "IM audit entry", 2_000),
  };
}

function decodeChannelMember(value: unknown): ImChannelMember {
  const entry = strictObject(value, ["channelId", "peerServerId", "peerAgentId", "role"], "IM channel member");
  return {
    channelId: identifier(entry.channelId, "IM channel member"),
    peerServerId: identifier(entry.peerServerId, "IM channel member"),
    peerAgentId: identifier(entry.peerAgentId, "IM channel member"),
    role: enumOf(entry.role, IM_CHANNEL_ROLES, "IM channel member"),
  };
}

function decodeEnrollChallenge(value: unknown): ImEnrollChallenge {
  const entry = strictObject(
    value,
    ["deviceId", "pairingCode", "fingerprint", "expiresAt", "devicePublicKey", "algorithm"],
    "IM enroll challenge",
  );
  return {
    deviceId: identifier(entry.deviceId, "IM enroll challenge"),
    pairingCode: string(entry.pairingCode, "IM enroll challenge", IM_LIMITS.pairingCode),
    fingerprint: string(entry.fingerprint, "IM enroll challenge", IM_LIMITS.fingerprint),
    expiresAt: timestamp(entry.expiresAt, "IM enroll challenge"),
    devicePublicKey: optionalString(entry.devicePublicKey, "IM enroll challenge", 256),
    algorithm: optionalAlgorithm(entry.algorithm, "IM enroll challenge"),
  };
}

export function decodeImContact(value: unknown): ImContact {
  return decodeContact(value);
}

export function decodeImBlockRule(value: unknown): ImBlockRule {
  return decodeBlockRule(value);
}

export function decodeImReport(value: unknown): ImReport {
  return decodeReport(value);
}

export function decodeImPeer(value: unknown): ImPeer {
  return decodePeer(value);
}

export function decodeImPeers(value: unknown): ImPage<ImPeer> {
  return page(value, decodePeer, "IM peers");
}

export function decodeImProfile(value: unknown): ImProfile {
  return decodeProfile(value);
}

export function decodeImDevice(value: unknown): ImDevice {
  return decodeDevice(value);
}

export function decodeImPeerDevice(value: unknown): ImPeerDevice {
  return decodePeerDevice(value);
}

export function decodeImPeerDevices(value: unknown): ImPage<ImPeerDevice> {
  return page(value, decodePeerDevice, "IM peer devices");
}

export function decodeImLanPeer(value: unknown): ImLanPeer {
  return decodeLanPeer(value);
}

export function decodeImLanPeers(value: unknown): ImPage<ImLanPeer> {
  return page(value, decodeLanPeer, "IM lan peers");
}

export function decodeImSignal(value: unknown): ImSignalEnvelope {
  return decodeSignal(value);
}

export function decodeImAccepted(value: unknown): ImAccepted {
  const entry = strictObject(value, ["accepted"], "IM accepted");
  if (entry.accepted !== true) invalid("IM accepted");
  return { accepted: true };
}

export function parseImPeerDeviceRef(value: unknown): { peerServerId: string; peerAgentId: string } {
  const entry = strictObject(value, ["peerServerId", "peerAgentId"], "IM peer device ref");
  return {
    peerServerId: identifier(entry.peerServerId, "IM peer device ref"),
    peerAgentId: identifier(entry.peerAgentId, "IM peer device ref"),
  };
}

export function parseImSignal(value: unknown): ImSignalEnvelope {
  return decodeSignal(value);
}

export function decodeImDevices(value: unknown): ImPage<ImDevice> {
  return page(value, decodeDevice, "IM devices");
}

export function decodeImMessage(value: unknown): ImMessage {
  return decodeMessage(value);
}

export function decodeImMessages(value: unknown): ImPage<ImMessage> {
  return page(value, decodeMessage, "IM messages");
}

export function decodeImDelivery(value: unknown): ImDelivery {
  return decodeDelivery(value);
}

export function decodeImThread(value: unknown): ImThread {
  return decodeThread(value);
}

export function decodeImThreads(value: unknown): ImPage<ImThread> {
  return page(value, decodeThread, "IM threads");
}

export function decodeImContacts(value: unknown): ImPage<ImContact> {
  return page(value, decodeContact, "IM contacts");
}

export function decodeImBlockRules(value: unknown): ImPage<ImBlockRule> {
  return page(value, decodeBlockRule, "IM block rules");
}

export function decodeImReports(value: unknown): ImPage<ImReport> {
  return page(value, decodeReport, "IM reports");
}

export function decodeImPresenceList(value: unknown): ImPage<ImPresence> {
  return page(value, decodePresence, "IM presence");
}

export function decodeImProxySettings(value: unknown): ImProxySettings {
  return decodeProxySettings(value);
}

export function decodeImNotificationSettings(value: unknown): ImNotificationSettings {
  return decodeNotificationSettings(value);
}

export function decodeImSearchResults(value: unknown): ImPage<ImSearchResult> {
  return page(value, decodeSearchResult, "IM search results");
}

export function decodeImAuditEntries(value: unknown): ImPage<ImAuditEntry> {
  return page(value, decodeAuditEntry, "IM audit entries");
}

export function decodeImChannelMember(value: unknown): ImChannelMember {
  return decodeChannelMember(value);
}

export function decodeImEnrollChallenge(value: unknown): ImEnrollChallenge {
  return decodeEnrollChallenge(value);
}

export function parseImPeerRef(value: unknown): { peerServerId: string; peerAgentId: string } {
  const entry = strictObject(value, ["peerServerId", "peerAgentId"], "IM peer reference");
  return {
    peerServerId: identifier(entry.peerServerId, "IM peer reference"),
    peerAgentId: identifier(entry.peerAgentId, "IM peer reference"),
  };
}

export function parseImCursor(value: unknown): { cursor?: string } {
  if (value === undefined || value === null) return {};
  const entry = strictObject(value, ["cursor"], "IM page request");
  return entry.cursor === undefined ? {} : { cursor: string(entry.cursor, "IM page request", IM_LIMITS.cursor) };
}

export function parseImSendMessage(value: unknown): {
  threadId: string;
  remoteMessageId: string;
  body: string;
  attachments: ImAttachment[];
  replyTo: string | null;
  proxiedBy: string | null;
  proxyVisibility: ImProxyVisibility | null;
} {
  const entry = strictObject(
    value,
    ["threadId", "remoteMessageId", "body", "attachments", "replyTo", "proxiedBy", "proxyVisibility"],
    "IM send message",
  );
  const proxiedBy = optionalIdentifier(entry.proxiedBy, "IM send message");
  const proxyVisibility = optionalEnum(entry.proxyVisibility, IM_PROXY_VISIBILITY, "IM send message");
  if (proxiedBy !== null && proxyVisibility === null) invalid("IM send message");
  return {
    threadId: identifier(entry.threadId, "IM send message"),
    remoteMessageId: string(entry.remoteMessageId, "IM send message", IM_LIMITS.remoteMessageId),
    body: string(entry.body, "IM send message", IM_LIMITS.body),
    attachments: entry.attachments === undefined ? [] : list(entry.attachments, decodeAttachment, "IM send message"),
    replyTo: optionalIdentifier(entry.replyTo, "IM send message"),
    proxiedBy,
    proxyVisibility,
  };
}

export function parseImAck(value: unknown): { threadId: string; messageIds: string[] } {
  const entry = strictObject(value, ["threadId", "messageIds"], "IM ack");
  const messageIds = list(entry.messageIds, (item) => identifier(item, "IM ack"), "IM ack");
  if (messageIds.length === 0 || messageIds.length > IM_LIMITS.ackBatch) invalid("IM ack");
  return { threadId: identifier(entry.threadId, "IM ack"), messageIds };
}

export function parseImRead(value: unknown): { threadId: string; lastReadLocalMessageId: string } {
  const entry = strictObject(value, ["threadId", "lastReadLocalMessageId"], "IM read");
  return {
    threadId: identifier(entry.threadId, "IM read"),
    lastReadLocalMessageId: identifier(entry.lastReadLocalMessageId, "IM read"),
  };
}

export function parseImVerifyFingerprint(value: unknown): { fingerprint: string } {
  const entry = strictObject(value, ["fingerprint"], "IM verify");
  return { fingerprint: string(entry.fingerprint, "IM verify", IM_LIMITS.fingerprint) };
}

export function parseImMessageList(value: unknown): ImMessageListRequest {
  const entry = strictObject(value, ["threadId", "cursor"], "IM message list");
  return {
    threadId: identifier(entry.threadId, "IM message list"),
    ...(entry.cursor === undefined ? {} : { cursor: string(entry.cursor, "IM message list", IM_LIMITS.cursor) }),
  };
}

export function parseImThreadId(value: unknown): { threadId: string } {
  const entry = strictObject(value, ["threadId"], "IM thread");
  return { threadId: identifier(entry.threadId, "IM thread") };
}

export function parseImChannelId(value: unknown): { channelId: string } {
  const entry = strictObject(value, ["channelId"], "IM channel");
  return { channelId: identifier(entry.channelId, "IM channel") };
}

export function parseImContactId(value: unknown): { contactId: string } {
  const entry = strictObject(value, ["contactId"], "IM contact");
  return { contactId: identifier(entry.contactId, "IM contact") };
}

export function parseImPeerVerify(value: unknown): ImPeerVerifyRequest {
  const entry = strictObject(value, ["peerServerId", "peerAgentId", "fingerprint"], "IM peer verify");
  return {
    peerServerId: identifier(entry.peerServerId, "IM peer verify"),
    peerAgentId: identifier(entry.peerAgentId, "IM peer verify"),
    fingerprint: string(entry.fingerprint, "IM peer verify", IM_LIMITS.fingerprint),
  };
}

export function parseImDeviceId(value: unknown): { deviceId: string } {
  const entry = strictObject(value, ["deviceId"], "IM device");
  return { deviceId: identifier(entry.deviceId, "IM device") };
}

export function parseImEnrollBegin(value: unknown): { deviceName: string; publicKey: string } {
  const entry = strictObject(value, ["deviceName", "publicKey"], "IM enroll begin");
  return {
    deviceName: string(entry.deviceName, "IM enroll begin", IM_LIMITS.deviceName),
    publicKey: string(entry.publicKey, "IM enroll begin", 256),
  };
}

export function parseImEnrollApprove(value: unknown): { deviceId: string; pairingCode: string } {
  const entry = strictObject(value, ["deviceId", "pairingCode"], "IM enroll approve");
  return {
    deviceId: identifier(entry.deviceId, "IM enroll approve"),
    pairingCode: string(entry.pairingCode, "IM enroll approve", IM_LIMITS.pairingCode),
  };
}

export function parseImUpdateProfile(value: unknown): {
  displayName: string;
  bio: string;
  avatar: string | null;
  searchable: boolean;
} {
  const entry = strictObject(value, ["displayName", "bio", "avatar", "searchable"], "IM update profile");
  return {
    displayName: string(entry.displayName, "IM update profile", IM_LIMITS.displayName),
    bio: entry.bio === undefined ? "" : string(entry.bio, "IM update profile", IM_LIMITS.bio),
    avatar: optionalString(entry.avatar, "IM update profile", 512),
    searchable: flag(entry.searchable, "IM update profile"),
  };
}

export function parseImContactRequest(value: unknown): {
  peerServerId: string;
  peerAgentId: string;
  note: string | null;
} {
  const entry = strictObject(value, ["peerServerId", "peerAgentId", "note"], "IM contact request");
  const peer = parseImPeerRef({ peerServerId: entry.peerServerId, peerAgentId: entry.peerAgentId });
  return { ...peer, note: optionalString(entry.note, "IM contact request", IM_LIMITS.note) };
}

export function parseImBlockAdd(value: unknown): {
  peerServerId: string;
  peerAgentId: string;
  reason: string | null;
} {
  const entry = strictObject(value, ["peerServerId", "peerAgentId", "reason"], "IM block");
  const peer = parseImPeerRef({ peerServerId: entry.peerServerId, peerAgentId: entry.peerAgentId });
  return { ...peer, reason: optionalString(entry.reason, "IM block", IM_LIMITS.note) };
}

export function parseImReportCreate(value: unknown): {
  targetPeer: string;
  category: ImReportCategory;
  detail: string | null;
} {
  const entry = strictObject(value, ["targetPeer", "category", "detail"], "IM report create");
  return {
    targetPeer: string(entry.targetPeer, "IM report create", 512),
    category: enumOf(entry.category, IM_REPORT_CATEGORIES, "IM report create"),
    detail: optionalString(entry.detail, "IM report create", IM_LIMITS.detail),
  };
}

export function parseImProxySet(value: unknown): ImProxySettings {
  const entry = strictObject(value, ["enabled", "visibility", "monthlyBudgetUsd"], "IM proxy set");
  const settings = decodeProxySettings(entry);
  if (settings.monthlyBudgetUsd < 0 || settings.monthlyBudgetUsd > IM_LIMITS.monthlyBudgetUsd) invalid("IM proxy set");
  return settings;
}

export function parseImNotificationGet(value: unknown): { threadId: string } {
  const entry = strictObject(value, ["threadId"], "IM notifications");
  return { threadId: identifier(entry.threadId, "IM notifications") };
}

export function parseImNotificationSet(value: unknown): ImNotificationSettings {
  return decodeNotificationSettings(
    strictObject(value, ["threadId", "mutedUntil", "notifyOn", "showPreview"], "IM notifications"),
  );
}

export function parseImPresenceQuery(value: unknown): {
  peers: { peerServerId: string; peerAgentId: string }[];
} {
  const entry = strictObject(value, ["peers"], "IM presence query");
  return { peers: list(entry.peers, parseImPeerRef, "IM presence query") };
}

export function parseImSearchQuery(value: unknown): { q: string; cursor?: string } {
  const entry = strictObject(value, ["q", "cursor"], "IM search");
  const page = parseImCursor(entry);
  return { q: string(entry.q, "IM search", IM_LIMITS.query), ...page };
}

export function parseImAuditQuery(value: unknown): {
  cursor?: string;
  action: string | null;
  from: number | null;
  to: number | null;
} {
  const entry = strictObject(value, ["cursor", "action", "from", "to"], "IM audit query");
  const page = parseImCursor(entry);
  return {
    ...page,
    action: optionalString(entry.action, "IM audit query", 128),
    from: optionalTimestamp(entry.from, "IM audit query"),
    to: optionalTimestamp(entry.to, "IM audit query"),
  };
}

export function parseImAuditExport(value: unknown): { format: "json" | "csv" } {
  const entry = strictObject(value, ["format"], "IM audit export");
  return { format: enumOf(entry.format, ["json", "csv"] as const, "IM audit export") };
}

export function parseImChannelMemberChange(value: unknown): {
  channelId: string;
  peerServerId: string;
  peerAgentId: string;
  role: ImChannelRole;
} {
  const entry = strictObject(value, ["channelId", "peerServerId", "peerAgentId", "role"], "IM channel member change");
  return {
    channelId: identifier(entry.channelId, "IM channel member change"),
    ...parseImPeerRef({ peerServerId: entry.peerServerId, peerAgentId: entry.peerAgentId }),
    role: enumOf(entry.role, IM_CHANNEL_ROLES, "IM channel member change"),
  };
}

export function parseImWithdraw(value: unknown): { threadId: string; localMessageId: string } {
  const entry = strictObject(value, ["threadId", "localMessageId"], "IM withdraw");
  return {
    threadId: identifier(entry.threadId, "IM withdraw"),
    localMessageId: identifier(entry.localMessageId, "IM withdraw"),
  };
}

export function parseImDeliveryId(value: unknown): { deliveryId: string } {
  const entry = strictObject(value, ["deliveryId"], "IM delivery");
  return { deliveryId: identifier(entry.deliveryId, "IM delivery") };
}

export function parseImResend(value: unknown): { deliveryId: string } {
  const entry = strictObject(value, ["deliveryId"], "IM resend");
  return { deliveryId: identifier(entry.deliveryId, "IM resend") };
}

export function parseImAssign(value: unknown): { threadId: string; assignees: string[]; primary: string } {
  const entry = strictObject(value, ["threadId", "assignees", "primary"], "IM assign");
  return {
    threadId: identifier(entry.threadId, "IM assign"),
    assignees: list(entry.assignees, (item) => identifier(item, "IM assign"), "IM assign"),
    primary: identifier(entry.primary, "IM assign"),
  };
}

export function parseImTransfer(value: unknown): { threadId: string; toAgent: string } {
  const entry = strictObject(value, ["threadId", "toAgent"], "IM transfer");
  return { threadId: identifier(entry.threadId, "IM transfer"), toAgent: identifier(entry.toAgent, "IM transfer") };
}

export function parseImPresenceHidden(value: unknown): { hidden: boolean } {
  const entry = strictObject(value, ["hidden"], "IM presence hidden");
  return { hidden: flag(entry.hidden, "IM presence hidden") };
}

export function parseImConfirm(value: unknown): { confirm: string } {
  const entry = strictObject(value, ["confirm"], "IM confirm");
  return { confirm: string(entry.confirm, "IM confirm", 256) };
}

export const imFromHost = {
  peer: decodePeer,
  peers: (value: unknown) => page(value, decodePeer, "IM peers"),
  message: decodeMessage,
  messages: (value: unknown) => page(value, decodeMessage, "IM messages"),
  delivery: decodeDelivery,
  thread: decodeThread,
  threads: (value: unknown) => page(value, decodeThread, "IM threads"),
  presence: (value: unknown) => page(value, decodePresence, "IM presence"),
  enrollChallenge: decodeEnrollChallenge,
  profile: decodeProfile,
  device: decodeDevice,
  devices: (value: unknown) => page(value, decodeDevice, "IM devices"),
};

export const imFromMain = {
  peer: decodePeer,
  peers: (value: unknown) => page(value, decodePeer, "IM peers"),
  message: decodeMessage,
  messages: (value: unknown) => page(value, decodeMessage, "IM messages"),
  delivery: decodeDelivery,
  thread: decodeThread,
  threads: (value: unknown) => page(value, decodeThread, "IM threads"),
  contact: decodeContact,
  contacts: (value: unknown) => page(value, decodeContact, "IM contacts"),
  blockRule: decodeBlockRule,
  blockRules: (value: unknown) => page(value, decodeBlockRule, "IM block rules"),
  report: decodeReport,
  reports: (value: unknown) => page(value, decodeReport, "IM reports"),
  proxySettings: decodeProxySettings,
  notificationSettings: decodeNotificationSettings,
  searchResults: (value: unknown) => page(value, decodeSearchResult, "IM search results"),
  auditEntries: (value: unknown) => page(value, decodeAuditEntry, "IM audit entries"),
  channelMember: decodeChannelMember,
  enrollChallenge: decodeEnrollChallenge,
  profile: decodeProfile,
  device: decodeDevice,
  devices: (value: unknown) => page(value, decodeDevice, "IM devices"),
};
