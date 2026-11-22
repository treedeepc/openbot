import { IM_REPORT_CATEGORIES, type ImReportCategory } from "@openbot/contracts/ipc";
import { Button, Typography } from "heroui-native";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import {
  IM_CONTACT_STATE_LABEL,
  IM_REPORT_CATEGORY_LABEL,
  type ImAgentOption,
  type ImAssignee,
  type ImContactRow,
  type ImDraft,
  type ImInboxRow,
  type ImPeerRef,
  type ImThreadFilter,
  imInboxMatches,
  imSetPrimary,
  imToggleAssignee,
} from "@/features/im/model/im-port";
import { useText } from "@/shared/lib/text";

const FILTERS: readonly ImThreadFilter[] = ["all", "unread", "assigned", "unassigned"];

const FILTER_LABEL = {
  all: "im.inbox.filter.all",
  unread: "im.inbox.filter.unread",
  assigned: "im.inbox.filter.assigned",
  unassigned: "im.inbox.filter.unassigned",
} as const;

export function ImInboxView(props: {
  rows: readonly ImInboxRow[];
  filter: ImThreadFilter;
  onFilterChange: (filter: ImThreadFilter) => void;
  onSelect: (row: ImInboxRow) => void;
  onBlock?: ((row: ImInboxRow) => Promise<void>) | undefined;
  onReport?: ((row: ImInboxRow, category: ImReportCategory) => Promise<void>) | undefined;
}) {
  const { t } = useText();
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState<string | null>(null);
  const shown = props.rows.filter((row) => imInboxMatches(props.filter, row));

  async function run(action: ((row: ImInboxRow) => Promise<void> | void) | undefined, row: ImInboxRow): Promise<void> {
    if (!action || busy) return;
    setBusy(true);
    try {
      await action(row);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-3">
      <View className="flex-row gap-2">
        {FILTERS.map((item) => (
          <Button
            key={item}
            size="sm"
            variant={props.filter === item ? "primary" : "ghost"}
            onPress={() => props.onFilterChange(item)}
          >
            <Button.Label>{t(FILTER_LABEL[item])}</Button.Label>
          </Button>
        ))}
      </View>
      {shown.length > 0 ? (
        shown.map((row) => (
          <Pressable key={row.threadId} onPress={() => props.onSelect(row)} className="gap-1">
            <View className="flex-row items-center gap-2">
              <Typography.Paragraph type="body-sm" className="flex-1">
                {row.peer.name}
              </Typography.Paragraph>
              {row.peer.verified ? (
                <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                  {t("im.session.verified")}
                </Typography.Paragraph>
              ) : null}
              {row.proxiedBy !== null ? (
                <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                  {t("im.inbox.proxied")}
                </Typography.Paragraph>
              ) : null}
              {row.unread > 0 ? (
                <Typography.Paragraph type="body-xs">
                  {t("im.inbox.unreadCount", { count: row.unread })}
                </Typography.Paragraph>
              ) : null}
            </View>
            <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
              {row.lastMessage}
            </Typography.Paragraph>
            {props.onBlock || props.onReport ? (
              <View className="flex-row gap-2">
                {props.onBlock ? (
                  <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void run(props.onBlock, row)}>
                    <Button.Label>{t("im.actions.block")}</Button.Label>
                  </Button>
                ) : null}
                {props.onReport ? (
                  reporting === row.threadId ? (
                    <ImReportRow
                      onCancel={() => setReporting(null)}
                      onReport={async (category) => {
                        await run(() => props.onReport?.(row, category), row);
                        setReporting(null);
                      }}
                    />
                  ) : (
                    <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setReporting(row.threadId)}>
                      <Button.Label>{t("im.actions.report")}</Button.Label>
                    </Button>
                  )
                ) : null}
              </View>
            ) : null}
          </Pressable>
        ))
      ) : (
        <Typography.Paragraph type="body-sm" className="text-grouped-secondary">
          {t("im.inbox.empty")}
        </Typography.Paragraph>
      )}
    </View>
  );
}

export function ImAssignRow(props: {
  agents: readonly ImAgentOption[];
  assignees: readonly ImAssignee[];
  onChange: (next: readonly ImAssignee[]) => void | Promise<void>;
}) {
  const { t } = useText();
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
        {t("im.assign.title")}
      </Typography.Paragraph>
      {props.agents.map((agent) => {
        const assigned = props.assignees.some((item) => item.id === agent.id);
        const primary = props.assignees.some((item) => item.id === agent.id && item.primary);
        return (
          <View key={agent.id} className="flex-row items-center gap-1">
            <Button
              size="sm"
              variant={assigned ? "primary" : "ghost"}
              onPress={() => void props.onChange(imToggleAssignee(props.assignees, agent))}
            >
              <Button.Label>{agent.name}</Button.Label>
            </Button>
            {assigned ? (
              <Button
                size="sm"
                variant={primary ? "primary" : "ghost"}
                onPress={() => void props.onChange(imSetPrimary(props.assignees, agent.id))}
              >
                <Button.Label>{t("im.assign.primary")}</Button.Label>
              </Button>
            ) : null}
          </View>
        );
      })}
      {props.assignees.length === 0 ? (
        <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
          {t("im.assign.empty")}
        </Typography.Paragraph>
      ) : null}
    </View>
  );
}

