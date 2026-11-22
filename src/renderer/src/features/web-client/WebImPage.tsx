import type {
  ImDevice,
  ImMessage,
  ImNotificationSettings,
  ImPeer,
  ImPresenceState,
  ImProxySettings,
  ImThread,
  ImThreadFilter,
} from "@openbot/contracts/ipc";
import { imNotificationDefaults, imNotify } from "@openbot/team-client/im-notify";
import {
  type ImProxySendFailure,
  imProxyDefaults,
  imProxySendFailure,
  imProxySendFor,
} from "@openbot/team-client/im-proxy";
import { Button, SlidingTabs } from "@openbot/ui";
import { ImChannelMembers } from "@openbot/ui/features/im/ImChannelMembers";
import { ImComposer } from "@openbot/ui/features/im/ImComposer";
import { ImContacts } from "@openbot/ui/features/im/ImContacts";
import { ImDevices, type ImEnrollChallenge } from "@openbot/ui/features/im/ImDevices";
import { ImInbox } from "@openbot/ui/features/im/ImInbox";
import { ImSession } from "@openbot/ui/features/im/ImSession";
import { ImThreadHead } from "@openbot/ui/features/im/ImThreadHead";
import {
  type ImAgentOption,
  type ImAssignee,
  type ImContactRow,
  type ImInboxRow,
  type ImNetworkState,
  type ImPeerRef,
  type ImReportCategory,
  imContactName,
  imInboxMatches,
  imPeerRef,
  toImAssignees,
  toImContactRow,
  toImInboxRow,
} from "@openbot/ui/features/im/im-inbox";
import {
  type ImMessageRow,
  imResendable,
  imResendOnOnline,
  imUndeliveredRows,
} from "@openbot/ui/features/im/im-session";
import { imMessageRows, toImPeerSummary } from "@openbot/ui/features/im/im-view";
import { PageHeader } from "@openbot/ui/features/window/PageHeader";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { copyComposerDraft, EMPTY_DRAFT } from "../conversation/composer-draft";
import { threadDraftKey } from "../conversation/conversation-keys";
import type { ComposerDraft } from "../conversation/conversation-types";
import { createPageHeaderFrame } from "../window/page-header-frame";
import {
  type ImChannelMemberRow,
  type ImEntrySupport,
  type ImHostPort,
  type ImPane,
  imPanes,
  toImChannelMemberRow,
} from "./web-im";

export interface WebImPageProps {
  port: ImHostPort;
  support: ImEntrySupport;
  hostName: string;
  network: ImNetworkState;
  onBack: () => void;
  agentName?: ((agentId: string) => string | undefined) | undefined;
  agents: readonly ImAgentOption[];
  drafts: () => Record<string, ComposerDraft>;
  setDrafts: (update: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>) => void;
  onOpenImSettings?: (() => void) | undefined;
}

interface ImActiveThread {
  thread: ImThread;
  peer: ImPeer;
  peerRef: ImPeerRef;
  rows: ImMessageRow[];
  assignees: readonly ImAssignee[];
}

const SENDERS_SELF = "self";
const PRESENCE_POLL_MS = 15_000;

