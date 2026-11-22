import type {
  ImChannelMember,
  ImDevice,
  ImMessage,
  ImNotificationSettings,
  ImPeer,
  ImProxySettings,
  ImThread,
  ImThreadFilter,
} from "@openbot/contracts/ipc";
import type { ImEnrollChallenge } from "@openbot/team-client/im-client";
import {
  IM_PROXY_SEND_FAILURE_LABEL,
  type ImProxySendFailure,
  imProxyBudgetUsd,
  imProxyDefaults,
  imProxyMarkVisible,
  imProxySendFailure,
  imProxySendFor,
} from "@openbot/team-client/im-proxy";
import { Button, Typography } from "heroui-native";
import { useCallback, useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import {
  IM_PAIRING_FAILURE_LABEL,
  type ImAgentOption,
  type ImAssignee,
  type ImContactRow,
  type ImDraft,
  type ImEntrySupport,
  type ImHostPort,
  type ImInboxRow,
  type ImMessageRow,
  type ImNetworkState,
  type ImPairingFailure,
  type ImPeerRef,
  type ImPeerSummary,
  type ImReportCategory,
  imContactName,
  imDraftKey,
  imFingerprintText,
  imMessageRows,
  imMuteToggle,
  imNotificationDefaults,
  imPairingCountdown,
  imPairingExpired,
  imPairingFailure,
  imPeerRef,
  toImContactRow,
  toImInboxRow,
  toImPeerSummary,
} from "@/features/im/model/im-port";
import { ImChannelView } from "@/features/im/screens/im-channel-view";
import { ImAssignRow, ImContactsView, ImDraftBar, ImInboxView } from "@/features/im/screens/im-inbox-view";
import { useText } from "@/shared/lib/text";

type ImPane = "inbox" | "contacts" | "session" | "devices";

const STATUS_LABEL = {
  pending: "im.devices.status.pending",
  active: "im.devices.status.active",
  revoked: "im.devices.status.revoked",
} as const;

const SELF_SENDER = "self";

const DELIVERY_LABEL = {
  submitted: "im.delivery.submitted",
  persisted: "im.delivery.persisted",
  acked: "im.delivery.acked",
  read: "im.delivery.read",
  "blocked-discarded": "im.delivery.blockedDiscarded",
  failed: "im.delivery.failed",
} as const;

export function ImScreen(props: {
  port: ImHostPort | null;
  support: ImEntrySupport;
  agents?: readonly ImAgentOption[];
  network?: ImNetworkState;
}) {
  const { t, format } = useText();
  const agents = props.agents ?? [];
  const [pane, setPane] = useState<ImPane>("inbox");
  const [inboxRows, setInboxRows] = useState<ImInboxRow[]>([]);
  const [contacts, setContacts] = useState<ImContactRow[]>([]);
  const [filter, setFilter] = useState<ImThreadFilter>("all");
  const [active, setActive] = useState<{ thread: ImThread; peer: ImPeer; peerRef: ImPeerRef } | null>(null);
  const [rows, setRows] = useState<ImMessageRow[]>([]);
  const [assignees, setAssignees] = useState<ImAssignee[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ImDraft>>({});
  const [devices, setDevices] = useState<ImDevice[]>([]);
  const [challenge, setChallenge] = useState<ImEnrollChallenge | null>(null);
  const [registeredKey, setRegisteredKey] = useState("");
  const [pairingFailure, setPairingFailure] = useState<ImPairingFailure | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [deviceName, setDeviceName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [senderId, setSenderId] = useState(SELF_SENDER);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [showProxyMark, setShowProxyMark] = useState(true);
  const [proxySettings, setProxySettings] = useState<ImProxySettings>(imProxyDefaults());
  const [proxyBudgetText, setProxyBudgetText] = useState<string | null>(null);
  const [sendFailure, setSendFailure] = useState<ImProxySendFailure | null>(null);
  const [notify, setNotify] = useState<ImNotificationSettings>(imNotificationDefaults(null));
  const mutedUntil = notify.mutedUntil;
  const readReceipts = notify.sendReadReceipts !== false;
  const [channelMembers, setChannelMembers] = useState<ImChannelMember[]>([]);
  const [channelPeers, setChannelPeers] = useState<ImPeer[]>([]);
  const [withdrawNotice, setWithdrawNotice] = useState(false);
  const [busy, setBusy] = useState(false);

  const senderName = useCallback(
    (peer: ImPeer, message: ImMessage): string =>
      message.senderKind === "local-assistant" ? t("im.message.fromAssistant") : peer.displayName,
    [t],
  );

  const refreshInbox = useCallback(async () => {
    const port = props.port;
    if (!port || !props.support.inbox) return;
    try {
      const [threads, peers, blocked] = await Promise.all([
        port.threads.list(),
        port.peers.list(),
        port.blocklist.list(),
      ]);
      const blockedKeys = new Set(blocked.items.map((rule) => imPeerRef(rule)));
      const next: ImInboxRow[] = [];
      for (const thread of threads.items) {
        const peer = peers.items.find(
          (item) => item.peerServerId === thread.peerServerId && item.peerAgentId === thread.peerAgentId,
        );
        if (!peer) continue;
        const row = toImInboxRow(thread, peer, undefined, agents);
        if (blockedKeys.has(imPeerRef(row.peerRef))) continue;
        const messages = await port.messages.list(thread.threadId);
        next.push(toImInboxRow(thread, peer, messages.items.at(-1), agents));
      }
      setInboxRows(next);
    } catch {
      setInboxRows([]);
    }
  }, [agents, props.port, props.support.inbox]);

  const refreshActive = useCallback(async () => {
    const port = props.port;
    const current = active;
    if (!port || !current) return;
    try {
      const [messages, deliveries] = await Promise.all([
        port.messages.list(current.thread.threadId),
        port.delivery.list(current.thread.threadId),
      ]);
      setRows(imMessageRows(messages.items, deliveries.items, (message) => senderName(current.peer, message)));
    } catch {
      setRows([]);
    }
  }, [active, props.port, senderName]);

  const refreshContacts = useCallback(async () => {
    const port = props.port;
    if (!port || !props.support.contacts) return;
    try {
      const [listed, peers] = await Promise.all([port.contacts.list(), port.peers.list()]);
      const now = Date.now();
      setContacts(listed.items.map((contact) => toImContactRow(contact, imContactName(contact, peers.items), now)));
    } catch {
      setContacts([]);
    }
  }, [props.port, props.support.contacts]);

  const refreshDevices = useCallback(async () => {
    const port = props.port;
    if (!port || !props.support.devices) return;
    try {
      setDevices((await port.devices.list()).items);
    } catch {
      setDevices([]);
    }
  }, [props.port, props.support.devices]);

  const refreshProxy = useCallback(async () => {
    const port = props.port;
    if (!port) return;
    try {
      setProxySettings(await port.proxy.get());
    } catch {
      setProxySettings(imProxyDefaults());
    }
  }, [props.port]);

  useEffect(() => {
    void refreshInbox();
    void refreshContacts();
    void refreshDevices();
    void refreshProxy();
  }, [refreshContacts, refreshDevices, refreshInbox, refreshProxy]);

  useEffect(() => {
    void refreshActive();
  }, [refreshActive]);

  const draftKey = active ? imDraftKey(active.peerRef, active.thread.threadId) : null;
  const draft: ImDraft = (draftKey ? drafts[draftKey] : undefined) ?? { text: "", from: null };

  function setDraftText(text: string): void {
    if (!draftKey) return;
    setDrafts((current) => ({ ...current, [draftKey]: { ...(current[draftKey] ?? { text: "", from: null }), text } }));
  }

  function clearDraft(): void {
    if (!draftKey) return;
    setDrafts((current) => ({ ...current, [draftKey]: { text: "", from: null } }));
  }

  async function send(): Promise<void> {
    const port = props.port;
    const body = draft.text.trim();
    if (!port || !active || body === "" || busy) return;
    setBusy(true);
    setSendFailure(null);
    try {
      const proxy = imProxySendFor({ enabled: proxyEnabled, showMark: showProxyMark }, senderId, SELF_SENDER);
      await port.messages.send(active.thread.threadId, body, proxy);
      clearDraft();
      await refreshActive();
      await refreshInbox();
    } catch (error) {
      setSendFailure(imProxySendFailure(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveProxyBudget(text: string): Promise<void> {
    const parsed = Number(text.trim());
    const next = imProxyBudgetUsd(Number.isFinite(parsed) ? parsed : proxySettings.monthlyBudgetUsd);
    setProxyBudgetText(String(next));
    const settings = { ...proxySettings, monthlyBudgetUsd: next };
    setProxySettings(settings);
    const port = props.port;
    if (!port) return;
    try {
      setProxySettings(await port.proxy.set(settings));
    } catch {
      setProxySettings(settings);
    }
  }

  async function assign(next: readonly ImAssignee[]): Promise<void> {
    const port = props.port;
    if (!port || !active || next.length === 0) return;
    setAssignees([...next]);
    await port.threads.assign(
      active.thread.threadId,
      next.map((item) => item.id),
      next.find((item) => item.primary)?.id ?? next[0]?.id ?? "",
    );
    await refreshInbox();
  }

  async function block(row: ImInboxRow): Promise<void> {
    const port = props.port;
    if (!port) return;
    await port.blocklist.add(row.peerRef);
    await refreshInbox();
  }

  async function report(row: ImInboxRow, category: ImReportCategory): Promise<void> {
    const port = props.port;
    if (!port) return;
    await port.reports.create(imPeerRef(row.peerRef), category);
    await refreshInbox();
  }

  async function requestContact(peer: ImPeerRef): Promise<void> {
    const port = props.port;
    if (!port) return;
    await port.contacts.request(peer);
    await refreshContacts();
    await refreshInbox();
  }

  async function acceptContact(contactId: string): Promise<void> {
    const port = props.port;
    if (!port) return;
    await port.contacts.accept(contactId);
    await refreshContacts();
    await refreshInbox();
  }

  async function rejectContact(contactId: string): Promise<void> {
    const port = props.port;
    if (!port) return;
    await port.contacts.reject(contactId);
    await refreshContacts();
    await refreshInbox();
  }

  async function withdraw(message: ImMessageRow): Promise<void> {
    const port = props.port;
    if (!port || !active) return;
    if (Date.now() - message.sentAt > 120_000) {
      setWithdrawNotice(true);
      return;
    }
    setWithdrawNotice(false);
    await port.messages.withdraw(active.thread.threadId, message.id);
    await refreshActive();
    await refreshInbox();
  }

  async function resend(message: ImMessageRow): Promise<void> {
    const port = props.port;
    if (!port || !message.deliveryId) return;
    await port.delivery.resend(message.deliveryId);
    await refreshActive();
  }

  const refreshChannel = useCallback(
    async (threadId: string) => {
      const port = props.port;
      if (!port) return;
      try {
        const [members, peers] = await Promise.all([port.channels.listMembers(threadId), port.peers.list()]);
        setChannelMembers(members.items);
        setChannelPeers(peers.items);
      } catch {
        setChannelMembers([]);
      }
    },
    [props.port],
  );

  async function loadNotify(threadId: string): Promise<void> {
    const port = props.port;
    if (!port) return;
    try {
      setNotify(await port.notifications.get(threadId));
    } catch {
      setNotify(imNotificationDefaults(threadId));
    }
  }

  async function saveNotify(next: ImNotificationSettings): Promise<void> {
    const port = props.port;
    const previous = notify;
    setNotify(next);
    if (!port) return;
    try {
      setNotify(await port.notifications.set(next));
    } catch {
      setNotify(previous);
    }
  }

  async function changeMute(next: number | null): Promise<void> {
    await saveNotify({ ...notify, mutedUntil: next });
  }

  async function changeReadReceipts(value: boolean): Promise<void> {
    await saveNotify({ ...notify, sendReadReceipts: value });
  }

  async function inviteMember(member: ImPeerRef, role: ImChannelMember["role"]): Promise<void> {
    const port = props.port;
    if (!port || !active) return;
    await port.channels.addMember(active.thread.threadId, member, role);
    await refreshChannel(active.thread.threadId);
  }

  async function changeRole(member: ImPeerRef, role: ImChannelMember["role"]): Promise<void> {
    const port = props.port;
    if (!port || !active) return;
    await port.channels.addMember(active.thread.threadId, member, role);
    await refreshChannel(active.thread.threadId);
  }

  async function removeMember(member: ImPeerRef): Promise<void> {
    const port = props.port;
    if (!port || !active) return;
    await port.channels.removeMember(active.thread.threadId, member);
    await refreshChannel(active.thread.threadId);
  }

  useEffect(() => {
    if (!challenge) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challenge]);

  async function enroll(): Promise<void> {
    const port = props.port;
    const name = deviceName.trim();
    const key = publicKey.trim();
    if (!port || name === "" || key === "" || busy) return;
    setBusy(true);
    setPairingFailure(null);
    try {
      setRegisteredKey(key);
      setChallenge(await port.devices.enrollBegin(name, key));
      setNow(Date.now());
      setDeviceName("");
      setPublicKey("");
      await refreshDevices();
    } finally {
      setBusy(false);
    }
  }

  async function approve(deviceId: string, pairingCode: string): Promise<void> {
    const port = props.port;
    if (!port || busy) return;
    setBusy(true);
    setPairingFailure(null);
    try {
      await port.devices.enrollApprove(deviceId, pairingCode);
      setChallenge(null);
      setCodes((current) => ({ ...current, [deviceId]: "" }));
      await refreshDevices();
    } catch (error) {
      setPairingFailure(imPairingFailure(error));
    } finally {
      setBusy(false);
    }
  }

  async function cancelEnroll(): Promise<void> {
    const port = props.port;
    if (!port || !challenge || busy) return;
    setBusy(true);
    try {
      await port.devices.enrollCancel(challenge.deviceId);
      setChallenge(null);
      await refreshDevices();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(deviceId: string): Promise<void> {
    const port = props.port;
    if (!port || busy) return;
    setBusy(true);
    try {
      await port.devices.revoke(deviceId);
      await refreshDevices();
    } finally {
      setBusy(false);
    }
  }

  const panes: ImPane[] = [];
  if (props.support.inbox) panes.push("inbox");
  if (props.support.contacts) panes.push("contacts");
  if (props.support.session) panes.push("session");
  if (props.support.devices) panes.push("devices");
  const shown: ImPane = panes.includes(pane) ? pane : (panes[0] ?? "session");
  const peerSummary: ImPeerSummary | null = active ? toImPeerSummary(active.peer) : null;

  if (panes.length === 0) {
    return (
      <View className="flex-1 gap-2 px-4 pb-safe-offset-4 pt-2">
        <Typography.Paragraph type="body-sm">{t("im.entry.unavailable")}</Typography.Paragraph>
        <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
          {t("im.entry.unavailableHint")}
        </Typography.Paragraph>
      </View>
    );
  }

  return (
    <View className="flex-1 gap-4 px-4 pb-safe-offset-4 pt-2">
      {panes.length > 1 ? (
        <View className="flex-row gap-2">
          {panes.map((item) => (
            <Button key={item} size="sm" variant={shown === item ? "primary" : "ghost"} onPress={() => setPane(item)}>
              <Button.Label>
                {t(
                  item === "inbox"
                    ? "im.inbox.title"
                    : item === "contacts"
                      ? "im.contacts.title"
                      : item === "session"
                        ? "im.session.title"
                        : "im.devices.title",
                )}
              </Button.Label>
            </Button>
          ))}
        </View>
      ) : null}
      {shown === "inbox" ? (
        <ImInboxView
          rows={inboxRows}
          filter={filter}
          onFilterChange={setFilter}
          onSelect={(row) => {
            const thread = inboxRows.find((item) => item.threadId === row.threadId);
            if (!thread) return;
            setActive({
              thread: {
                threadId: row.threadId,
                peerServerId: row.peerRef.peerServerId,
                peerAgentId: row.peerRef.peerAgentId,
                assignees: row.assignees.map((item) => item.id),
                primary: row.assignees.find((item) => item.primary)?.id ?? null,
                lastMessageAt: row.lastMessageAt,
                unread: row.unread,
              },
              peer: {
                ...row.peerRef,
                displayName: row.peer.name,
                verified: row.peer.verified,
                fingerprint: row.peer.fingerprint ?? "",
              },
              peerRef: row.peerRef,
            });
            void refreshChannel(row.threadId);
            void loadNotify(row.threadId);
            setAssignees([...row.assignees]);
            setPane("session");
          }}
          onBlock={props.support.block ? block : undefined}
          onReport={props.support.report ? report : undefined}
        />
      ) : null}
      {shown === "contacts" ? (
        <ImContactsView
          contacts={contacts}
          onRequest={requestContact}
          onAccept={acceptContact}
          onReject={props.support.block ? rejectContact : undefined}
        />
      ) : null}
      {shown === "session" ? (
        <View className="flex-1 gap-3">
          {peerSummary ? (
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <Typography.Heading type="h4">{peerSummary.name}</Typography.Heading>
                <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                  {peerSummary.verified ? t("im.session.verified") : t("im.session.unverified")}
                </Typography.Paragraph>
              </View>
              {props.support.assign ? <ImAssignRow agents={agents} assignees={assignees} onChange={assign} /> : null}
              <View className="flex-row items-center gap-2">
                <Button
                  size="sm"
                  variant={mutedUntil !== null ? "primary" : "ghost"}
                  onPress={() => void changeMute(imMuteToggle(mutedUntil, Date.now()))}
                >
                  <Button.Label>{t("im.settings.mute")}</Button.Label>
                </Button>
                {mutedUntil !== null ? (
                  <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                    {t("im.thread.mutedUntil", { time: format.date(new Date(mutedUntil)) })}
                  </Typography.Paragraph>
                ) : null}
                <Button
                  size="sm"
                  variant={readReceipts ? "primary" : "ghost"}
                  onPress={() => void changeReadReceipts(!readReceipts)}
                >
                  <Button.Label>{t("im.thread.readReceipts")}</Button.Label>
                </Button>
              </View>
              <ImChannelView
                members={channelMembers}
                peers={channelPeers}
                onInvite={inviteMember}
                onRoleChange={changeRole}
                onRemove={removeMember}
              />
            </View>
          ) : (
            <Typography.Paragraph type="body-sm" className="text-grouped-secondary">
              {t("im.inbox.empty")}
            </Typography.Paragraph>
          )}
          <View className="flex-1 gap-2">
            {rows.map((message) => (
              <View key={message.id} className="gap-0.5">
                <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                  {message.senderKind === "self" ? t("im.message.fromSelf") : message.senderName}
                </Typography.Paragraph>
                <Typography.Paragraph type="body-sm">{message.body}</Typography.Paragraph>
                <View className="flex-row gap-2">
                  {message.delivery ? (
                    <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                      {t(DELIVERY_LABEL[message.delivery])}
                    </Typography.Paragraph>
                  ) : null}
                  {!message.withdrawn ? (
                    <Button size="sm" variant="ghost" onPress={() => void withdraw(message)}>
                      <Button.Label>{t("im.message.withdraw")}</Button.Label>
                    </Button>
                  ) : null}
                  {message.delivery === "failed" ? (
                    <Button size="sm" variant="ghost" onPress={() => void resend(message)}>
                      <Button.Label>{t("im.message.resend")}</Button.Label>
                    </Button>
                  ) : null}
                  {imProxyMarkVisible(message) ? (
                    <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                      {t("im.proxy.mark")}
                    </Typography.Paragraph>
                  ) : null}
                  {message.withdrawn ? (
                    <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                      {t("im.message.withdrawn")}
                    </Typography.Paragraph>
                  ) : null}
                  <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                    {format.date(new Date(message.sentAt))}
                  </Typography.Paragraph>
                </View>
              </View>
            ))}
          </View>
          <View className="flex-row gap-2">
            <Button
              size="sm"
              variant={proxyEnabled ? "primary" : "ghost"}
              onPress={() => setProxyEnabled(!proxyEnabled)}
            >
              <Button.Label>{t("im.composer.proxy")}</Button.Label>
            </Button>
            {proxyEnabled ? (
              <Button
                size="sm"
                variant={showProxyMark ? "primary" : "ghost"}
                onPress={() => setShowProxyMark(!showProxyMark)}
              >
                <Button.Label>{t("im.proxy.showMark")}</Button.Label>
              </Button>
            ) : null}
            {[{ id: SELF_SENDER, name: t("im.message.fromSelf") }, ...agents].map((sender: ImAgentOption) => (
              <Button
                key={sender.id}
                size="sm"
                variant={senderId === sender.id ? "primary" : "ghost"}
                isDisabled={sender.id !== SELF_SENDER && !proxyEnabled}
                onPress={() => setSenderId(sender.id)}
              >
                <Button.Label>{sender.name}</Button.Label>
              </Button>
            ))}
          </View>
          {proxyEnabled ? (
            <View className="flex-row items-center gap-2">
              <TextInput
                className="min-h-11 w-20 rounded-md border border-border px-3 text-text-primary"
                accessibilityLabel={t("im.settings.budget")}
                keyboardType="number-pad"
                value={proxyBudgetText ?? String(proxySettings.monthlyBudgetUsd)}
                onChangeText={setProxyBudgetText}
                onBlur={() => void saveProxyBudget(proxyBudgetText ?? String(proxySettings.monthlyBudgetUsd))}
              />
              <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                {t("im.proxy.budget", { usd: proxySettings.monthlyBudgetUsd })}
              </Typography.Paragraph>
            </View>
          ) : null}
          {sendFailure ? (
            <Typography.Paragraph type="body-sm" className="text-danger">
              {t(IM_PROXY_SEND_FAILURE_LABEL[sendFailure])}
            </Typography.Paragraph>
          ) : null}
          {withdrawNotice ? (
            <Typography.Paragraph type="body-sm" className="text-danger">
              {t("im.message.withdrawExpired")}
            </Typography.Paragraph>
          ) : null}
          <ImDraftBar draft={draft} onChange={setDraftText} onConfirm={send} onDiscard={clearDraft} />
          <Button size="sm" isDisabled={draft.text.trim() === "" || busy} onPress={() => void send()}>
            <Button.Label>{busy ? t("im.session.sending") : t("im.session.send")}</Button.Label>
          </Button>
        </View>
      ) : null}
      {shown === "devices" ? (
        <View className="gap-3">
          <Typography.Heading type="h4">{t("im.devices.title")}</Typography.Heading>
          <TextInput
            className="min-h-11 rounded-md border border-border px-3 text-text-primary"
            placeholder={t("im.devices.name")}
            value={deviceName}
            onChangeText={setDeviceName}
          />
          <TextInput
            className="min-h-11 rounded-md border border-border px-3 text-text-primary"
            placeholder={t("im.devices.publicKey")}
            value={publicKey}
            onChangeText={setPublicKey}
          />
          <Button
            size="sm"
            isDisabled={deviceName.trim() === "" || publicKey.trim() === "" || busy}
            onPress={() => void enroll()}
          >
            <Button.Label>{t("im.devices.enroll")}</Button.Label>
          </Button>
          {challenge ? (
            <View className="gap-2">
              <Typography.Paragraph type="body-sm">
                {t("im.devices.pairingCode")} {challenge.pairingCode}
              </Typography.Paragraph>
              {imPairingExpired(challenge.expiresAt, now) ? (
                <Typography.Paragraph type="body-sm" className="text-danger">
                  {t("im.devices.expired")}
                </Typography.Paragraph>
              ) : (
                <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                  {t("im.devices.expiresIn", { time: imPairingCountdown(challenge.expiresAt, now) })}
                </Typography.Paragraph>
              )}
              <Typography.Paragraph type="body-sm">
                {t("im.devices.registeredKey")} {registeredKey}
              </Typography.Paragraph>
              {challenge.devicePublicKey ? (
                <Typography.Paragraph type="body-sm">
                  {t("im.devices.echoedKey")} {challenge.devicePublicKey}
                </Typography.Paragraph>
              ) : null}
              <Typography.Paragraph type="body-sm">
                {t("im.devices.fingerprint")} {imFingerprintText(challenge.fingerprint)}
              </Typography.Paragraph>
              {challenge.algorithm ? (
                <Typography.Paragraph type="body-sm">
                  {t("im.devices.algorithm")} {challenge.algorithm}
                </Typography.Paragraph>
              ) : null}
              {pairingFailure ? (
                <Typography.Paragraph type="body-sm" className="text-danger">
                  {t(IM_PAIRING_FAILURE_LABEL[pairingFailure])}
                </Typography.Paragraph>
              ) : null}
              <Button
                size="sm"
                isDisabled={busy || imPairingExpired(challenge.expiresAt, now)}
                onPress={() => void approve(challenge.deviceId, challenge.pairingCode)}
              >
                <Button.Label>{t("im.devices.approve")}</Button.Label>
              </Button>
              <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void cancelEnroll()}>
                <Button.Label>{t("im.devices.cancel")}</Button.Label>
              </Button>
            </View>
          ) : null}
          {devices.length > 0 ? (
            devices.map((device) => (
              <View key={device.deviceId} className="flex-row items-center gap-2">
                <Typography.Paragraph type="body-sm" className="flex-1">
                  {device.deviceId}
                </Typography.Paragraph>
                <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                  {t(STATUS_LABEL[device.status])}
                </Typography.Paragraph>
                {device.fingerprint ? (
                  <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                    {t("im.devices.fingerprint")} {imFingerprintText(device.fingerprint)}
                  </Typography.Paragraph>
                ) : null}
                {device.algorithm ? (
                  <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                    {t("im.devices.algorithm")} {device.algorithm}
                  </Typography.Paragraph>
                ) : null}
                {device.status === "pending" ? (
                  <TextInput
                    className="min-h-11 w-28 rounded-md border border-border px-3 text-text-primary"
                    accessibilityLabel={t("im.devices.pairingCode")}
                    placeholder={t("im.devices.pairingCode")}
                    value={codes[device.deviceId] ?? ""}
                    onChangeText={(text) => setCodes((current) => ({ ...current, [device.deviceId]: text }))}
                  />
                ) : null}
                {device.status === "pending" ? (
                  <Button
                    size="sm"
                    isDisabled={busy || (codes[device.deviceId] ?? "").trim() === ""}
                    onPress={() => void approve(device.deviceId, (codes[device.deviceId] ?? "").trim())}
                  >
                    <Button.Label>{t("im.devices.approve")}</Button.Label>
                  </Button>
                ) : null}
                {device.status === "active" ? (
                  <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void revoke(device.deviceId)}>
                    <Button.Label>{t("im.devices.revoke")}</Button.Label>
                  </Button>
                ) : null}
              </View>
            ))
          ) : (
            <Typography.Paragraph type="body-sm" className="text-grouped-secondary">
              {t("im.devices.empty")}
            </Typography.Paragraph>
          )}
        </View>
      ) : null}
    </View>
  );
}
