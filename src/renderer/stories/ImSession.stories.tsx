import type { ImDelivery, ImMessage, ImPeer } from "@openbot/contracts/ipc";
import { ImSession } from "@openbot/ui/features/im/ImSession";
import type { ImMessageRow } from "@openbot/ui/features/im/im-session";
import { imDeliveryOf, toImMessageRow, toImPeerSummary } from "@openbot/ui/features/im/im-view";
import type { JSX } from "@solidjs/web";
import { createSignal, onSettled, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createMockIm } from "../src/preview/mock-im";

const meta = {
  title: "IM/ImSession",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = 1_700_000_000_000;
const THREAD = "thread-1";

const PEER: ImPeer = {
  peerServerId: "peer-server",
  peerAgentId: "mira",
  displayName: "Mira · 跨实例",
  verified: true,
  fingerprint: "4F2A 9C11 7B60 55E3",
};

const seedMessage = (index: number, body: string, senderKind: ImMessage["senderKind"]): ImMessage => ({
  localMessageId: `msg-${index}`,
  remoteMessageId: `remote-${index}`,
  threadId: THREAD,
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
});

const delivery = (id: string, state: ImDelivery["state"], error: string | null = null): ImDelivery => ({
  deliveryId: `delivery-${id}`,
  localMessageId: id,
  state,
  attempts: 1,
  createdAt: NOW,
  ackedAt: state === "acked" || state === "read" ? NOW + 1_000 : null,
  error,
});

function ImSessionStory(): JSX.Element {
  const mock = createMockIm({
    peers: [PEER],
    messages: [
      seedMessage(1, "收到，方案我这边看过了。", "peer"),
      seedMessage(2, "那我们按 P0 先做最小会话。", "self"),
      seedMessage(3, "我把消息流和发送框先搭起来。", "local-assistant"),
    ],
  });
  const [rows, setRows] = createSignal<ImMessageRow[]>([]);
  onSettled(() => {
    void (async () => {
      const withdrawn = await mock.messages.send(THREAD, "remote-4", "这条是撤回的示例。");
      await mock.messages.withdraw(withdrawn.message.localMessageId);
      const failed = await mock.messages.send(THREAD, "remote-5", "这条没送出去。");
      const listed = await mock.messages.list(THREAD);
      const deliveries: ImDelivery[] = [
        delivery("msg-1", "read"),
        delivery("msg-2", "acked"),
        delivery("msg-3", "persisted"),
        { ...failed.delivery, state: "failed", error: "im.notDelivered" },
      ];
      const senderName = (message: ImMessage) =>
        message.senderKind === "local-assistant" ? "助手 · 前端工程师" : PEER.displayName;
      setRows(
        listed.items.map((message) =>
          toImMessageRow(message, imDeliveryOf(deliveries, message.localMessageId), senderName(message)),
        ),
      );
    })();
  });
  return (
    <Show when={rows().length > 0} fallback={<p>…</p>}>
      <ImSession peer={toImPeerSummary(PEER)} messages={rows()} onSend={async () => undefined} />
    </Show>
  );
}

export const Default: Story = {
  render: () => <ImSessionStory />,
};

const lifecycleRow = (
  index: number,
  body: string,
  state: ImDelivery["state"] | undefined,
  attempts: number,
  options: { error?: string | null; withdrawn?: boolean } = {},
): ImMessageRow =>
  toImMessageRow(
    {
      ...seedMessage(index, body, "self"),
      withdrawnAt: options.withdrawn ? NOW + index * 60_000 + 1_000 : null,
    },
    state === undefined
      ? undefined
      : {
          deliveryId: `delivery-msg-${index}`,
          localMessageId: `msg-${index}`,
          state,
          attempts,
          createdAt: NOW,
          ackedAt: state === "acked" || state === "read" ? NOW + 1_000 : null,
          error: options.error ?? null,
        },
    PEER.displayName,
  );

function ImUndeliveredStory(): JSX.Element {
  const rows: ImMessageRow[] = [
    lifecycleRow(1, "这条没送到，等你上线我再发一次。", "failed", 1, { error: "im.notDelivered" }),
    lifecycleRow(2, "这条也压着，不算已发出。", "failed", 1, { error: "im.notDelivered" }),
    lifecycleRow(3, "这条正在重发。", "submitted", 2),
    lifecycleRow(4, "这条重发后送到了。", "acked", 2),
    lifecycleRow(5, "这条我撤回了，不再重发。", "failed", 1, { withdrawn: true }),
    lifecycleRow(6, "这条一次就存到服务器了。", "persisted", 1),
  ];
  return (
    <ImSession
      peer={toImPeerSummary(PEER)}
      messages={rows}
      onSend={async () => undefined}
      onResend={async () => undefined}
    />
  );
}

export const Undelivered: Story = {
  render: () => <ImUndeliveredStory />,
};
