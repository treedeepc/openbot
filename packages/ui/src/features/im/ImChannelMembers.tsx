import { Button } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";

export type ImChannelRole = "admin" | "member" | "readonly";

export interface ImChannelMemberRow {
  id: string;
  name: string;
  role: ImChannelRole;
  external: boolean;
}

export interface ImChannelMembersProps {
  members: readonly ImChannelMemberRow[];
  canAdminister: boolean;
  canInvite: boolean;
  onInvite?: (() => void) | undefined;
  onRoleChange?: ((id: string, role: ImChannelRole) => void | Promise<void>) | undefined;
  onRemove?: ((id: string) => void | Promise<void>) | undefined;
}

const ROLE_LABEL: Record<ImChannelRole, "im.channel.admin" | "im.channel.member" | "im.channel.readonly"> = {
  admin: "im.channel.admin",
  member: "im.channel.member",
  readonly: "im.channel.readonly",
};

export function ImChannelMembers(props: ImChannelMembersProps): JSX.Element {
  const { t } = useText();
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

  return (
    <section class="im-channel-members" aria-label={t("im.channel.title")}>
      <h3 class="im-channel-title">{t("im.channel.title")}</h3>
      <Show when={props.canInvite && props.onInvite !== undefined}>
        <Button type="button" size="xs" variant="ghost" onClick={() => props.onInvite?.()}>
          {t("im.channel.invite")}
        </Button>
      </Show>
      <ul class="im-inbox-list">
        <For each={props.members}>
          {(member) => (
            <li class="im-inbox-row">
              <span class="im-inbox-names">
                <span class="im-inbox-peer">
                  {member.name}
                  <span class="im-inbox-proxy">{t(ROLE_LABEL[member.role])}</span>
                  <Show when={member.external}>
                    <span class="im-inbox-proxy">{t("im.channel.external")}</span>
                  </Show>
                </span>
              </span>
              <Show when={props.canAdminister}>
                <span class="im-inbox-actions">
                  <Show when={props.onRoleChange !== undefined}>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy() || member.role === "admin"}
                      onClick={() => void run(() => props.onRoleChange?.(member.id, "admin"))}
                    >
                      {t("im.channel.makeAdmin")}
                    </Button>
                  </Show>
                  <Show when={props.onRemove !== undefined}>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy()}
                      onClick={() => void run(() => props.onRemove?.(member.id))}
                    >
                      {t("im.channel.remove")}
                    </Button>
                  </Show>
                </span>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
