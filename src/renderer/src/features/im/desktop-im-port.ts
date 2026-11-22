import type { ImHostPort } from "@openbot/team-client/im-client";

const EMPTY_PAGE = { items: [], next: null };

export function desktopImPort(serverId: string): ImHostPort {
  const api = () => window.openbot.im;
  let remote = 0;
  const unavailable = (code: string) => async (): Promise<never> => {
    throw new Error(code);
  };
  return {
    peers: {
      list: () => api().peersList({}, serverId),
    },
    threads: {
      list: async () => EMPTY_PAGE,
      assign: unavailable("im.threadNotFound"),
    },
    messages: {
      list: (threadId) => api().messageList({ threadId }, serverId),
      withdraw: unavailable("im.notFound"),
      send: async (threadId, body, proxy) =>
        api().messageSend(
          {
            threadId,
            remoteMessageId: `remote-${Date.now()}-${++remote}`,
            body,
            attachments: [],
            replyTo: null,
            proxiedBy: proxy?.proxiedBy ?? null,
            proxyVisibility: proxy ? proxy.visibility : null,
          },
          serverId,
        ),
    },
    delivery: {
      list: async () => EMPTY_PAGE,
      read: unavailable("im.notFound"),
      resend: unavailable("im.notFound"),
    },
    presence: {
      list: unavailable("im.notFound"),
    },
    devices: {
      list: async () => EMPTY_PAGE,
      enrollBegin: unavailable("im.notFound"),
      enrollApprove: unavailable("im.notFound"),
      enrollStatus: unavailable("im.notFound"),
      enrollCancel: unavailable("im.notFound"),
      revoke: unavailable("im.notFound"),
    },
    contacts: {
      list: async () => EMPTY_PAGE,
      request: unavailable("im.contactNotFound"),
      accept: unavailable("im.contactNotFound"),
      reject: unavailable("im.contactNotFound"),
    },
    channels: {
      listMembers: async () => EMPTY_PAGE,
      addMember: unavailable("im.notFound"),
      removeMember: unavailable("im.notFound"),
    },
    blocklist: {
      list: async () => EMPTY_PAGE,
      add: unavailable("im.notFound"),
    },
    reports: {
      create: unavailable("im.notFound"),
    },
    proxy: {
      get: unavailable("im.notFound"),
      set: unavailable("im.notFound"),
    },
    notifications: {
      get: unavailable("im.notFound"),
      set: unavailable("im.notFound"),
    },
    profile: {
      get: unavailable("im.notFound"),
      update: unavailable("im.notFound"),
    },
  };
}
