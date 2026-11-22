import { Button } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { useText } from "../../text";
import { IM_SEND_PHASE_LABEL, type ImMessageRow, imSendPhase, imUndeliveredHintKey } from "./im-session";

export interface ImUndeliveredProps {
  messages: readonly ImMessageRow[];
  resending?: readonly string[] | undefined;
  onResend: (message: ImMessageRow) => void | Promise<void>;
  onEdit?: ((message: ImMessageRow) => void) | undefined;
}

export function ImUndelivered(props: ImUndeliveredProps): JSX.Element {
  const { t } = useText();
  return (
    <Show when={props.messages.length > 0}>
      <section class="im-undelivered" aria-label={t("im.message.pendingTitle", { count: props.messages.length })}>
        <h3 class="im-undelivered-title">{t("im.message.pendingTitle", { count: props.messages.length })}</h3>
        <ul class="im-undelivered-list">
          <For each={props.messages}>
            {(message) => {
              const inFlight = () => props.resending?.includes(message.id) ?? false;
              const phase = () => imSendPhase(message, inFlight());
              const label = () => IM_SEND_PHASE_LABEL[phase()];
              return (
                <li class="im-undelivered-row" data-phase={phase()}>
                  <p class="im-undelivered-body">{message.body}</p>
                  <p class="im-undelivered-meta">
                    <Show when={label()}>{(key) => <span class="im-undelivered-state">{t(key())}</span>}</Show>
                    <Show when={!inFlight()}>
                      <span class="im-undelivered-hint">{t(imUndeliveredHintKey(message))}</span>
                    </Show>
                  </p>
                  <p class="im-undelivered-actions">
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      disabled={inFlight()}
                      onClick={() => void props.onResend(message)}
                    >
                      {t("im.message.resend")}
                    </Button>
                    <Show when={props.onEdit !== undefined}>
                      <Button type="button" size="xs" variant="ghost" onClick={() => props.onEdit?.(message)}>
                        {t("im.message.editAndResend")}
                      </Button>
                    </Show>
                  </p>
                </li>
              );
            }}
          </For>
        </ul>
      </section>
    </Show>
  );
}
