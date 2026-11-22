import type { ImNotificationSettings, ImProfile, ImProxySettings } from "@openbot/contracts/ipc";
import { Button, Input } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";

export interface ImSettingsProps {
  proxy: ImProxySettings;
  onProxyChange: (next: ImProxySettings) => void | Promise<void>;
  notifications: ImNotificationSettings;
  onNotificationsChange: (next: ImNotificationSettings) => void | Promise<void>;
  profile: Pick<ImProfile, "searchable">;
  onSearchableChange: (searchable: boolean) => void | Promise<void>;
  networking: { lanDiscovery: boolean; selfHosted: boolean };
  onNetworkingChange: (next: { lanDiscovery: boolean; selfHosted: boolean }) => void;
  lanDiscoverySupported?: boolean | undefined;
  onOpenIm?: ((button: HTMLElement) => void) | undefined;
}

const NOTIFY_ON = ["all", "mentions", "none"] as const;

export function ImSettings(props: ImSettingsProps): JSX.Element {
  const { t } = useText();
  const [budget, setBudget] = createSignal(String(props.proxy.monthlyBudgetUsd));
  const [busy, setBusy] = createSignal(false);

  async function run(action: () => void | Promise<void>): Promise<void> {
    if (busy()) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  function commitBudget(): void {
    const value = Number(budget().trim());
    if (!Number.isFinite(value) || value < 0) {
      setBudget(String(props.proxy.monthlyBudgetUsd));
      return;
    }
    void run(() => props.onProxyChange({ ...props.proxy, monthlyBudgetUsd: Math.round(value) }));
  }

  return (
    <section class="im-settings" aria-label={t("im.settings.title")} data-settings-row="im.settings.title">
      <Show when={props.onOpenIm !== undefined}>
        <Button type="button" size="sm" variant="ghost" onClick={(event) => props.onOpenIm?.(event.currentTarget)}>
          {t("im.settings.openPage")}
        </Button>
      </Show>
      <h2 class="im-settings-title">{t("im.settings.title")}</h2>

      <fieldset class="im-settings-group">
        <legend class="im-settings-legend">{t("im.settings.proxyGroup")}</legend>
        <Button
          type="button"
          size="sm"
          variant={props.proxy.enabled ? "default" : "ghost"}
          aria-pressed={props.proxy.enabled ? "true" : "false"}
          disabled={busy()}
          onClick={() => void run(() => props.onProxyChange({ ...props.proxy, enabled: !props.proxy.enabled }))}
        >
          {t("im.settings.proxy")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={props.proxy.visibility === "shown" ? "default" : "ghost"}
          aria-pressed={props.proxy.visibility === "shown" ? "true" : "false"}
          disabled={busy()}
          onClick={() =>
            void run(() =>
              props.onProxyChange({
                ...props.proxy,
                visibility: props.proxy.visibility === "shown" ? "hidden" : "shown",
              }),
            )
          }
        >
          {t("im.settings.mark")}
        </Button>
        <label class="im-settings-field">
          <span>{t("im.settings.budget")}</span>
          <Input size="sm" value={budget()} onValueChange={setBudget} onBlur={commitBudget} />
        </label>
        <p class="im-settings-hint">{t("im.settings.budgetHint")}</p>
      </fieldset>

      <fieldset class="im-settings-group">
        <legend class="im-settings-legend">{t("im.settings.notifications")}</legend>
        <Button
          type="button"
          size="sm"
          variant={props.notifications.showPreview ? "default" : "ghost"}
          aria-pressed={props.notifications.showPreview ? "true" : "false"}
          disabled={busy()}
          onClick={() =>
            void run(() =>
              props.onNotificationsChange({ ...props.notifications, showPreview: !props.notifications.showPreview }),
            )
          }
        >
          {t("im.settings.showPreview")}
        </Button>
        <For each={NOTIFY_ON}>
          {(value) => (
            <Button
              type="button"
              size="sm"
              variant={props.notifications.notifyOn === value ? "default" : "ghost"}
              aria-pressed={props.notifications.notifyOn === value ? "true" : "false"}
              disabled={busy()}
              onClick={() => void run(() => props.onNotificationsChange({ ...props.notifications, notifyOn: value }))}
            >
              {t(
                value === "all"
                  ? "im.settings.notifyAll"
                  : value === "mentions"
                    ? "im.settings.notifyMentions"
                    : "im.settings.notifyNone",
              )}
            </Button>
          )}
        </For>
        <Button
          type="button"
          size="sm"
          variant={props.notifications.mutedUntil !== null ? "default" : "ghost"}
          aria-pressed={props.notifications.mutedUntil !== null ? "true" : "false"}
          disabled={busy()}
          onClick={() =>
            void run(() =>
              props.onNotificationsChange({
                ...props.notifications,
                mutedUntil: props.notifications.mutedUntil === null ? Date.now() + 8 * 3_600_000 : null,
              }),
            )
          }
        >
          {t("im.settings.mute")}
        </Button>
        <Show when={props.notifications.mutedUntil !== null}>
          <p class="im-settings-hint">{t("im.settings.muteHint")}</p>
        </Show>
      </fieldset>

      <fieldset class="im-settings-group">
        <legend class="im-settings-legend">{t("im.settings.network")}</legend>
        <Show when={props.lanDiscoverySupported !== false}>
          <Button
            type="button"
            size="sm"
            variant={props.networking.lanDiscovery ? "default" : "ghost"}
            aria-pressed={props.networking.lanDiscovery ? "true" : "false"}
            onClick={() =>
              props.onNetworkingChange({ ...props.networking, lanDiscovery: !props.networking.lanDiscovery })
            }
          >
            {t("im.settings.lan")}
          </Button>
        </Show>
        <Button
          type="button"
          size="sm"
          variant={props.networking.selfHosted ? "default" : "ghost"}
          aria-pressed={props.networking.selfHosted ? "true" : "false"}
          onClick={() => props.onNetworkingChange({ ...props.networking, selfHosted: !props.networking.selfHosted })}
        >
          {t("im.settings.selfHosted")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={props.profile.searchable ? "default" : "ghost"}
          aria-pressed={props.profile.searchable ? "true" : "false"}
          disabled={busy()}
          onClick={() => void run(() => props.onSearchableChange(!props.profile.searchable))}
        >
          {t("im.settings.searchable")}
        </Button>
        <p class="im-settings-hint">{t("im.settings.searchableHint")}</p>
      </fieldset>
    </section>
  );
}