export function WebImPage(props: WebImPageProps): JSX.Element {
  const { t } = useText();
  const headerFrame = createPageHeaderFrame();
  const [selected, setSelected] = createSignal<ImPane>("inbox");
  const pane = (): ImPane => {
    const shown = panes();
    return shown.includes(selected()) ? selected() : (shown[0] ?? "session");
  };
  const panes = () => imPanes(props.support);
  function onChange(value: string): void {
    if (value === "inbox" || value === "contacts" || value === "session" || value === "devices") setSelected(value);
  }

  const [inboxRows, setInboxRows] = createSignal<ImInboxRow[]>([]);
  const [contacts, setContacts] = createSignal<ImContactRow[]>([]);
  const [filter, setFilter] = createSignal<ImThreadFilter>("all");
  const [active, setActive] = createSignal<ImActiveThread | null>(null);
  const [sending, setSending] = createSignal(false);
  const [draftFrom, setDraftFrom] = createSignal<string | null>(null);
  const [senderId, setSenderId] = createSignal<string>(SENDERS_SELF);
  const [proxyEnabled, setProxyEnabled] = createSignal(false);
  const [showProxyMark, setShowProxyMark] = createSignal(true);
  const [proxySettings, setProxySettings] = createSignal<ImProxySettings>(imProxyDefaults());
  const [sendFailure, setSendFailure] = createSignal<ImProxySendFailure | null>(null);
  const [devices, setDevices] = createSignal<readonly ImDevice[]>([]);

  function senderName(peer: ImPeer, message: ImMessage): string {
    if (message.senderKind !== "local-assistant") return peer.displayName;
    const agent = message.senderAgentId ? props.agentName?.(message.senderAgentId) : undefined;
    return agent ?? t("im.message.fromAssistant");
  }

  async function loadRows(thread: ImThread, peer: ImPeer): Promise<ImMessageRow[]> {
    const [messages, deliveries] = await Promise.all([
      props.port.messages.list(thread.threadId),
      props.port.delivery.list(thread.threadId),
    ]);
    const rows = imMessageRows(messages.items, deliveries.items, (message) => senderName(peer, message));
    notify(rows);
    return rows;
  }

  async function refreshInbox(): Promise<void> {
    if (!props.support.inbox) return;
    const [threads, peers, blocked] = await Promise.all([
      props.port.threads.list(),
      props.port.peers.list(),
      props.port.blocklist.list(),
    ]);
    const blockedKeys = new Set(blocked.items.map((rule) => imPeerRef(rule)));
    const rows: ImInboxRow[] = [];
    for (const thread of threads.items) {
      const peer = peers.items.find(
        (item) => item.peerServerId === thread.peerServerId && item.peerAgentId === thread.peerAgentId,
      );
      if (!peer) continue;
      const row = toImInboxRow(thread, peer, undefined, props.agents);
      if (blockedKeys.has(imPeerRef(row.peerRef))) continue;
      const messages = await props.port.messages.list(thread.threadId);
      rows.push(toImInboxRow(thread, peer, messages.items.at(-1), props.agents));
    }
    setInboxRows(rows);
  }

  async function refreshActive(): Promise<void> {
    const current = active();
    if (!current) return;
    const threads = await props.port.threads.list();
    const thread = threads.items.find((item) => item.threadId === current.thread.threadId) ?? current.thread;
    setActive({
      ...current,
      thread,
      assignees: toImAssignees(thread.assignees, thread.primary, props.agents),
      rows: await loadRows(thread, current.peer),
    });
  }

  async function refreshContacts(): Promise<void> {
    if (!props.support.contacts) return;
    const [listed, peers] = await Promise.all([props.port.contacts.list(), props.port.peers.list()]);
    const now = Date.now();
    setContacts(listed.items.map((contact) => toImContactRow(contact, imContactName(contact, peers.items), now)));
  }

  const [members, setMembers] = createSignal<ImChannelMemberRow[]>([]);
  const [notifySettings, setNotifySettings] = createSignal<ImNotificationSettings>(imNotificationDefaults(null));
  const [withdrawNotice, setWithdrawNotice] = createSignal(false);
  const [resending, setResending] = createSignal<readonly string[]>([]);
  const mutedUntil = () => notifySettings().mutedUntil;
  const readReceipts = () => notifySettings().sendReadReceipts !== false;

  async function withdraw(message: ImMessageRow): Promise<void> {
    const current = active();
    if (!current) return;
    const age = Date.now() - message.sentAt;
    if (age > 120_000) {
      setWithdrawNotice(true);
      return;
    }
    setWithdrawNotice(false);
    await props.port.messages.withdraw(current.thread.threadId, message.id);
    await refreshActive();
    await refreshInbox();
  }

  async function resend(message: ImMessageRow): Promise<void> {
    if (!imResendable(message) || resending().includes(message.id) || !message.deliveryId) return;
    const deliveryId = message.deliveryId;
    setResending([...resending(), message.id]);
    try {
      await props.port.delivery.resend(deliveryId);
      await refreshActive();
      await refreshInbox();
    } catch {
      setSendFailure("failed");
    } finally {
      setResending(resending().filter((id) => id !== message.id));
    }
  }

  function editResend(message: ImMessageRow): void {
    setDraftText(message.body);
  }

  const [peerPresence, setPeerPresence] = createSignal<ImPresenceState | null>(null);

  async function refreshPresence(): Promise<void> {
    const current = active();
    if (!current) return;
    let next: ImPresenceState | null = null;
    try {
      const page = await props.port.presence.list([current.peerRef]);
      next =
        page.items.find(
          (item) =>
            item.peerServerId === current.peerRef.peerServerId && item.peerAgentId === current.peerRef.peerAgentId,
        )?.state ?? null;
    } catch {
      next = null;
    }
    const before = peerPresence();
    setPeerPresence(next);
    await imResendOnOnline(current.rows, before, next, resend);
  }

  async function loadNotify(threadId: string): Promise<void> {
    try {
      setNotifySettings(await props.port.notifications.get(threadId));
    } catch {
      setNotifySettings(imNotificationDefaults(threadId));
    }
  }

  async function saveNotify(next: ImNotificationSettings): Promise<void> {
    const previous = notifySettings();
    setNotifySettings(next);
    try {
      setNotifySettings(await props.port.notifications.set(next));
    } catch {
      setNotifySettings(previous);
    }
  }

  async function changeMute(next: number | null): Promise<void> {
    await saveNotify({ ...notifySettings(), mutedUntil: next });
  }

  async function changeReadReceipts(value: boolean): Promise<void> {
    await saveNotify({ ...notifySettings(), sendReadReceipts: value });
  }

  async function refreshMembers(current: ImActiveThread | null = active()): Promise<void> {
    if (!current) return;
    try {
      const peers = await props.port.peers.list();
      const page = await props.port.channels.listMembers(current.thread.threadId);
      setMembers(
        page.items.map((member) =>
          toImChannelMemberRow(member, peers.items, (item) => item.peerServerId !== current.peerRef.peerServerId),
        ),
      );
    } catch {
      setMembers([]);
    }
  }

  async function refreshDevices(): Promise<void> {
    if (!props.support.devices) return;
    setDevices((await props.port.devices.list()).items);
  }

  onSettled(() => {
    void refreshInbox();
    void refreshContacts();
    void refreshDevices();
    void props.port.proxy
      .get()
      .then(setProxySettings)
      .catch(() => undefined);
  });

  const pendingResends = createMemo(() => imUndeliveredRows(active()?.rows ?? []).length);
  createEffect(pendingResends, (pending) => {
    if (pending === 0) return undefined;
    const timer = setInterval(() => void refreshPresence(), PRESENCE_POLL_MS);
    return () => clearInterval(timer);
  });

  async function openThread(row: ImInboxRow): Promise<void> {
    const peers = await props.port.peers.list();
    const peer = peers.items.find(
      (item) => item.peerServerId === row.peerRef.peerServerId && item.peerAgentId === row.peerRef.peerAgentId,
    );
    const threads = await props.port.threads.list();
    const thread = threads.items.find((item) => item.threadId === row.threadId);
    if (!peer || !thread) return;
    setActive({
      thread,
      peer,
      peerRef: row.peerRef,
      rows: await loadRows(thread, peer),
      assignees: toImAssignees(thread.assignees, thread.primary, props.agents),
    });
    setSelected("session");
    await refreshMembers({ thread, peer, peerRef: row.peerRef, rows: [], assignees: [] });
    void refreshPresence();
    void loadNotify(row.threadId);
  }

  const draftKey = () => {
    const current = active();
    return current
      ? threadDraftKey(
          { agentId: current.peerRef.peerAgentId, serverId: current.peerRef.peerServerId },
          current.thread.threadId,
        )
      : null;
  };
  const draft = (): ComposerDraft => {
    const key = draftKey();
    return (key ? props.drafts()[key] : undefined) ?? EMPTY_DRAFT;
  };
  function setDraftText(text: string): void {
    const key = draftKey();
    if (!key) return;
    props.setDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] ?? copyComposerDraft(EMPTY_DRAFT)), text },
    }));
  }
  function clearDraft(): void {
    const key = draftKey();
    if (!key) return;
    props.setDrafts((current) => ({ ...current, [key]: copyComposerDraft(EMPTY_DRAFT) }));
    setDraftFrom(null);
  }

  async function saveProxyBudget(usd: number): Promise<void> {
    const next = { ...proxySettings(), monthlyBudgetUsd: usd };
    setProxySettings(next);
    try {
      setProxySettings(await props.port.proxy.set(next));
    } catch {
      setProxySettings(next);
    }
  }

  async function send(body: string): Promise<void> {
    const current = active();
    if (!current) return;
    setSending(true);
    setSendFailure(null);
    try {
      const proxy = imProxySendFor({ enabled: proxyEnabled(), showMark: showProxyMark() }, senderId(), SENDERS_SELF);
      await props.port.messages.send(current.thread.threadId, body, proxy);
      clearDraft();
      await refreshActive();
      await refreshInbox();
      await refreshMembers();
    } catch (error) {
      setSendFailure(imProxySendFailure(error));
    } finally {
      setSending(false);
    }
  }

  async function assign(next: readonly ImAssignee[]): Promise<void> {
    const current = active();
    if (!current || next.length === 0) return;
    const primary = next.find((item) => item.primary)?.id ?? next[0]?.id ?? "";
    await props.port.threads.assign(
      current.thread.threadId,
      next.map((item) => item.id),
      primary,
    );
    await refreshActive();
    await refreshInbox();
  }

  async function blockActive(): Promise<void> {
    const current = active();
    if (!current) return;
    await props.port.blocklist.add(current.peerRef);
    setActive(null);
    await refreshInbox();
  }

  async function reportActive(category: ImReportCategory): Promise<void> {
    const current = active();
    if (!current) return;
    await props.port.reports.create(imPeerRef(current.peerRef), category);
    await refreshInbox();
  }

  async function requestContact(peer: ImPeerRef): Promise<void> {
    await props.port.contacts.request(peer);
    await refreshContacts();
    await refreshInbox();
  }

  async function acceptContact(contactId: string): Promise<void> {
    await props.port.contacts.accept(contactId);
    await refreshContacts();
    await refreshInbox();
  }

  async function rejectContact(contactId: string): Promise<void> {
    await props.port.contacts.reject(contactId);
    await refreshContacts();
    await refreshInbox();
  }

  async function blockRow(row: ImInboxRow): Promise<void> {
    await props.port.blocklist.add(row.peerRef);
    await refreshInbox();
  }

  async function reportRow(row: ImInboxRow, category: ImReportCategory): Promise<void> {
    await props.port.reports.create(imPeerRef(row.peerRef), category);
    await refreshInbox();
  }

  const seenMessages = new Set<string>();

  function notify(rows: readonly ImMessageRow[]): void {
    for (const row of rows) {
      imNotify(
        notifySettings(),
        { localMessageId: row.id, body: row.body, senderName: row.senderName, proxiedBy: row.proxiedBy },
        seenMessages,
        (title, body) => {
          if (typeof Notification === "undefined") return;
          if (Notification.permission === "granted") new Notification(title, { body });
        },
      );
    }
  }

  async function enroll(deviceName: string, publicKey: string): Promise<ImEnrollChallenge> {
    const pending = await props.port.devices.enrollBegin(deviceName, publicKey);
    await refreshDevices();
    return pending;
  }

  async function approve(deviceId: string, pairingCode: string): Promise<void> {
    await props.port.devices.enrollApprove(deviceId, pairingCode);
    await refreshDevices();
  }

  async function revoke(deviceId: string): Promise<void> {
    await props.port.devices.revoke(deviceId);
    await refreshDevices();
  }

  function content(value: ImPane): JSX.Element {
    if (value === "inbox") {
      return (
        <ImInbox
          rows={inboxRows().filter((row) => imInboxMatches(filter(), row))}
          filter={filter()}
          onFilterChange={setFilter}
          onSelect={(threadId) => {
            const row = inboxRows().find((item) => item.threadId === threadId);
            if (row) void openThread(row);
          }}
          onBlock={props.support.block ? blockRow : undefined}
          onReport={props.support.report ? reportRow : undefined}
          onAddContact={props.support.contacts ? () => setSelected("contacts") : undefined}
        />
      );
    }
    if (value === "session") {
      const current = active();
      if (!current) return <p class="web-im-empty">{t("im.inbox.empty")}</p>;
      return (
        <>
          <Show when={withdrawNotice()}>
            <p class="im-send-failed">{t("im.message.withdrawExpired")}</p>
          </Show>
          <ImChannelMembers
            members={members()}
            canAdminister={members().some((member) => member.role === "admin" && !member.external)}
            canInvite={false}
            onRoleChange={async (id, role) => {
              const [peerServerId, peerAgentId] = id.split("/");
              const current = active();
              if (!current || !peerServerId || !peerAgentId) return;
              await props.port.channels.addMember(current.thread.threadId, { peerServerId, peerAgentId }, role);
              await refreshMembers();
            }}
            onRemove={async (id) => {
              const [peerServerId, peerAgentId] = id.split("/");
              const current = active();
              if (!current || !peerServerId || !peerAgentId) return;
              await props.port.channels.removeMember(current.thread.threadId, { peerServerId, peerAgentId });
              await refreshMembers();
            }}
          />
          <ImSession
            peer={toImPeerSummary(current.peer)}
            messages={current.rows}
            sending={sending()}
            onWithdraw={withdraw}
            onResend={resend}
            onEditResend={editResend}
            resending={resending()}
            onSend={send}
            head={
              <ImThreadHead
                peer={toImPeerSummary(current.peer)}
                network={props.network}
                agents={props.support.assign ? props.agents : undefined}
                assignees={props.support.assign ? current.assignees : undefined}
                onAssignChange={props.support.assign ? assign : undefined}
                mutedUntil={mutedUntil()}
                onMuteChange={changeMute}
                readReceipts={readReceipts()}
                onReadReceiptsChange={changeReadReceipts}
                onBlock={props.support.block ? blockActive : undefined}
                onReport={props.support.report ? reportActive : undefined}
              />
            }
            composer={
              <ImComposer
                draft={draft().text}
                onDraftChange={setDraftText}
                onSend={send}
                sending={sending()}
                senders={[{ id: SENDERS_SELF, name: t("im.message.fromSelf") }, ...props.agents]}
                senderId={senderId()}
                onSenderChange={setSenderId}
                proxyEnabled={proxyEnabled()}
                onProxyChange={setProxyEnabled}
                proxyBudgetUsd={proxySettings().monthlyBudgetUsd}
                onProxyBudgetChange={(usd) => void saveProxyBudget(usd)}
                showProxyMark={showProxyMark()}
                onShowProxyMarkChange={setShowProxyMark}
                sendFailure={sendFailure()}
                draftFrom={draftFrom()}
                onDiscardDraft={clearDraft}
              />
            }
          />
        </>
      );
    }
    if (value === "contacts") {
      return (
        <ImContacts
          contacts={contacts()}
          onRequest={requestContact}
          onAccept={acceptContact}
          onReject={rejectContact}
        />
      );
    }
    return (
      <ImDevices
        devices={devices()}
        onEnroll={enroll}
        onApprove={approve}
        onRevoke={revoke}
        onCancel={async (deviceId) => {
          await props.port.devices.enrollCancel(deviceId);
          await refreshDevices();
        }}
      />
    );
  }

  return (
    <section class="web-im-page" aria-label={t("app.rail.im")}>
      <PageHeader
        class="web-im-header"
        title={t("app.rail.im")}
        hostName={props.hostName}
        onBack={props.onBack}
        frame={headerFrame()}
      />
      <Show when={props.onOpenImSettings}>
        {(open) => (
          <p class="web-im-settings-link">
            <Button type="button" size="xs" variant="ghost" onClick={() => open()()}>
              {t("im.settings.open")}
            </Button>
          </p>
        )}
      </Show>
      <Show
        when={panes().length > 1}
        fallback={
          <div class="web-im-panel">
            <Show
              when={panes().length > 0}
              fallback={
                <>
                  <p class="web-im-empty">{t("im.entry.unavailable")}</p>
                  <p class="web-im-empty-hint">{t("im.entry.unavailableHint")}</p>
                </>
              }
            >
              {content(pane())}
            </Show>
          </div>
        }
      >
        <SlidingTabs.Root value={pane()} onChange={onChange}>
          <SlidingTabs.List aria-label={t("app.rail.im")}>
            <For each={panes()}>
              {(item) => (
                <SlidingTabs.Trigger value={item}>
                  {t(
                    item === "inbox"
                      ? "im.inbox.title"
                      : item === "contacts"
                        ? "im.contacts.title"
                        : item === "session"
                          ? "im.session.title"
                          : "im.devices.title",
                  )}
                </SlidingTabs.Trigger>
              )}
            </For>
          </SlidingTabs.List>
          <SlidingTabs.ContentSlot>
            <For each={panes()}>
              {(item) => (
                <SlidingTabs.Content value={item}>
                  <div class="web-im-panel">{content(item)}</div>
                </SlidingTabs.Content>
              )}
            </For>
          </SlidingTabs.ContentSlot>
        </SlidingTabs.Root>
      </Show>
    </section>
  );
}
