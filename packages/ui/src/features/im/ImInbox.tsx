import { IM_THREAD_FILTERS, type ImThreadFilter } from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import { UserAvatar } from "../../user-avatar";
import { ImReportAction } from "./ImReportPicker";
import { IM_INBOX_FILTER_LABEL, type ImInboxRow, type ImReportCategory } from "./im-inbox";

export interface ImInboxProps {
  rows: readonly ImInboxRow[];
  filter: ImThreadFilter;
  onFilterChange: (filter: ImThreadFilter) => void;
  onSelect: (threadId: string) => void;
  onBlock?: ((row: ImInboxRow) => void | Promise<void>) | undefined;
  onReport?: ((row: ImInboxRow, category: ImReportCategory) => void | Promise<void>) | undefined;
  onAddContact?: (() => void) | undefined;
}

export function ImInbox(props: ImInboxProps): JSX.Element {
  const { t, format } = useText();
  const [busy, setBusy] = createSignal(false);

  async function run(action: ((row: ImInboxRow) => void | Promise<void>) | undefined, row: ImInboxRow): Promise<void> {
    if (busy() || !action) return;
    setBusy(true);
    try {
      await action(row);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="im-inbox" aria-label={t("im.inbox.title")}>
      <div class="im-inbox-head">
        <h2 class="im-inbox-title">{t("im.inbox.title")}</h2>
        {props.onAddContact !== undefined ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => props.onAddContact?.()}>
            {t("im.contacts.add")}
          </Button>
        ) : null}
      </div>
      <fieldset class="im-inbox-filters">
        <legend class="sr-only">{t("im.inbox.filter.label")}</legend>
        <For each={IM_THREAD_FILTERS}>
          {(item) => (
            <Button
              type="button"
              size="xs"
              variant={props.filter === item ? "default" : "ghost"}
              aria-pressed={props.filter === item ? "true" : "false"}
              onClick={() => props.onFilterChange(item)}
            >
              {t(IM_INBOX_FILTER_LABEL[item])}
            </Button>
          )}
        </For>
      </fieldset>
      <ol class="im-inbox-list">
        <Show when={props.rows.length > 0} fallback={<p class="im-inbox-empty">{t("im.inbox.empty")}</p>}>
          <For each={props.rows}>
            {(row) => (
              <li class="im-inbox-row" data-unread={row.unread > 0 ? "" : undefined}>
                <Button type="button" class="im-inbox-open" onClick={() => props.onSelect(row.threadId)}>
                  <UserAvatar
                    class="im-inbox-avatar"
                    decorative
                    user={{ name: row.peer.name, email: "", avatarUrl: null }}
                  />
                  <span class="im-inbox-names">
                    <span class="im-inbox-peer">
                      {row.peer.name}
                      <Show when={row.peer.verified}>
                        <span class="im-inbox-verified">{t("im.session.verified")}</span>
                      </Show>
                      <Show when={row.proxiedBy !== null}>
                        <span class="im-inbox-proxy">{t("im.inbox.proxied")}</span>
                      </Show>
                    </span>
                    <span class="im-inbox-last">{row.lastMessage}</span>
                  </span>
                  <span class="im-inbox-meta">
                    <Show when={row.lastMessageAt !== null}>
                      <time class="im-inbox-time">{format.date(new Date(row.lastMessageAt ?? 0))}</time>
                    </Show>
                    <Show when={row.assignees.length > 0}>
                      <span class="im-inbox-assignees">
                        {row.assignees
                          .map((assignee) => (assignee.primary ? t("im.assign.primary") : assignee.name))
                          .join(" · ")}
                      </span>
                    </Show>
                    <Show when={row.unread > 0}>
                      <span class="im-inbox-unread">
                        <span class="sr-only">{t("im.inbox.unreadCount", { count: row.unread })}</span>
                        {row.unread}
                      </span>
                    </Show>
                  </span>
                </Button>
                {props.onBlock || props.onReport ? (
                  <span class="im-inbox-actions">
                    {props.onBlock ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={busy()}
                        onClick={() => void run(props.onBlock ?? undefined, row)}
                      >
                        {t("im.actions.block")}
                      </Button>
                    ) : null}
                    {props.onReport ? (
                      <ImReportAction
                        label={t("im.actions.report")}
                        busy={busy()}
                        onReport={async (category) => {
                          await run(() => props.onReport?.(row, category), row);
                        }}
                      />
                    ) : null}
                  </span>
                ) : null}
              </li>
            )}
          </For>
        </Show>
      </ol>
    </section>
  );
}
