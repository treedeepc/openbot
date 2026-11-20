import type {
  ChannelDeliveryReceipt,
  ChannelDeliveryStatus,
  ChannelTaskHealth,
  ChannelTaskHealthLevel,
  ChannelTaskStallReason,
} from "@openbot/contracts/ipc";
import type { AppTextKey, AppTranslate } from "@openbot/i18n";
import { Button, buttonVariants, IconButton, TriangleAlert, toast, X } from "@openbot/ui";
import { createSignal, createUniqueId, For, Show, untrack } from "solid-js";
import { AlertDialog } from "../../complex";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";
import { AgentPicker, type AgentPickerAgent } from "../agents/AgentPicker";
import type { SidebarAgentWait } from "../sidebar/sidebar-agent-states";
import { SIDEBAR_WAIT_ACTION, SIDEBAR_WAIT_TITLE, sidebarUsageResetTime } from "../sidebar/sidebar-filtering";
import { createTaskListPlayState, TaskListHeader, TaskMark, type TaskMarkState } from "./TaskList";

export type AwaitingReplyState = "asked" | "working" | "replied" | "failed";

export interface AwaitingReplyItem {
  id: string;
  agent?: AgentProfile | undefined;
  name: string;
  state: AwaitingReplyState;
  preview?: string;
  detail?: string | undefined;
  deliveryId?: string | undefined;
  wait?: SidebarAgentWait | undefined;
  health?: ChannelTaskHealth | undefined;
}

export interface AwaitingReplyListProps {
  items: readonly AwaitingReplyItem[];
  agents?: readonly AgentPickerAgent[] | undefined;
  title?: string | undefined;
  defaultOpen?: boolean;
  onDismiss?: () => void;
  onOpenAgent?: ((agentId: string) => void) | undefined;
  onSteer?: ((deliveryId: string) => void) | undefined;
  onStop?: ((id: string) => void) | undefined;
  onRun?: ((id: string) => void) | undefined;
  onReassign?: ((id: string, agentId: string) => void) | undefined;
  onCancelTask?: ((id: string) => void) | undefined;
  onResend?: ((deliveryId: string) => void) | undefined;
  class?: string;
}

const MARK_STATE: Record<AwaitingReplyState, TaskMarkState> = {
  asked: "pending",
  working: "active",
  replied: "done",
  failed: "failed",
};

const STATE_LABEL = {
  asked: "chat.awaiting.state.asked",
  working: "chat.awaiting.state.working",
  replied: "chat.awaiting.state.replied",
  failed: "chat.awaiting.state.failed",
} as const;

type NoticeLevel = Exclude<ChannelTaskHealthLevel, "none">;
type NoticeReason = Exclude<ChannelTaskStallReason, "none">;

const LEVEL_LABEL: Record<NoticeLevel, AppTextKey> = {
  slow: "chat.taskHealth.level.slow",
  stuck: "chat.taskHealth.level.stuck",
};

const REASON_LABEL: Record<NoticeReason, AppTextKey> = {
  "member-required": "chat.taskHealth.reason.memberRequired",
  stalled: "chat.taskHealth.reason.stalled",
  undelivered: "chat.taskHealth.reason.undelivered",
  "awaiting-reply": "chat.taskHealth.reason.awaitingReply",
  "agent-busy": "chat.taskHealth.reason.agentBusy",
};

const DELIVERY_LABEL: Record<ChannelDeliveryStatus, AppTextKey> = {
  queued: "chat.taskHealth.delivery.queued",
  running: "chat.taskHealth.delivery.running",
  delivered: "chat.taskHealth.delivery.delivered",
  failed: "chat.taskHealth.delivery.failed",
  interrupted: "chat.taskHealth.delivery.interrupted",
};

function idleText(idleMs: number, t: AppTranslate): string {
  const minutes = Math.max(1, Math.round(idleMs / 60_000));
  return minutes < 60
    ? t("chat.taskHealth.idleMinutes", { count: minutes })
    : t("chat.taskHealth.idleHours", { count: Math.round(minutes / 60) });
}

function healthLevel(item: AwaitingReplyItem): NoticeLevel | undefined {
  const level = item.health?.level;
  return level && level !== "none" ? level : undefined;
}

function healthReason(item: AwaitingReplyItem): NoticeReason | undefined {
  const reason = item.health?.stallReason;
  return reason && reason !== "none" ? reason : undefined;
}

