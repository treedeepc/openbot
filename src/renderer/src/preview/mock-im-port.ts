import type { ImPresenceState } from "@openbot/contracts/ipc";
import type { ImChannelMember, ImContact, ImHostPort, ImPeerRef } from "@openbot/team-client/im-client";
import type { MockIm } from "./mock-im";

export interface MockImPortOptions {
  newRemoteMessageId?: (() => string) | undefined;
  contactAddedAt?: ((contact: ImContact) => number) | undefined;
  extraContacts?: readonly ImContact[] | undefined;
  channelMembers?: readonly ImChannelMember[] | undefined;
  presence?: ((peer: ImPeerRef) => ImPresenceState) | undefined;
}

export function mockImPort(mock: MockIm, options: MockImPortOptions = {}): ImHostPort {
  let remote = 0;
  const remoteMessageId = options.newRemoteMessageId ?? (() => `remote-${++remote}`);
  const peerOf = (peer: ImPeerRef): ImPeerRef => ({ peerServerId: peer.peerServerId, peerAgentId: peer.peerAgentId });
  return {
    peers: {
      list: () => mock.peers.list(),
    },
    threads: {
      list: () => mock.threads.list(),
      assign: (threadId, assignees, primary) => mock.threads.assign(threadId, assignees, primary),
    },
    messages: {
      list: (threadId) => mock.messages.list(threadId),
      withdraw: async (_threadId, localMessageId) => {
        await mock.messages.withdraw(localMessageId);
      },
      send: async (threadId, body, proxy) => {
        const sent = await mock.messages.send(threadId, remoteMessageId(), body);
        return proxy
          ? { ...sent.message, proxiedBy: proxy.proxiedBy, proxyVisibility: proxy.visibility }
          : sent.message;
      },
    },
    delivery: {
      list: (threadId) => mock.delivery.list(threadId),
      read: async () => undefined,
      resend: (deliveryId) => mock.delivery.resend(deliveryId),
    },
    presence: {
      list: async (peers) => ({
        items: peers.map((peer) => ({ ...peerOf(peer), state: options.presence ? options.presence(peer) : "online" })),
        next: null,
      }),
    },
    devices: {
      list: () => mock.devices.list(),
      enrollBegin: (deviceName, publicKey) => mock.devices.enrollBegin(deviceName, publicKey),
      enrollApprove: async (deviceId, pairingCode) => {
        await mock.devices.enrollApprove(deviceId, pairingCode);
      },
      enrollStatus: async (deviceId) => {
        const page = await mock.devices.list();
        const device = page.items.find((item) => item.deviceId === deviceId);
        if (!device) throw new Error("im.notFound");
        return device;
      },
      enrollCancel: async (deviceId) => {
        await mock.devices.enrollCancel(deviceId);
      },
      revoke: (deviceId) => mock.devices.revoke(deviceId),
    },
    contacts: {
      list: async () => {
        const page = await mock.contacts.list();
        const items = [...page.items, ...(options.extraContacts ?? [])].map((contact) => ({
          ...contact,
          addedAt: options.contactAddedAt ? options.contactAddedAt(contact) : contact.addedAt,
        }));
        return { items, next: page.next };
      },
      request: async (peer) => {
        await mock.contacts.request(peerOf(peer));
      },
      accept: async (contactId) => {
        await mock.contacts.accept(contactId);
      },
      reject: async (contactId) => {
        await mock.contacts.reject(contactId);
      },
    },
    channels: {
      listMembers: async () => ({ items: [...(options.channelMembers ?? [])], next: null }),
      addMember: async () => undefined,
      removeMember: async () => undefined,
    },
    blocklist: {
      list: () => mock.blocklist.list(),
      add: async (peer) => {
        await mock.blocklist.add(peerOf(peer));
      },
    },
    reports: {
      create: async (targetPeer, category) => {
        await mock.reports.create(targetPeer, category);
      },
    },
    proxy: {
      get: () => mock.proxy.get(),
      set: (next) => mock.proxy.set(next),
    },
    notifications: {
      get: (threadId) => mock.notifications.get(threadId),
      set: (next) => mock.notifications.set(next),
    },
    profile: {
      get: () => mock.profile.get(),
      update: (next) => mock.profile.update(next),
    },
  };
}
