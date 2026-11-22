import {
  IM_PROXY_DEFAULT_BUDGET_USD,
  IM_PROXY_SEND_FAILURE_LABEL,
  type ImProxySendFailure,
  imProxyBudgetUsd,
} from "@openbot/team-client/im-proxy";
import { Button, Input, Textarea } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import type { ImAgentOption } from "./im-inbox";

export interface ImComposerProps {
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: (body: string) => void | Promise<void>;
  sending?: boolean | undefined;
  senders: readonly ImAgentOption[];
  senderId: string;
  onSenderChange: (id: string) => void;
  proxyEnabled: boolean;
  onProxyChange: (enabled: boolean) => void;
  proxyBudgetUsd?: number | undefined;
  onProxyBudgetChange?: ((usd: number) => void) | undefined;
  draftFrom?: string | null | undefined;
  onDiscardDraft?: (() => void) | undefined;
  showProxyMark?: boolean | undefined;
  onShowProxyMarkChange?: ((value: boolean) => void) | undefined;
  sendFailure?: ImProxySendFailure | null | undefined;
}

export function ImComposer(props: ImComposerProps): JSX.Element {
  const { t } = useText();
  const [busy, setBusy] = createSignal(false);
  const [budgetText, setBudgetText] = createSignal<string | null>(null);
  const budgetOf = () => props.proxyBudgetUsd ?? IM_PROXY_DEFAULT_BUDGET_USD;
  const budgetShown = () => budgetText() ?? String(budgetOf());

  function commitBudget(): void {
    const parsed = Number(budgetShown().trim());
    const next = imProxyBudgetUsd(Number.isFinite(parsed) ? parsed : budgetOf());
    setBudgetText(String(next));
    props.onProxyBudgetChange?.(next);
  }

  async function send(): Promise<void> {
    const body = props.draft.trim();
    if (body === "" || busy() || props.sending === true) return;
    setBusy(true);
    try {
      await props.onSend(body);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="im-composer-bar">
      <Show when={props.draftFrom}>
        {(from) => (
          <div class="im-draft-pending">
            <p class="im-draft-note">{t("im.draft.pending", { name: from() })}</p>
            <Button type="button" size="sm" disabled={busy() || props.sending === true} onClick={() => void send()}>
              {t("im.draft.confirm")}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => props.onDiscardDraft?.()}>
              {t("im.draft.discard")}
            </Button>
          </div>
        )}
      </Show>
      <fieldset class="im-composer-bar-modes">
        <legend class="sr-only">{t("im.composer.modes")}</legend>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-pressed={props.proxyEnabled ? "true" : "false"}
          onClick={() => props.onProxyChange(!props.proxyEnabled)}
        >
          {t("im.composer.proxy")}
        </Button>
        <Show when={props.proxyEnabled}>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-pressed={props.showProxyMark !== false ? "true" : "false"}
            onClick={() => props.onShowProxyMarkChange?.(props.showProxyMark === false)}
          >
            {t("im.proxy.showMark")}
          </Button>
        </Show>
        <Show when={props.proxyEnabled}>
          <span class="im-proxy-budget">
            <Input
              size="sm"
              aria-label={t("im.settings.budget")}
              value={budgetShown()}
              onValueChange={setBudgetText}
              onBlur={commitBudget}
            />
            {t("im.proxy.budget", { usd: budgetOf() })}
          </span>
        </Show>
        <For each={props.senders}>
          {(sender) => (
            <Button
              type="button"
              size="xs"
              variant={props.senderId === sender.id ? "default" : "ghost"}
              aria-pressed={props.senderId === sender.id ? "true" : "false"}
              disabled={sender.id !== "self" && !props.proxyEnabled}
              onClick={() => props.onSenderChange(sender.id)}
            >
              {sender.name}
            </Button>
          )}
        </For>
      </fieldset>
      <Show when={props.sendFailure}>
        {(kind) => <p class="im-send-failed">{t(IM_PROXY_SEND_FAILURE_LABEL[kind()])}</p>}
      </Show>
      <form
        class="im-composer-bar-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Textarea
          class="im-composer-bar-input"
          aria-label={t("im.session.composePlaceholder")}
          placeholder={t("im.session.composePlaceholder")}
          rows={2}
          value={props.draft}
          disabled={props.sending === true || busy()}
          onValueChange={(text) => props.onDraftChange(text)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Button type="submit" size="sm" disabled={props.draft.trim() === "" || props.sending === true || busy()}>
          {props.sending === true || busy() ? t("im.session.sending") : t("im.session.send")}
        </Button>
      </form>
    </div>
  );
}
