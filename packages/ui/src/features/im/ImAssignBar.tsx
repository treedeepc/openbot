import { Button } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { useText } from "../../text";
import { type ImAgentOption, type ImAssignee, imSetPrimary, imToggleAssignee } from "./im-inbox";

export interface ImAssignBarProps {
  agents: readonly ImAgentOption[];
  assignees: readonly ImAssignee[];
  onChange: (next: readonly ImAssignee[]) => void | Promise<void>;
}

export function ImAssignBar(props: ImAssignBarProps): JSX.Element {
  const { t } = useText();
  const assigned = (id: string) => props.assignees.some((item) => item.id === id);
  const primary = (id: string) => props.assignees.some((item) => item.id === id && item.primary);

  return (
    <fieldset class="im-assign">
      <legend class="im-assign-label">{t("im.assign.title")}</legend>
      <For each={props.agents}>
        {(agent) => (
          <span class="im-assign-chip">
            <Button
              type="button"
              size="xs"
              variant={assigned(agent.id) ? "default" : "ghost"}
              aria-pressed={assigned(agent.id) ? "true" : "false"}
              onClick={() => void props.onChange(imToggleAssignee(props.assignees, agent))}
            >
              {agent.name}
            </Button>
            <Show when={assigned(agent.id)}>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-pressed={primary(agent.id) ? "true" : "false"}
                onClick={() => void props.onChange(imSetPrimary(props.assignees, agent.id))}
              >
                {t("im.assign.primary")}
              </Button>
            </Show>
          </span>
        )}
      </For>
      <Show when={props.assignees.length === 0}>
        <span class="im-assign-empty">{t("im.assign.empty")}</span>
      </Show>
    </fieldset>
  );
}