export function ImReportRow(props: {
  onReport: (category: ImReportCategory) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useText();
  return (
    <View className="flex-row flex-wrap gap-2">
      <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
        {t("im.report.title")}
      </Typography.Paragraph>
      {IM_REPORT_CATEGORIES.map((category) => (
        <Button key={category} size="sm" variant="ghost" onPress={() => void props.onReport(category)}>
          <Button.Label>{t(IM_REPORT_CATEGORY_LABEL[category])}</Button.Label>
        </Button>
      ))}
      <Button size="sm" variant="ghost" onPress={props.onCancel}>
        <Button.Label>{t("im.report.cancel")}</Button.Label>
      </Button>
    </View>
  );
}

export function ImContactsView(props: {
  contacts: readonly ImContactRow[];
  onRequest: (peer: ImPeerRef) => void | Promise<void>;
  onAccept: (contactId: string) => void | Promise<void>;
  onReject?: ((contactId: string) => void | Promise<void>) | undefined;
}) {
  const { t } = useText();
  const [server, setServer] = useState("");
  const [agent, setAgent] = useState("");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const rows = props.contacts.filter((row) => !dismissed.includes(row.contactId));

  async function run(action: () => void | Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-3">
      <Typography.Heading type="h4">{t("im.contacts.title")}</Typography.Heading>
      <View className="gap-2">
        <TextInput
          className="min-h-11 rounded-md border border-border px-3 text-text-primary"
          placeholder={t("im.contacts.peerServer")}
          value={server}
          onChangeText={setServer}
        />
        <TextInput
          className="min-h-11 rounded-md border border-border px-3 text-text-primary"
          placeholder={t("im.contacts.peerAgent")}
          value={agent}
          onChangeText={setAgent}
        />
        <Button
          size="sm"
          isDisabled={server.trim() === "" || agent.trim() === "" || busy}
          onPress={() =>
            void run(async () => {
              await props.onRequest({ peerServerId: server.trim(), peerAgentId: agent.trim() });
              setServer("");
              setAgent("");
            })
          }
        >
          <Button.Label>{t("im.contacts.add")}</Button.Label>
        </Button>
      </View>
      {rows.length > 0 ? (
        rows.map((row) => (
          <View key={row.contactId} className="gap-1">
            <View className="flex-row items-center gap-2">
              <Typography.Paragraph type="body-sm" className="flex-1">
                {row.name}
              </Typography.Paragraph>
              <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                {t(IM_CONTACT_STATE_LABEL[row.state])}
              </Typography.Paragraph>
            </View>
            {row.state === "pending" ? (
              <View className="flex-row gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={busy}
                  onPress={() => void run(() => props.onAccept(row.contactId))}
                >
                  <Button.Label>{t("im.contacts.accept")}</Button.Label>
                </Button>
                {props.onReject ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={busy}
                    onPress={() => void run(() => props.onReject?.(row.contactId))}
                  >
                    <Button.Label>{t("im.contacts.reject")}</Button.Label>
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onPress={() => setDismissed((items) => [...items, row.contactId])}>
                  <Button.Label>{t("im.contacts.ignore")}</Button.Label>
                </Button>
              </View>
            ) : null}
          </View>
        ))
      ) : (
        <Typography.Paragraph type="body-sm" className="text-grouped-secondary">
          {t("im.contacts.empty")}
        </Typography.Paragraph>
      )}
    </View>
  );
}

export function ImDraftBar(props: {
  draft: ImDraft;
  onChange: (text: string) => void;
  onConfirm: () => void | Promise<void>;
  onDiscard: () => void;
}) {
  const { t } = useText();
  return (
    <View className="gap-2">
      {props.draft.from ? (
        <View className="gap-2">
          <Typography.Paragraph type="body-xs">
            {t("im.draft.pending", { name: props.draft.from })}
          </Typography.Paragraph>
          <View className="flex-row gap-2">
            <Button size="sm" onPress={() => void props.onConfirm()}>
              <Button.Label>{t("im.draft.confirm")}</Button.Label>
            </Button>
            <Button size="sm" variant="secondary" onPress={props.onDiscard}>
              <Button.Label>{t("im.draft.discard")}</Button.Label>
            </Button>
          </View>
        </View>
      ) : null}
      <TextInput
        className="min-h-11 rounded-md border border-border px-3 text-text-primary"
        placeholder={t("im.session.composePlaceholder")}
        value={props.draft.text}
        onChangeText={props.onChange}
      />
    </View>
  );
}
