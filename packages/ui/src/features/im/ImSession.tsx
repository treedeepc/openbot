import { imProxyMarkVisible } from "@openbot/team-client/im-proxy";
import { Button, CircleCheck, Textarea, TriangleAlert } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import { ImUndelivered } from "./ImUndelivered";
import {
  IM_DELIVERY_LABEL,
  IM_SEND_PHASE_LABEL,
  type ImMessageRow,
  type ImPeerSummary,
  type ImSendPhase,
  imResendable,
  imSendPhase,
  imUndeliveredHintKey,
  imUndeliveredRows,
  imWithdrawn,
} from "./im-session";

export interface ImSessionProps {
  peer: ImPeerSummary;
  messages: readonly ImMessageRow[];
  sending?: boolean | undefined;
  onSend: (body: string) => void | Promise<void>;
  head?: JSX.Element | undefined;
  composer?: JSX.Element | undefined;
  onWithdraw?: ((message: ImMessageRow) => void | Promise<void>) | undefined;
  onResend?: ((message: ImMessageRow) => void | Promise<void>) | undefined;
  onEditResend?: ((message: ImMessageRow) => void) | undefined;
  resending?: readonly string[] | undefined;
  canWithdraw?: ((message: ImMessageRow) => boolean) | undefined;
  withdrawWindowMs?: number | undefined;
}

export function ImSession(props: ImSessionProps): JSX.Element {
  const { t, format } = useText();
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  function resendingNow(message: ImMessageRow): boolean {
    return props.resending?.includes(message.id) ?? false;
  }

  function phaseOf(message: ImMessageRow): ImSendPhase {
    return imSendPhase(message, resendingNow(message));
  }

  function editResend(message: ImMessageRow): void {
    if (props.onEditResend !== undefined) props.onEditResend(message);
    else setDraft(message.body);
  }

  function canEditResend(): boolean {
    return props.onEditResend !== undefined || props.composer === undefined;
  }

  async function send(): Promise<void> {
    const body = draft().trim();
    if (body === "" || busy()) return;
    setBusy(true);
    try {
      await props.onSend(body);
      setDraft("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="im-session">
      <Show
        when={props.head}
        fallback={
          <header class="im-session-head">
            <h2 class="im-session-peer">{props.peer.name}</h2>
            <span class="im-session-verified" data-verified={props.peer.verified ? "" : undefined}>
              {props.peer.verified ? <CircleCheck aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
              {props.peer.verified ? t("im.session.verified") : t("im.session.unverified")}
            </span>
          </header>
        }
      >
        {(head) => head()}
      </Show>
      <ol class="im-session-flow">
        <Show when={props.messages.length > 0} fallback={<p class="im-session-empty">{t("im.session.empty")}</p>}>
          <For each={props.messages}>
            {(message) => (
              <li
                class="im-message"
                data-sender={message.senderKind}
                data-withdrawn={imWithdrawn(message) ? "" : undefined}
                data-phase={phaseOf(message)}
              >
                <span class="im-message-sender">
                  {message.senderKind === "self" ? t("im.message.fromSelf") : message.senderName}
                </span>
                <p class="im-message-body">{message.body}</p>
                <p class="im-message-meta">
                  <Show when={message.verified}>
                    <span class="im-message-verified">{t("im.message.verified")}</span>
                  </Show>
                  <Show when={imProxyMarkVisible(message)}>
                    <span class="im-message-proxy">{t("im.proxy.mark")}</span>
                  </Show>
                  <Show when={imWithdrawn(message)}>
                    <span class="im-message-withdrawn">{t("im.message.withdrawn")}</span>
                  </Show>
                  <Show when={message.delivery}>
                    {(state) => (
                      <Show when={!imWithdrawn(message)}>
                        <span class="im-message-delivery" data-state={state()} data-phase={phaseOf(message)}>
                          {t(IM_SEND_PHASE_LABEL[phaseOf(message)] ?? IM_DELIVERY_LABEL[state()])}
                        </span>
                      </Show>
                    )}
                  </Show>
                  <Show when={phaseOf(message) === "undelivered"}>
                    <span class="im-message-undelivered-hint">{t(imUndeliveredHintKey(message))}</span>
                  </Show>
                  <Show when={!imWithdrawn(message) && props.onWithdraw !== undefined}>
                    <Button type="button" size="xs" variant="ghost" onClick={() => void props.onWithdraw?.(message)}>
                      {t("im.message.withdraw")}
                    </Button>
                  </Show>
                  <Show when={imResendable(message) && props.onResend !== undefined && !resendingNow(message)}>
                    <Button type="button" size="xs" variant="ghost" onClick={() => void props.onResend?.(message)}>
                      {t("im.message.resend")}
                    </Button>
                  </Show>
                  <Show when={imWithdrawn(message)}>
                    <span class="im-message-tombstone">{t("im.message.tombstone")}</span>
                  </Show>
                  <time class="im-message-time">{format.date(new Date(message.sentAt))}</time>
                </p>
              </li>
            )}
          </For>
        </Show>
      </ol>
      <Show when={props.onResend !== undefined}>
        <ImUndelivered
          messages={imUndeliveredRows(props.messages)}
          resending={props.resending}
          onResend={(message) => props.onResend?.(message)}
          onEdit={canEditResend() ? editResend : undefined}
        />
      </Show>
      <Show
        when={props.composer}
        fallback={
          <form
            class="im-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Textarea
              class="im-composer-input"
              aria-label={t("im.session.composePlaceholder")}
              placeholder={t("im.session.composePlaceholder")}
              rows={2}
              value={draft()}
              disabled={props.sending === true || busy()}
              onValueChange={setDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <Button type="submit" size="sm" disabled={draft().trim() === "" || props.sending === true || busy()}>
              {props.sending === true || busy() ? t("im.session.sending") : t("im.session.send")}
            </Button>
          </form>
        }
      >
        {(composer) => composer()}
      </Show>
    </section>
  );
}
