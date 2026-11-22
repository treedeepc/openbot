import type {
  ImAttachment,
  ImAuditEntry,
  ImBlockRule,
  ImContact,
  ImDelivery,
  ImDevice,
  ImEnrollChallenge,
  ImMessage,
  ImNotificationSettings,
  ImPage,
  ImPeer,
  ImPresence,
  ImProfile,
  ImProxySettings,
  ImReport,
  ImSearchResult,
  ImThread,
} from "@openbot/contracts/ipc";

export interface ImMockSeed {
  peers?: ImPeer[];
  messages?: ImMessage[];
  threads?: ImThread[];
  devices?: ImDevice[];
}

export function createMockIm(seed: ImMockSeed = {}) {
  const peers = new Map<string, ImPeer>(
    (seed.peers ?? []).map((peer) => [`${peer.peerServerId}/${peer.peerAgentId}`, peer]),
  );
  const messages = new Map<string, ImMessage>(
    (seed.messages ?? []).map((message) => [message.localMessageId, message]),
  );
  const threads = new Map<string, ImThread>((seed.threads ?? []).map((thread) => [thread.threadId, thread]));
  const devices = new Map<string, ImDevice>((seed.devices ?? []).map((device) => [device.deviceId, device]));
  const challenges = new Map<string, { pairingCode: string; expiresAt: number }>();
  const contacts = new Map<string, ImContact>();
  const blockRules = new Map<string, ImBlockRule>();
  const reports = new Map<string, ImReport>();
  const deliveries = new Map<string, ImDelivery>();
  const audit: ImAuditEntry[] = [];
  const presence = new Map<string, ImPresence>();
  const notifications = new Map<string, ImNotificationSettings>();
  let profile: ImProfile = {
    displayName: "Local person",
    bio: "",
    avatar: null,
    searchable: false,
    registered: false,
  };
  let proxy: ImProxySettings = { enabled: false, visibility: "shown", monthlyBudgetUsd: 20 };
  let hidden = false;
  let clock = 1_700_000_000_000;

  const page = <T>(items: T[]): ImPage<T> => ({ items, next: null });
  const now = () => (clock += 1_000);
  const keyOf = (peer: { peerServerId: string; peerAgentId: string }) => `${peer.peerServerId}/${peer.peerAgentId}`;

  return {
    peers: {
      list: async (): Promise<ImPage<ImPeer>> => page([...peers.values()]),
      verify: async (fingerprint: string): Promise<number> => {
        const at = now();
        for (const peer of peers.values()) {
          if (peer.fingerprint === fingerprint) peers.set(keyOf(peer), { ...peer, verified: true });
        }
        return at;
      },
    },
    profile: {
      get: async (): Promise<ImProfile> => ({ ...profile }),
      update: async (next: ImProfile): Promise<ImProfile> => {
        profile = { ...next };
        return { ...profile };
      },
      deactivate: async (): Promise<number> => {
        profile = { ...profile, registered: false, searchable: false };
        return now();
      },
    },
    devices: {
      list: async (): Promise<ImPage<ImDevice>> => page([...devices.values()]),
      enrollBegin: async (_deviceName: string, publicKey: string) => {
        const deviceId = `mock-device-${devices.size + 1}`;
        const device: ImDevice = {
          deviceId,
          publicKey,
          status: "pending",
          enrolledAt: null,
          certExpiresAt: null,
        };
        devices.set(deviceId, device);
        challenges.set(deviceId, { pairingCode: "1234-5678", expiresAt: Date.now() + 15 * 60_000 });
        return {
          deviceId,
          pairingCode: "1234-5678",
          fingerprint: "4F2A 9C11 7B60 55E3 2B9F C41A 91DE 07B2",
          expiresAt: Date.now() + 15 * 60_000,
          devicePublicKey: publicKey,
          algorithm: "p256-base64url",
        } satisfies ImEnrollChallenge;
      },
      enrollApprove: async (deviceId: string, pairingCode: string) => {
        const device = devices.get(deviceId);
        if (!device) throw new Error("im.deviceUnknown");
        const pending = challenges.get(deviceId);
        if (!pending) throw new Error("im.pairingInvalid");
        if (pending.expiresAt <= Date.now()) throw new Error("im.pairingExpired");
        if (pending.pairingCode !== pairingCode) throw new Error("im.pairingInvalid");
        const enrolled: ImDevice = {
          ...device,
          status: "active",
          enrolledAt: now(),
          certExpiresAt: now() + 90 * 86_400_000,
        };
        devices.set(deviceId, enrolled);
        challenges.delete(deviceId);
        return { device: { ...enrolled }, cert: `mock-cert-${deviceId}` };
      },
      enrollCancel: async (deviceId: string): Promise<void> => {
        const device = devices.get(deviceId);
        if (!device) throw new Error("im.deviceUnknown");
        challenges.delete(deviceId);
        devices.set(deviceId, { ...device, status: "revoked" });
      },
      revoke: async (deviceId: string): Promise<ImDevice> => {
        const device = devices.get(deviceId);
        if (!device) throw new Error("im.deviceUnknown");
        const revoked: ImDevice = { ...device, status: "revoked" };
        devices.set(deviceId, revoked);
        return { ...revoked };
      },
    },
    threads: {
      list: async (): Promise<ImPage<ImThread>> => page([...threads.values()]),
      assign: async (threadId: string, assignees: readonly string[], primary: string): Promise<ImThread> => {
        const thread = threads.get(threadId);
        if (!thread) throw new Error("im.threadNotFound");
        const assigned: ImThread = { ...thread, assignees: [...assignees], primary };
        threads.set(threadId, assigned);
        return { ...assigned };
      },
      transfer: async (threadId: string, toAgent: string): Promise<ImThread> => {
        const thread = threads.get(threadId);
        if (!thread) throw new Error("im.threadNotFound");
        const moved: ImThread = { ...thread, assignees: [toAgent], primary: toAgent };
        threads.set(threadId, moved);
        return { ...moved };
      },
      get: async (threadId: string): Promise<ImThread> => {
        const thread = threads.get(threadId);
        if (!thread) throw new Error("im.threadNotFound");
        return { ...thread };
      },
    },
    messages: {
      list: async (threadId: string): Promise<ImPage<ImMessage>> =>
        page([...messages.values()].filter((message) => message.threadId === threadId)),
      send: async (
        threadId: string,
        remoteMessageId: string,
        body: string,
        attachments: ImAttachment[] = [],
        replyTo: string | null = null,
      ): Promise<{ message: ImMessage; delivery: ImDelivery }> => {
        const sentAt = now();
        const localMessageId = `mock-message-${messages.size + 1}`;
        const message: ImMessage = {
          localMessageId,
          remoteMessageId,
          threadId,
          senderKind: "self",
          senderAgentId: null,
          deviceId: null,
          body,
          attachments,
          replyTo,
          proxiedBy: null,
          proxyVisibility: null,
          causalChainId: null,
          sentAt,
          expiresAt: sentAt + 30 * 86_400_000,
          withdrawnAt: null,
          verified: true,
        };
        messages.set(localMessageId, message);
        const delivery: ImDelivery = {
          deliveryId: `mock-delivery-${deliveries.size + 1}`,
          localMessageId,
          state: "submitted",
          attempts: 1,
          createdAt: sentAt,
          ackedAt: null,
          error: null,
        };
        deliveries.set(delivery.deliveryId, delivery);
        return { message: { ...message }, delivery: { ...delivery } };
      },
      withdraw: async (localMessageId: string): Promise<ImMessage> => {
        const message = messages.get(localMessageId);
        if (!message) throw new Error("im.messageNotFound");
        const withdrawn: ImMessage = { ...message, withdrawnAt: now() };
        messages.set(localMessageId, withdrawn);
        return { ...withdrawn };
      },
    },
    delivery: {
      get: async (deliveryId: string): Promise<ImDelivery> => {
        const delivery = deliveries.get(deliveryId);
        if (!delivery) throw new Error("im.notFound");
        return { ...delivery };
      },
      list: async (threadId: string): Promise<ImPage<ImDelivery>> =>
        page(
          [...deliveries.values()].filter((delivery) => messages.get(delivery.localMessageId)?.threadId === threadId),
        ),
      forMessage: async (localMessageId: string): Promise<ImDelivery | null> => {
        const delivery = [...deliveries.values()].find((entry) => entry.localMessageId === localMessageId);
        return delivery ? { ...delivery } : null;
      },
      ack: async (messageIds: readonly string[]): Promise<void> => {
        for (const id of messageIds) {
          for (const delivery of deliveries.values()) {
            if (delivery.localMessageId === id)
              deliveries.set(delivery.deliveryId, { ...delivery, state: "acked", ackedAt: now() });
          }
        }
      },
      resend: async (deliveryId: string): Promise<ImDelivery> => {
        const delivery = deliveries.get(deliveryId);
        if (!delivery) throw new Error("im.notFound");
        const resent: ImDelivery = { ...delivery, state: "submitted", attempts: delivery.attempts + 1, error: null };
        deliveries.set(deliveryId, resent);
        return { ...resent };
      },
    },
    contacts: {
      list: async (): Promise<ImPage<ImContact>> => page([...contacts.values()]),
      request: async (peer: { peerServerId: string; peerAgentId: string }): Promise<ImContact> => {
        const contact: ImContact = {
          contactId: `mock-contact-${contacts.size + 1}`,
          peerServerId: peer.peerServerId,
          peerAgentId: peer.peerAgentId,
          alias: null,
          state: "pending",
          addedAt: now(),
        };
        contacts.set(contact.contactId, contact);
        return { ...contact };
      },
      accept: async (contactId: string): Promise<ImContact> => {
        const contact = contacts.get(contactId);
        if (!contact) throw new Error("im.contactNotFound");
        const accepted: ImContact = { ...contact, state: "accepted" };
        contacts.set(contactId, accepted);
        return { ...accepted };
      },
      remove: async (contactId: string): Promise<ImContact> => {
        const contact = contacts.get(contactId);
        if (!contact) throw new Error("im.contactNotFound");
        const removed: ImContact = { ...contact, state: "removed" };
        contacts.set(contactId, removed);
        return { ...removed };
      },
      reject: async (contactId: string): Promise<ImContact> => {
        const contact = contacts.get(contactId);
        if (!contact) throw new Error("im.contactNotFound");
        if (contact.state === "removed") return { ...contact };
        const rejected: ImContact = { ...contact, state: "removed" };
        contacts.set(contactId, rejected);
        return { ...rejected };
      },
    },
    blocklist: {
      list: async (): Promise<ImPage<ImBlockRule>> => page([...blockRules.values()]),
      remove: async (peer: { peerServerId: string; peerAgentId: string }): Promise<boolean> => {
        for (const [id, rule] of blockRules) {
          if (rule.peerServerId === peer.peerServerId && rule.peerAgentId === peer.peerAgentId) {
            blockRules.delete(id);
            return true;
          }
        }
        return false;
      },
      add: async (peer: { peerServerId: string; peerAgentId: string }): Promise<ImBlockRule> => {
        const rule: ImBlockRule = {
          ruleId: `mock-rule-${blockRules.size + 1}`,
          peerServerId: peer.peerServerId,
          peerAgentId: peer.peerAgentId,
          createdAt: now(),
          reason: null,
        };
        blockRules.set(rule.ruleId, rule);
        return { ...rule };
      },
    },
    reports: {
      list: async (): Promise<ImPage<ImReport>> => page([...reports.values()]),
      create: async (targetPeer: string, category: ImReport["category"]): Promise<ImReport> => {
        const report: ImReport = {
          reportId: `mock-report-${reports.size + 1}`,
          targetPeer,
          category,
          detail: null,
          status: "open",
          createdAt: now(),
          resolvedAt: null,
        };
        reports.set(report.reportId, report);
        return { ...report };
      },
    },
    presence: {
      get: async (list: readonly { peerServerId: string; peerAgentId: string }[]): Promise<ImPage<ImPresence>> =>
        page(
          list.map(
            (peer) =>
              presence.get(keyOf(peer)) ?? { ...peer, state: hidden ? ("offline" as const) : ("online" as const) },
          ),
        ),
      setHidden: async (value: boolean): Promise<boolean> => {
        hidden = value;
        return hidden;
      },
    },
    proxy: {
      get: async (): Promise<ImProxySettings> => ({ ...proxy }),
      set: async (next: ImProxySettings): Promise<ImProxySettings> => {
        proxy = { ...next };
        return { ...proxy };
      },
    },
    notifications: {
      get: async (threadId: string | null): Promise<ImNotificationSettings> =>
        notifications.get(threadId ?? "") ?? {
          threadId,
          mutedUntil: null,
          notifyOn: "all",
          showPreview: false,
        },
      set: async (next: ImNotificationSettings): Promise<ImNotificationSettings> => {
        notifications.set(next.threadId ?? "", { ...next });
        return { ...next };
      },
    },
    search: {
      query: async (q: string): Promise<ImPage<ImSearchResult>> =>
        page(
          [...peers.values()]
            .filter((peer) => peer.verified && peer.displayName.toLowerCase().includes(q.toLowerCase()))
            .map((peer) => ({
              peerServerId: peer.peerServerId,
              peerAgentId: peer.peerAgentId,
              displayName: peer.displayName,
              searchable: true,
            })),
        ),
    },
    audit: {
      list: async (): Promise<ImPage<ImAuditEntry>> => page([...audit]),
    },
  };
}

export type MockIm = ReturnType<typeof createMockIm>;
