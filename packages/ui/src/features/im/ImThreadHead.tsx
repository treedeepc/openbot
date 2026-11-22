import { imFingerprintText } from "@openbot/team-client/im-client";
import { Button, CircleCheck, TriangleAlert } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { useText } from "../../text";
import { UserAvatar } from "../../user-avatar";
import { ImAssignBar } from "./ImAssignBar";
import { ImReportAction } from "./ImReportPicker";
import {
  IM_NETWORK_LABEL,
  type ImAgentOption,
  type ImAssignee,
  type ImNetworkState,
  type ImPeerSummary,
  type ImReportCategory,
} from "./im-inbox";

export interface ImThreadHeadProps {
  peer: ImPeerSummary;
  network: ImNetworkState;
  agents?: readonly ImAgentOption[] | undefined;
  assignees?: readonly ImAssignee[] | undefined;
  onAssignChange?: ((next: readonly ImAssignee[]) => void | Promise<void>) | undefined;
  onBlock?: (() => void | Promise<void>) | undefined;
  onReport?: ((category: ImReportCategory) => void | Promise<void>) | undefined;
  mutedUntil?: number | null | undefined;
  onMuteChange?: ((mutedUntil: number | null) => void | Promise<void>) | undefined;
  readReceipts?: boolean | undefined;
  onReadReceiptsChange?: ((value: boolean) => void | Promise<void>) | undefined;
}

export function ImThreadHead(props: ImThreadHeadProps): JSX.Element {
  const { t, format } = useText();

  return (
    <header class="im-thread-head">
      <div class="im-thread-identity">
        <UserAvatar class="im-thread-avatar" decorative user={{ name: props.peer.name, email: "", avatarUrl: null }} />
        <div class="im-thread-titles">
          <p class="im-thread-name">{props.peer.name}</p>
          <p class="im-thread-status">
            <span class="im-thread-verified" data-verified={props.peer.verified ? "" : undefined}>
              {props.peer.verified ? <CircleCheck aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
              {props.peer.verified ? t("im.session.verified") : t("im.session.unverified")}
            </span>
            <span class="im-thread-network">{t(IM_NETWORK_LABEL[props.network])}</span>
            <Show when={props.peer.fingerprint}>
              {(fingerprint) => <span class="im-thread-fingerprint">{imFingerprintText(fingerprint())}</span>}
            </Show>
          </p>
        </div>
        {props.onBlock || props.onReport ? (
          <div class="im-thread-actions">
            {props.onBlock ? (
              <Button type="button" size="xs" variant="ghost" onClick={() => void props.onBlock?.()}>
                {t("im.actions.block")}
              </Button>
            ) : null}
            {props.onReport ? <ImReportAction label={t("im.actions.report")} onReport={props.onReport} /> : null}
          </div>
        ) : null}
      </div>
      <div class="im-thread-toggles">
        <Show when={props.onMuteChange !== undefined}>
          <Button
            type="button"
            size="xs"
            variant={props.mutedUntil !== null && props.mutedUntil !== undefined ? "default" : "ghost"}
            onClick={() => void props.onMuteChange?.(props.mutedUntil ? null : Date.now() + 8 * 3_600_000)}
          >
            {t("im.settings.mute")}
          </Button>
        </Show>
        <Show when={props.mutedUntil}>
          {(until) => (
            <span class="im-thread-muted">{t("im.thread.mutedUntil", { time: format.date(new Date(until())) })}</span>
          )}
        </Show>
        <Show when={props.onReadReceiptsChange !== undefined}>
          <Button
            type="button"
            size="xs"
            variant={props.readReceipts === false ? "ghost" : "default"}
            onClick={() => void props.onReadReceiptsChange?.(props.readReceipts === false)}
          >
            {t("im.thread.readReceipts")}
          </Button>
        </Show>
      </div>
      <Show when={props.agents !== undefined && props.onAssignChange !== undefined}>
        <ImAssignBar
          agents={props.agents ?? []}
          assignees={props.assignees ?? []}
          onChange={(next) => props.onAssignChange?.(next)}
        />
      </Show>
    </header>
  );
}
