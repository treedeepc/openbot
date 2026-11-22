import type { ImMessage, ImPeer, ImThread } from "@openbot/contracts/ipc";
import { ImComposer } from "@openbot/ui/features/im/ImComposer";
import { ImInbox } from "@openbot/ui/features/im/ImInbox";
import { ImSession } from "@openbot/ui/features/im/ImSession";
import { ImThreadHead } from "@openbot/ui/features/im/ImThreadHead";
import {
  type ImAgentOption,
  type ImAssignee,
  type ImInboxRow,
  type ImThreadFilter,
  imInboxMatches,
  imPeerRef,
  toImAssignees,
  toImInboxRow,
} from "@openbot/ui/features/im/im-inbox";
import type { ImMessageRow } from "@openbot/ui/features/im/im-session";
import { imMessageRows, toImPeerSummary } from "@openbot/ui/features/im/im-view";
import type { JSX } from "@solidjs/web";
import { createSignal, For, onSettled, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { copyComposerDraft, EMPTY_DRAFT } from "../src/features/conversation/composer-draft";
import { threadDraftKey } from "../src/features/conversation/conversation-keys";
import type { ComposerDraft } from "../src/features/conversation/conversation-types";
import { createMockIm, type MockIm } from "../src/preview/mock-im";

const meta = {
  title: "IM/ImInbox",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = 1_700_000_000_000;
const THREAD = "thread-1";

const AGENTS: ImAgentOption[] = [
  { id: "agent-1", name: "前端工程师" },
  { id: "agent-2", name: "测试工程师" },
];

const SELF: ImAgentOption = { id: "self", name: "你" };

const PEERS: ImPeer[] = [
  {
    peerServerId: "peer-server",
    peerAgentId: "mira",
    displayName: "Mira · 跨实例",
    verified: true,
    fingerprint: "4F2A 9C11 7B60 55E3",
  },
  {
    peerServerId: "peer-server",
    peerAgentId: "kite",
    displayName: "Kite · 研究所",
    verified: false,
    fingerprint: "8B31 22DE 44A0 91CF",
  },
];

const THREADS: ImThread[] = [
  {
    threadId: THREAD,
    peerServerId: "peer-server",
    peerAgentId: "mira",
    assignees: ["agent-1"],
    primary: "agent-1",
    lastMessageAt: NOW,
    unread: 2,
  },
  {
    threadId: "thread-2",
    peerServerId: "peer-server",
    peerAgentId: "kite",
    assignees: [],
    primary: null,
    lastMessageAt: NOW - 3_600_000,
    unread: 0,
  },
];

const seedMessage = (
  id: string,
  threadId: string,
  body: string,
  senderKind: ImMessage["senderKind"],
  overrides: Partial<ImMessage> = {},
): ImMessage => ({
  localMessageId: id,
  remoteMessageId: `remote-${id}`,
  threadId,
  senderKind,
  senderAgentId: senderKind === "local-assistant" ? "agent-1" : null,
  deviceId: null,
  body,
  attachments: [],
  replyTo: null,
  proxiedBy: null,
  proxyVisibility: null,
  causalChainId: null,
  sentAt: NOW,
  expiresAt: NOW + 30 * 86_400_000,
  withdrawnAt: null,
  verified: true,
  ...overrides,
});

const SEED_MESSAGES: ImMessage[] = [
  seedMessage("msg-1", THREAD, "上次说的指派规则我看过了，可以按主责来。", "peer"),
  seedMessage("msg-2", THREAD, "好，我把收件箱这版先搭起来。", "self"),
  seedMessage("msg-3", THREAD, "收到，我起草一条回复给人确认。", "local-assistant", {
    proxiedBy: "agent-1",
    proxyVisibility: "shown",
  }),
  seedMessage("msg-4", "thread-2", "你们那边的指纹短语是怎么核对的？", "peer"),
];

function inboxRows(mock: MockIm): Promise<ImInboxRow[]> {
  return (async () => {
    const [threads, peers, blocked] = await Promise.all([
      mock.threads.list(),
      mock.peers.list(),
      mock.blocklist.list(),
    ]);
    const blockedKeys = new Set(blocked.items.map((rule) => imPeerRef(rule)));
    const rows: ImInboxRow[] = [];
    for (const thread of threads.items) {
      const peer = peers.items.find(
        (item) => item.peerServerId === thread.peerServerId && item.peerAgentId === thread.peerAgentId,
      );
      if (!peer) continue;
      const row = toImInboxRow(thread, peer, undefined, AGENTS);
      if (blockedKeys.has(imPeerRef(row.peerRef))) continue;
      const messages = await mock.messages.list(thread.threadId);
      rows.push(toImInboxRow(thread, peer, messages.items.at(-1), AGENTS));
    }
    return rows;
  })();
}

function senderName(peer: ImPeer, message: ImMessage): string {
  return message.senderKind === "local-assistant"
    ? (AGENTS.find((agent) => agent.id === message.senderAgentId)?.name ?? "助理")
    : peer.displayName;
}

function InboxStory(): JSX.Element {
  const mock = createMockIm({ peers: PEERS, threads: THREADS, messages: SEED_MESSAGES });
  const [rows, setRows] = createSignal<ImInboxRow[]>([]);
  const [filter, setFilter] = createSignal<ImThreadFilter>("all");
  const [log, setLog] = createSignal<string[]>([]);
  onSettled(() => {
    void inboxRows(mock).then(setRows);
  });

  function note(line: string): void {
    setLog((items) => [...items, line]);
  }

  return (
    <div style={{ "max-width": "760px", padding: "16px" }}>
      <ImInbox
        rows={rows().filter((row) => imInboxMatches(filter(), row))}
        filter={filter()}
        onFilterChange={setFilter}
        onSelect={(threadId) => note(`open ${threadId}`)}
        onBlock={async (row) => {
          await mock.blocklist.add(row.peerRef);
          setRows(await inboxRows(mock));
          note(`blocked ${row.threadId}`);
        }}
        onReport={async (row, category) => {
          await mock.reports.create(imPeerRef(row.peerRef), category);
          note(`reported ${row.threadId} as ${category}`);
        }}
      />
      <Show when={log().length > 0}>
        <ul class="im-inbox-list">
          <For each={log()}>{(line) => <li class="im-inbox-empty">{line}</li>}</For>
        </ul>
      </Show>
    </div>
  );
}

function ThreadStory(): JSX.Element {
  const mock = createMockIm({ peers: PEERS, threads: THREADS, messages: SEED_MESSAGES });
  const peer = PEERS[0] ?? PEER_FALLBACK;
  const [rows, setRows] = createSignal<ImMessageRow[]>([]);
  const [assignees, setAssignees] = createSignal<ImAssignee[]>(toImAssignees(["agent-1"], "agent-1", AGENTS));
  const [drafts, setDrafts] = createSignal<Record<string, ComposerDraft>>({});
  const [draftFrom, setDraftFrom] = createSignal<string | null>(null);
  const [senderId, setSenderId] = createSignal(SELF.id);
  const [proxyEnabled, setProxyEnabled] = createSignal(true);
  const [log, setLog] = createSignal<string[]>([]);
  let remote = 0;

  const draftKey = threadDraftKey({ agentId: peer.peerAgentId, serverId: peer.peerServerId }, THREAD);
  const draft = () => drafts()[draftKey] ?? EMPTY_DRAFT;

  function setDraftText(text: string): void {
    setDrafts((current) => ({ ...current, [draftKey]: { ...copyComposerDraft(draft()), text } }));
  }

  function clearDraft(): void {
    setDrafts((current) => ({ ...current, [draftKey]: copyComposerDraft(EMPTY_DRAFT) }));
    setDraftFrom(null);
  }

  async function load(): Promise<void> {
    const [messages, deliveries] = await Promise.all([mock.messages.list(THREAD), mock.delivery.list(THREAD)]);
    setRows(imMessageRows(messages.items, deliveries.items, (message) => senderName(peer, message)));
  }

  onSettled(() => {
    void load();
  });

  function note(line: string): void {
    setLog((items) => [...items, line]);
  }

  function draftFromAssistant(): void {
    setDraftText("我按你定的主责规则起草了一条回复，确认后我再发出去。");
    setDraftFrom(AGENTS[0]?.name ?? "助理");
    note("draft created");
  }

  async function send(body: string): Promise<void> {
    await mock.messages.send(THREAD, `remote-${++remote}`, body);
    clearDraft();
    await load();
    note(`sent by ${senderId()}`);
  }

  return (
    <div style={{ "max-width": "760px", padding: "16px" }}>
      <ImSession
        peer={toImPeerSummary(peer)}
        messages={rows()}
        onSend={send}
        head={
          <ImThreadHead
            peer={toImPeerSummary(peer)}
            network="lan"
            agents={AGENTS}
            assignees={assignees()}
            onAssignChange={async (next) => {
              setAssignees([...next]);
              await mock.threads.assign(
                THREAD,
                next.map((item) => item.id),
                next.find((item) => item.primary)?.id ?? next[0]?.id ?? "",
              );
              note(`assignees ${next.map((item) => (item.primary ? `${item.name}*` : item.name)).join(",")}`);
            }}
            onBlock={async () => {
              await mock.blocklist.add(peer);
              note("blocked");
            }}
            onReport={async (category) => {
              await mock.reports.create(imPeerRef(peer), category);
              note(`reported as ${category}`);
            }}
          />
        }
        composer={
          <ImComposer
            draft={draft().text}
            onDraftChange={setDraftText}
            onSend={send}
            senders={[SELF, ...AGENTS]}
            senderId={senderId()}
            onSenderChange={setSenderId}
            proxyEnabled={proxyEnabled()}
            onProxyChange={(enabled) => {
              setProxyEnabled(enabled);
              note(`proxy ${enabled ? "on" : "off"}`);
            }}
            draftFrom={draftFrom()}
            onDiscardDraft={() => {
              clearDraft();
              note("draft discarded");
            }}
          />
        }
      />
      <p class="im-inbox-actions" style={{ "padding-top": "12px" }}>
        <button type="button" class="im-inbox-open" onClick={draftFromAssistant}>
          生成草稿（模拟主责助理）
        </button>
      </p>
      <Show when={log().length > 0}>
        <ul class="im-inbox-list">
          <For each={log()}>{(line) => <li class="im-inbox-empty">{line}</li>}</For>
        </ul>
      </Show>
    </div>
  );
}

const PEER_FALLBACK: ImPeer = {
  peerServerId: "peer-server",
  peerAgentId: "mira",
  displayName: "Mira",
  verified: true,
  fingerprint: "4F2A",
};

export const Default: Story = {
  render: () => <InboxStory />,
};

export const Thread: Story = {
  render: () => <ThreadStory />,
};
