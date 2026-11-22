import { Button, Input } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import { IM_CONTACT_STATE_LABEL, type ImContactRow, type ImPeerRef } from "./im-inbox";

export interface ImContactsProps {
  contacts: readonly ImContactRow[];
  onRequest: (peer: ImPeerRef) => void | Promise<void>;
  onAccept: (contactId: string) => void | Promise<void>;
  onReject?: ((contactId: string) => void | Promise<void>) | undefined;
}

export function ImContacts(props: ImContactsProps): JSX.Element {
  const { t, format } = useText();
  const [server, setServer] = createSignal("");
  const [agent, setAgent] = createSignal("");
  const [dismissed, setDismissed] = createSignal<readonly string[]>([]);
  const [busy, setBusy] = createSignal(false);

  const rows = () => props.contacts.filter((row) => !dismissed().includes(row.contactId));
  const ready = () => server().trim() !== "" && agent().trim() !== "";

  async function run(action: () => void | Promise<void>): Promise<void> {
    if (busy()) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  function request(): void {
    const peer = { peerServerId: server().trim(), peerAgentId: agent().trim() };
    if (!ready()) return;
    void run(async () => {
      await props.onRequest(peer);
      setServer("");
      setAgent("");
    });
  }

  return (
    <section class="im-contacts" aria-label={t("im.contacts.title")}>
      <h2 class="im-inbox-title">{t("im.contacts.title")}</h2>
      <form
        class="im-contacts-form"
        onSubmit={(event) => {
          event.preventDefault();
          request();
        }}
      >
        <Input
          size="sm"
          aria-label={t("im.contacts.peerServer")}
          placeholder={t("im.contacts.peerServer")}
          value={server()}
          onValueChange={setServer}
        />
        <Input
          size="sm"
          aria-label={t("im.contacts.peerAgent")}
          placeholder={t("im.contacts.peerAgent")}
          value={agent()}
          onValueChange={setAgent}
        />
        <Button type="submit" size="sm" disabled={!ready() || busy()}>
          {t("im.contacts.add")}
        </Button>
      </form>
      <ol class="im-inbox-list">
        <Show when={rows().length > 0} fallback={<p class="im-inbox-empty">{t("im.contacts.empty")}</p>}>
          <For each={rows()}>
            {(row) => (
              <li class="im-inbox-row" data-state={row.state}>
                <span class="im-inbox-names">
                  <span class="im-inbox-peer">
                    {row.name}
                    <span class="im-inbox-proxy">{t(IM_CONTACT_STATE_LABEL[row.state])}</span>
                  </span>
                  <span class="im-inbox-last">{format.date(new Date(row.addedAt))}</span>
                </span>
                <Show when={row.state === "pending"}>
                  <span class="im-inbox-actions">
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy()}
                      onClick={() => void run(() => props.onAccept(row.contactId))}
                    >
                      {t("im.contacts.accept")}
                    </Button>
                    <Show when={props.onReject !== undefined}>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={busy()}
                        onClick={() => void run(() => props.onReject?.(row.contactId))}
                      >
                        {t("im.contacts.reject")}
                      </Button>
                    </Show>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => setDismissed((items) => [...items, row.contactId])}
                    >
                      {t("im.contacts.ignore")}
                    </Button>
                  </span>
                </Show>
              </li>
            )}
          </For>
        </Show>
      </ol>
    </section>
  );
}
