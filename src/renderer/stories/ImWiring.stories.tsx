import type {
  AppInfo,
  ImBlockRule,
  ImContact,
  ImDevice,
  ImMessage,
  ImPage,
  ImPeer,
  ImThread,
} from "@openbot/contracts/ipc";
import {
  IM_MESSAGES_CAPABILITY,
  IM_PEERS_CAPABILITY,
  IM_ROUTES,
  imCapabilitiesThrough,
} from "@openbot/contracts/team-protocol/im-v1";
import { imHostPort } from "@openbot/team-client/im-host-port";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { ComposerDraft } from "../src/features/conversation/conversation-types";
import { WebImPage } from "../src/features/web-client/WebImPage";
import { type ImEntrySupport, imEntrySupport } from "../src/features/web-client/web-im";
import { PlatformProvider } from "../src/platform";
import { createMockIm } from "../src/preview/mock-im";
import { mockImPort } from "../src/preview/mock-im-port";
import "../src/features/web-client/web-client.css";

const meta = {
  title: "IM/HostWiring",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = 1_700_000_000_000;
const APP_INFO: AppInfo = { name: "OpenBot", version: "web", platform: "darwin", variant: "production" };
const THREAD_ID = "thread-1";

const PEER: ImPeer = {
  peerServerId: "peer-server",
  peerAgentId: "mira",
  displayName: "Mira · 跨实例",
  verified: true,
  fingerprint: "4F2A 9C11 7B60 55E3",
};

const THREAD: ImThread = {
  threadId: THREAD_ID,
  peerServerId: PEER.peerServerId,
  peerAgentId: PEER.peerAgentId,
  assignees: ["agent-1"],
  primary: "agent-1",
  lastMessageAt: NOW,
  unread: 0,
};

const seedMessage = (
  index: number,
  body: string,
  senderKind: ImMessage["senderKind"],
  overrides: Partial<ImMessage> = {},
): ImMessage => ({
  localMessageId: `msg-${index}`,
  remoteMessageId: `remote-${index}`,
  threadId: THREAD_ID,
  senderKind,
  senderAgentId: senderKind === "local-assistant" ? "agent-1" : null,
  deviceId: null,
  body,
  attachments: [],
  replyTo: null,
  proxiedBy: null,
  proxyVisibility: null,
  causalChainId: null,
  sentAt: NOW + index * 60_000,
  expiresAt: NOW + 30 * 86_400_000,
  withdrawnAt: null,
  verified: true,
  ...overrides,
});

const SEED_DEVICES: ImDevice[] = [
  {
    deviceId: "device-macbook",
    publicKey: "ed25519:2b9f…c41a",
    status: "active",
    enrolledAt: NOW - 86_400_000,
    certExpiresAt: NOW + 89 * 86_400_000,
  },
  {
    deviceId: "device-phone",
    publicKey: "ed25519:91de…07b2",
    status: "pending",
    enrolledAt: null,
    certExpiresAt: null,
  },
];

const AGENTS = [
  { id: "agent-1", name: "前端工程师" },
  { id: "agent-2", name: "测试工程师" },
];

function ImWiringStory(props: { support?: ImEntrySupport | undefined }): JSX.Element {
  const mock = createMockIm({
    peers: [PEER],
    threads: [THREAD],
    messages: [
      seedMessage(1, "收到，方案我这边看过了。", "peer"),
      seedMessage(2, "那我们按 P0 先做最小会话。", "self"),
      seedMessage(3, "我把消息流和发送框先搭起来。", "local-assistant", {
        proxiedBy: "agent-1",
        proxyVisibility: "shown",
      }),
    ],
    devices: SEED_DEVICES,
  });
  const [ready, setReady] = createSignal(false);
  const [drafts, setDrafts] = createSignal<Record<string, ComposerDraft>>({});
  void (async () => {
    await mock.delivery.ack(["msg-2"]);
    setReady(true);
  })();
  return (
    <Show when={ready()}>
      <PlatformProvider appInfo={APP_INFO}>
        <div style={{ height: "100vh" }}>
          <WebImPage
            port={mockImPort(mock, {
              channelMembers: [
                {
                  channelId: THREAD.threadId,
                  peerServerId: "peer-server",
                  peerAgentId: "mira",
                  role: "admin",
                },
                {
                  channelId: THREAD.threadId,
                  peerServerId: "peer-server",
                  peerAgentId: "kite",
                  role: "readonly",
                },
              ],
              contactAddedAt: (contact) =>
                contact.contactId === "fixture-expired" ? contact.addedAt : Date.now() - 60_000,
              extraContacts: [
                {
                  contactId: "fixture-expired",
                  peerServerId: "peer-server",
                  peerAgentId: "kite",
                  alias: null,
                  state: "pending",
                  addedAt: Date.now() - 8 * 86_400_000,
                },
              ],
            })}
            support={props.support ?? imEntrySupport(imCapabilitiesThrough("p0"))}
            hostName="Preview host"
            network="server"
            onBack={() => undefined}
            onOpenImSettings={() => undefined}
            agents={AGENTS}
            drafts={drafts}
            setDrafts={setDrafts}
          />
        </div>
      </PlatformProvider>
    </Show>
  );
}

const REAL_FIXTURE = {
  peers: { items: [PEER], next: null },
  threads: { items: [THREAD], next: null },
  messages: {
    items: [
      seedMessage(1, "真端口：路由与解码都走契约。", "peer"),
      seedMessage(2, "收到，同一套 UI 直接切过来。", "self"),
    ],
    next: null,
  },
  contacts: {
    items: [
      {
        contactId: "contact-1",
        peerServerId: "peer-server",
        peerAgentId: "mira",
        alias: null,
        state: "accepted" as const,
        addedAt: Date.now() - 60_000,
      },
    ],
    next: null,
  },
  blocklist: { items: [], next: null },
  devices: { items: SEED_DEVICES, next: null },
};

function RealPortStory(): JSX.Element {
  const [drafts, setDrafts] = createSignal<Record<string, ComposerDraft>>({});
  const calls: string[] = [];
  const request: TeamApiRequest = async (_method, path, decode) => {
    calls.push(path);
    const table: Record<string, ImPage<ImBlockRule | ImContact | ImDevice | ImMessage | ImPeer | ImThread> | null> = {
      [IM_ROUTES.peersList]: REAL_FIXTURE.peers,
      [IM_ROUTES.threadsList]: REAL_FIXTURE.threads,
      [IM_ROUTES.messagesList]: REAL_FIXTURE.messages,
      [IM_ROUTES.contactsList]: REAL_FIXTURE.contacts,
      [IM_ROUTES.blocklistList]: REAL_FIXTURE.blocklist,
      [IM_ROUTES.devicesList]: REAL_FIXTURE.devices,
    };
    return decode(table[path] ?? null);
  };
  return (
    <PlatformProvider appInfo={APP_INFO}>
      <div style={{ height: "100vh" }}>
        <WebImPage
          port={imHostPort({ request: () => request, newRemoteMessageId: () => "remote-real" })}
          support={imEntrySupport(imCapabilitiesThrough("p0"))}
          hostName="Real port"
          network="server"
          onBack={() => undefined}
          agents={AGENTS}
          drafts={() => drafts()}
          setDrafts={setDrafts}
        />
      </div>
    </PlatformProvider>
  );
}

export const Default: Story = {
  render: () => <ImWiringStory />,
};

export const NoCapabilities: Story = {
  render: () => <ImWiringStory support={imEntrySupport([])} />,
};

function SessionOnlyStory(): JSX.Element {
  const mock = createMockIm({
    peers: [PEER],
    threads: [THREAD],
    messages: [seedMessage(1, "只注册 peers/messages 时，只有会话这一段。", "peer")],
    devices: SEED_DEVICES,
  });
  const [drafts, setDrafts] = createSignal<Record<string, ComposerDraft>>({});
  return (
    <PlatformProvider appInfo={APP_INFO}>
      <div style={{ height: "100vh" }}>
        <WebImPage
          port={mockImPort(mock)}
          support={imEntrySupport([IM_PEERS_CAPABILITY, IM_MESSAGES_CAPABILITY])}
          hostName="Session only"
          network="server"
          onBack={() => undefined}
          agents={AGENTS}
          drafts={() => drafts()}
          setDrafts={setDrafts}
        />
      </div>
    </PlatformProvider>
  );
}

export const SessionOnly: Story = {
  render: () => <SessionOnlyStory />,
};

export const RealPort: Story = {
  render: () => <RealPortStory />,
};