function healthDelivery(item: AwaitingReplyItem): ChannelDeliveryReceipt | undefined {
  return item.health?.delivery ?? undefined;
}

export function AwaitingReplies(props: AwaitingReplyListProps) {
  return (
    <Show when={props.items.length > 0}>
      <AwaitingReplyList {...props} />
    </Show>
  );
}

function AwaitingReplyList(props: AwaitingReplyListProps) {
  const { t, format, sourceText } = useText();
  const panelId = createUniqueId();
  const playState = createTaskListPlayState();
  const [open, setOpen] = createSignal(untrack(() => props.defaultOpen ?? true));
  const total = () => props.items.length;
  const done = () => props.items.filter((item) => item.state === "replied").length;
  const active = () => {
    const waiting = props.items.find((entry) => entry.wait);
    if (waiting?.wait) {
      const key = waiting.wait.kind === "waiting" ? "chat.awaiting.needsYou" : "chat.awaiting.limited";
      return { id: waiting.id, label: t(key, { name: waiting.name }) };
    }
    const item = props.items.find((entry) => entry.state === "working");
    return item && { id: item.id, label: t("chat.awaiting.working", { name: item.name }) };
  };
  const markState = (item: AwaitingReplyItem): TaskMarkState => (item.wait ? "pending" : MARK_STATE[item.state]);
  const stateLabel = (item: AwaitingReplyItem): string => {
    const wait = item.wait;
    if (wait?.kind === "waiting") return t(SIDEBAR_WAIT_TITLE[wait.reason]);
    if (wait?.kind === "limited") {
      const reset = sidebarUsageResetTime(wait.resetsAt, format);
      return reset ? t("sidebar.state.usageLimitResets", { reset }) : t("sidebar.state.usageLimit");
    }
    return t(STATE_LABEL[item.state]);
  };
  const preview = (item: AwaitingReplyItem): string | undefined =>
    (item.wait?.kind === "waiting" ? item.wait.detail : null) ?? item.preview;
  const openAction = (item: AwaitingReplyItem) => {
    const wait = item.wait;
    const agentId = item.agent?.id;
    const open = props.onOpenAgent;
    if (wait?.kind !== "waiting" || !agentId || !open) return undefined;
    return { label: t(SIDEBAR_WAIT_ACTION[wait.reason]), run: () => open(agentId) };
  };
  const steerAction = (item: AwaitingReplyItem) => {
    const deliveryId = item.deliveryId;
    const steer = props.onSteer;
    if (item.state !== "replied" || !deliveryId || !steer) return undefined;
    return () => steer(deliveryId);
  };
  const stopAction = (item: AwaitingReplyItem) => {
    const stop = props.onStop;
    if ((item.state !== "asked" && item.state !== "working") || !stop) return undefined;
    return () => stop(item.id);
  };
  const runAction = (item: AwaitingReplyItem) => {
    const run = props.onRun;
    if (item.state === "replied" || !run) return undefined;
    return () => run(item.id);
  };
  const stuckItems = () => props.items.filter((item) => healthLevel(item) === "stuck");
  const settled = () => props.items.every((item) => item.state === "replied" || item.state === "failed");
  const [detail, setDetail] = createSignal<AwaitingReplyItem | null>(null);
  const detailActions = (item: AwaitingReplyItem): { label: string; run: () => void }[] => {
    const list: { label: string; run: () => void }[] = [];
    const run = runAction(item);
    if (run) list.push({ label: t("chat.awaiting.run"), run: () => run() });
    const open = openAction(item);
    if (open) list.push(open);
    const steer = steerAction(item);
    if (steer) list.push({ label: t("queue.item.steer"), run: () => steer() });
    const stop = stopAction(item);
    if (stop) list.push({ label: t("chat.awaiting.stop"), run: () => stop() });
    return list;
  };
  const detailState = () => {
    const item = detail();
    return item ? stateLabel(item) : "";
  };
  const detailLevel = () => {
    const item = detail();
    return item ? (healthLevel(item) ?? "none") : "none";
  };
  const agentName = (agentId: string) => props.agents?.find((agent) => agent.id === agentId)?.name ?? agentId;
  const detailHealthRows = (): { label: string; value: string; resend?: () => void }[] => {
    const item = detail();
    if (!item) return [];
    const rows: { label: string; value: string; resend?: () => void }[] = [];
    const reason = healthReason(item);
    if (reason) rows.push({ label: t("chat.taskHealth.title"), value: t(REASON_LABEL[reason]) });
    const level = healthLevel(item);
    if (level) rows.push({ label: t(LEVEL_LABEL[level]), value: idleText(item.health?.idleMs ?? 0, t) });
    const delivery = healthDelivery(item);
    if (delivery) {
      rows.push({
        label: t("chat.taskHealth.delivery.title"),
        value: [t(DELIVERY_LABEL[delivery.status]), delivery.error ? sourceText(delivery.error) : ""]
          .filter(Boolean)
          .join(" · "),
        ...(delivery.resendable && props.onResend
          ? {
              resend: () => {
                props.onResend?.(delivery.deliveryId);
                toast.success(t("chat.taskHealth.resent"));
              },
            }
          : {}),
      });
    }
    return rows;
  };
  const detailText = () => {
    const item = detail();
    return item ? preview(item) : undefined;
  };
  const detailItems = () => {
    const item = detail();
    return item ? detailActions(item) : [];
  };
  return (
    <section
      style={{ "--task-list-play-state": playState() }}
      class={["task-list", "awaiting-replies", props.class]}
      data-open={open() ? "" : undefined}
    >
      <div class="awaiting-replies-bar">
        <TaskListHeader
          open={open()}
          onToggle={() => setOpen((value) => !value)}
          panelId={panelId}
          done={done()}
          total={total()}
          title={props.title ?? t("chat.awaiting.title")}
          active={active()}
          summary={t("chat.awaiting.summary", { done: done(), total: total() })}
          count={t("chat.awaiting.count", { done: done(), total: total() })}
        />
        <Show when={settled() && props.onDismiss}>
          {(dismiss) => (
            <IconButton
              class="awaiting-replies-dismiss"
              label={t("chat.awaiting.dismiss")}
              variant="ghost"
              size="icon-xs"
              data-cuelume-tap="close"
              onClick={() => dismiss()()}
            >
              <X aria-hidden="true" />
            </IconButton>
          )}
        </Show>
      </div>
      <Show when={stuckItems().length > 0}>
        <div class="awaiting-replies-alert" role="alert" data-level="stuck">
          <TriangleAlert aria-hidden="true" />
          <span>{t("chat.taskHealth.alert")}</span>
        </div>
      </Show>
      <div id={panelId} class="task-list-panel" inert={open() ? undefined : true}>
        <ol class="task-list-items">
          <For each={props.items} keyed={(item) => item.id}>
            {(item, index) => {
              const rowId = createUniqueId();
              return (
                <li
                  class="task-list-item awaiting-replies-item"
                  data-state={markState(item())}
                  data-wait={item().wait ? "" : undefined}
                  style={{ "--task-list-index": index() }}
                  onDblClick={(event) => {
                    if (event.target instanceof HTMLElement && event.target.closest("button")) return;
                    setDetail(item());
                  }}
                >
                  <AgentAvatar
                    agent={item().agent}
                    seed={item().agent ? undefined : item().name}
                    class="awaiting-replies-avatar"
                  />
                  <span class="awaiting-replies-text">
                    <span id={`${rowId}-name`} class="awaiting-replies-name">
                      {item().name}
                    </span>
                    <Show when={preview(item())}>
                      {(text) => <span class="awaiting-replies-preview">{text()}</span>}
                    </Show>
                  </span>
                  <span class="awaiting-replies-state">
                    <Show when={item().detail}>
                      {(detail) => <span class="awaiting-replies-detail">{detail()}</span>}
                    </Show>
                    <Show when={healthLevel(item())}>
                      {(level) => (
                        <span class="awaiting-replies-health" data-level={level()}>
                          {t(LEVEL_LABEL[level()])}
                          <span class="awaiting-replies-health-idle">{idleText(item().health?.idleMs ?? 0, t)}</span>
                        </span>
                      )}
                    </Show>
                    <span class="awaiting-replies-state-label">{stateLabel(item())}</span>
                    <span class="task-list-item-mark" aria-hidden="true">
                      <TaskMark state={markState(item())} />
                    </span>
                  </span>
                  <Show when={openAction(item())}>
                    {(action) => (
                      <Button
                        id={`${rowId}-open`}
                        size="xs"
                        variant="secondary"
                        class="awaiting-replies-open"
                        aria-labelledby={`${rowId}-open ${rowId}-name`}
                        onClick={() => action().run()}
                      >
                        {action().label}
                      </Button>
                    )}
                  </Show>
                  <Show when={steerAction(item())}>
                    {(steer) => (
                      <Button
                        id={`${rowId}-steer`}
                        size="xs"
                        variant="secondary"
                        class="awaiting-replies-steer"
                        aria-labelledby={`${rowId}-steer ${rowId}-name`}
                        onClick={() => steer()()}
                      >
                        {t("queue.item.steer")}
                      </Button>
                    )}
                  </Show>
                  <Show when={runAction(item())}>
                    {(run) => (
                      <Button
                        id={`${rowId}-run`}
                        size="xs"
                        variant="secondary"
                        class="awaiting-replies-run"
                        aria-labelledby={`${rowId}-run ${rowId}-name`}
                        onClick={() => run()()}
                      >
                        {t("chat.awaiting.run")}
                      </Button>
                    )}
                  </Show>
                  <Show when={stopAction(item())}>
                    {(stop) => (
                      <Button
                        id={`${rowId}-stop`}
                        size="xs"
                        variant="secondary"
                        class="awaiting-replies-stop"
                        aria-labelledby={`${rowId}-stop ${rowId}-name`}
                        onClick={() => stop()()}
                      >
                        {t("chat.awaiting.stop")}
                      </Button>
                    )}
                  </Show>
                </li>
              );
            }}
          </For>
        </ol>
      </div>
      <AlertDialog.Root
        open={detail() !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay class="ui-confirm-dialog-overlay">
            <AlertDialog.Content class="ui-confirm-dialog" data-tone="default">
              <div class="ui-confirm-dialog-main">
                <div class="ui-confirm-dialog-content">
                  <AlertDialog.Title as="h2" class="ui-confirm-dialog-title">
                    {detail()?.name ?? ""}
                  </AlertDialog.Title>
                  <AlertDialog.Description class="ui-confirm-dialog-description">
                    {detailState()}
                  </AlertDialog.Description>
                  <Show when={detailText()}>{(text) => <p class="awaiting-replies-detail-text">{text()}</p>}</Show>
                  <Show when={detailHealthRows().length > 0}>
                    <dl class="awaiting-replies-health-card" data-level={detailLevel()}>
                      <For each={detailHealthRows()}>
                        {(row) => (
                          <div class="awaiting-replies-health-row">
                            <dt>{row.label}</dt>
                            <dd>
                              {row.value}
                              <Show when={row.resend}>
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="secondary"
                                  class="awaiting-replies-resend"
                                  onClick={() => row.resend?.()}
                                >
                                  {t("chat.taskHealth.resend")}
                                </Button>
                              </Show>
                            </dd>
                          </div>
                        )}
                      </For>
                    </dl>
                  </Show>
                </div>
              </div>
              <div class="ui-confirm-dialog-actions">
                <For each={detailItems()}>
                  {(action) => (
                    <Button type="button" size="sm" variant="secondary" onClick={() => action.run()}>
                      {action.label}
                    </Button>
                  )}
                </For>
                <Show when={detail() && props.onReassign && (props.agents?.length ?? 0) > 0}>
                  <AgentPicker
                    agents={props.agents ?? []}
                    label={t("chat.taskHealth.reassign")}
                    triggerClass={buttonVariants({ variant: "secondary", size: "sm" })}
                    triggerLabel={t("chat.taskHealth.reassign")}
                    onChange={(agentId) => {
                      const item = detail();
                      if (!item) return;
                      props.onReassign?.(item.id, agentId);
                      toast.success(t("chat.taskHealth.reassigned", { name: agentName(agentId) }));
                      setDetail(null);
                    }}
                  >
                    {t("chat.taskHealth.reassign")}
                  </AgentPicker>
                </Show>
                <Show when={detail() && props.onCancelTask && detail()?.state !== "replied"}>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      const item = detail();
                      if (!item) return;
                      props.onCancelTask?.(item.id);
                      setDetail(null);
                    }}
                  >
                    {t("common.cancel")}
                  </Button>
                </Show>
                <Button type="button" size="sm" variant="ghost" onClick={() => setDetail(null)}>
                  {t("common.close")}
                </Button>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Overlay>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
