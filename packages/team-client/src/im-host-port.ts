import {
  decodeImBlockRules,
  decodeImChannelMember,
  decodeImContacts,
  decodeImDelivery,
  decodeImDevice,
  decodeImDevices,
  decodeImEnrollChallenge,
  decodeImMessage,
  decodeImMessages,
  decodeImNotificationSettings,
  decodeImPeers,
  decodeImPresenceList,
  decodeImProfile,
  decodeImProxySettings,
  decodeImThread,
  decodeImThreads,
  type ImChannelMember,
  type ImDelivery,
  type ImMessage,
  type ImPage,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { IM_ROUTES } from "@openbot/contracts/team-protocol/im-v1";
import { decodeTeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import type { ImHostPort } from "./im-client";
import type { TeamApiRequest } from "./team-api-requests";

export interface ImHostPortOptions {
  request: () => TeamApiRequest;
  newRemoteMessageId?: (() => string) | undefined;
}

export function imHostPort(options: ImHostPortOptions): ImHostPort {
  const post = <T>(path: string, decode: (value: unknown) => T, body: unknown): Promise<T> =>
    options.request()("POST", path, decode, decodeTeamProtocolV2Json(body));
  const ignore = async (path: string, body: unknown): Promise<void> => {
    await post(path, () => undefined, body);
  };
  const remoteMessageId = options.newRemoteMessageId ?? (() => crypto.randomUUID());
  return {
    peers: {
      list: () => post(IM_ROUTES.peersList, decodeImPeers, {}),
    },
    threads: {
      list: () => post(IM_ROUTES.threadsList, decodeImThreads, {}),
      assign: (threadId, assignees, primary) =>
        post(IM_ROUTES.threadAssign, decodeImThread, { threadId, assignees: [...assignees], primary }),
    },
    messages: {
      list: (threadId) => post(IM_ROUTES.messagesList, decodeImMessages, { threadId }),
      withdraw: (threadId, localMessageId) => ignore(IM_ROUTES.messageWithdraw, { threadId, localMessageId }),
      send: async (threadId, body, proxy): Promise<ImMessage> =>
        post(IM_ROUTES.messageSend, decodeImMessage, {
          threadId,
          remoteMessageId: remoteMessageId(),
          body,
          attachments: [],
          replyTo: null,
          proxiedBy: proxy?.proxiedBy ?? null,
          proxyVisibility: proxy ? proxy.visibility : null,
        }),
    },
    delivery: {
      list: (threadId) => post(IM_ROUTES.deliveryList, decodeDeliveryPage, { threadId }),
      read: (threadId, lastReadLocalMessageId) => ignore(IM_ROUTES.deliveryRead, { threadId, lastReadLocalMessageId }),
      resend: (deliveryId) => post(IM_ROUTES.deliveryResend, decodeImDelivery, { deliveryId }),
    },
    presence: {
      list: (peers) => post(IM_ROUTES.presenceGet, decodeImPresenceList, { peers: peers.map((peer) => ({ ...peer })) }),
    },
    devices: {
      list: () => post(IM_ROUTES.devicesList, decodeImDevices, {}),
      enrollBegin: (deviceName, publicKey) =>
        post(IM_ROUTES.enrollBegin, decodeImEnrollChallenge, { deviceName, publicKey }),
      enrollApprove: (deviceId, pairingCode) => ignore(IM_ROUTES.enrollApprove, { deviceId, pairingCode }),
      enrollStatus: (deviceId) => post(IM_ROUTES.enrollStatus, decodeImDevice, { deviceId }),
      enrollCancel: (deviceId) => ignore(IM_ROUTES.enrollCancel, { deviceId }),
      revoke: (deviceId) => post(IM_ROUTES.deviceRevoke, decodeImDevice, { deviceId }),
    },
    contacts: {
      list: () => post(IM_ROUTES.contactsList, decodeImContacts, {}),
      request: (peer) => ignore(IM_ROUTES.contactRequest, { ...peer, note: null }),
      accept: (contactId) => ignore(IM_ROUTES.contactAccept, { contactId }),
      reject: (contactId) => ignore(IM_ROUTES.contactReject, { contactId }),
    },
    blocklist: {
      list: () => post(IM_ROUTES.blocklistList, decodeImBlockRules, {}),
      add: (peer) => ignore(IM_ROUTES.blocklistAdd, { ...peer, reason: null }),
    },
    channels: {
      listMembers: (channelId) => post(IM_ROUTES.channelMembersList, decodeChannelMemberPage, { channelId }),
      addMember: (channelId, member, role) => ignore(IM_ROUTES.channelMemberAdd, { channelId, ...member, role }),
      removeMember: (channelId, member) => ignore(IM_ROUTES.channelMemberRemove, { channelId, ...member }),
    },
    reports: {
      create: (targetPeer, category) => ignore(IM_ROUTES.reportCreate, { targetPeer, category, detail: null }),
    },
    proxy: {
      get: () => post(IM_ROUTES.proxyGet, decodeImProxySettings, {}),
      set: (next) => post(IM_ROUTES.proxySet, decodeImProxySettings, next),
    },
    notifications: {
      get: (threadId) => post(IM_ROUTES.notificationsGet, decodeImNotificationSettings, { threadId }),
      set: (next) => post(IM_ROUTES.notificationsSet, decodeImNotificationSettings, next),
    },
    profile: {
      get: () => post(IM_ROUTES.profileGet, decodeImProfile, {}),
      update: (next) => post(IM_ROUTES.profileUpdate, decodeImProfile, next),
    },
  };
}

function decodeDeliveryPage(value: unknown): ImPage<ImDelivery> {
  if (!isDynamicRecord(value) || !Array.isArray(value.items)) return { items: [], next: null };
  return { items: value.items.map((item) => decodeImDelivery(item)), next: null };
}

function decodeChannelMemberPage(value: unknown): ImPage<ImChannelMember> {
  if (!isDynamicRecord(value) || !Array.isArray(value.items)) return { items: [], next: null };
  return { items: value.items.map((item) => decodeImChannelMember(item)), next: null };
}
