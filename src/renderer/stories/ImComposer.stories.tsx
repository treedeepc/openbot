import { ImComposer } from "@openbot/ui/features/im/ImComposer";
import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const meta = {
  title: "IM/ImComposer",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const AGENTS = [
  { id: "agent-1", name: "前端工程师" },
  { id: "agent-2", name: "测试工程师" },
];

function ComposerStory(props: { failure?: "budget" | "failed" | null }): JSX.Element {
  const [draft, setDraft] = createSignal("这条是替助理代发的。");
  const [senderId, setSenderId] = createSignal("agent-1");
  const [proxyEnabled, setProxyEnabled] = createSignal(true);
  const [showProxyMark, setShowProxyMark] = createSignal(true);
  const [budget, setBudget] = createSignal(20);
  return (
    <ImComposer
      draft={draft()}
      onDraftChange={setDraft}
      onSend={async () => undefined}
      senders={[{ id: "self", name: "你" }, ...AGENTS]}
      senderId={senderId()}
      onSenderChange={setSenderId}
      proxyEnabled={proxyEnabled()}
      onProxyChange={setProxyEnabled}
      proxyBudgetUsd={budget()}
      onProxyBudgetChange={setBudget}
      showProxyMark={showProxyMark()}
      onShowProxyMarkChange={setShowProxyMark}
      sendFailure={props.failure ?? null}
    />
  );
}

export const ProxyReply: Story = {
  render: () => <ComposerStory />,
};

export const BudgetExhausted: Story = {
  render: () => <ComposerStory failure="budget" />,
};
