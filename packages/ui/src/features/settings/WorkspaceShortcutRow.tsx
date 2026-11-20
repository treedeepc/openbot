import { Button, Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, Show } from "solid-js";
import { useText } from "../../text";
import {
  setWorkspaceShortcutRecording,
  WORKSPACE_SHORTCUT_NAMES,
  type WorkspaceShortcutBinding,
  type WorkspaceShortcutBindings,
  type WorkspaceShortcutName,
  type WorkspaceShortcutPlatform,
  workspaceShortcutBindingOf,
  workspaceShortcutFromEvent,
  workspaceShortcutGlyph,
  workspaceShortcutIsModifier,
  workspaceShortcutSame,
} from "../window/workspace-shortcuts";

export interface WorkspaceShortcutRowProps {
  name: WorkspaceShortcutName;
  labels: Record<WorkspaceShortcutName, string>;
  stored: WorkspaceShortcutBinding | null | undefined;
  bindings: WorkspaceShortcutBindings;
  platform: WorkspaceShortcutPlatform;
  onChange: (value: WorkspaceShortcutBinding | null | undefined) => void;
}

export function WorkspaceShortcutRow(props: WorkspaceShortcutRowProps): JSX.Element {
  const { t } = useText();
  const [recording, setRecording] = createSignal(false);
  const [conflict, setConflict] = createSignal<string | null>(null);
  const [needsModifier, setNeedsModifier] = createSignal(false);
  let field: HTMLDivElement | undefined;

  const current = () => workspaceShortcutBindingOf(props.stored, props.name, props.platform);
  const chip = () => {
    if (recording()) return t("settings.shortcuts.recording");
    const binding = current();
    return binding ? workspaceShortcutGlyph(binding, props.platform) : t("settings.shortcuts.unset");
  };
  const message = () => {
    if (conflict()) return t("settings.shortcuts.conflict", { name: conflict() ?? "" });
    if (needsModifier()) return t("settings.shortcuts.needModifier");
    return undefined;
  };

  function clearMessage(): void {
    setConflict(null);
    setNeedsModifier(false);
  }

  function stop(): void {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", cancel);
    document.removeEventListener("pointerdown", onPointerDown, true);
    setWorkspaceShortcutRecording(false);
    setRecording(false);
  }

  function cancel(): void {
    clearMessage();
    stop();
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.target instanceof Node && field && !field.contains(event.target)) cancel();
  }

  function onKeyDown(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
    const key = event.key.toLowerCase();
    if (key === "escape") {
      cancel();
      return;
    }
    if (key === "backspace" || key === "delete") {
      props.onChange(null);
      clearMessage();
      stop();
      return;
    }
    if (workspaceShortcutIsModifier(event.key)) return;
    const binding = workspaceShortcutFromEvent(event);
    if (!binding) {
      setConflict(null);
      setNeedsModifier(true);
      return;
    }
    const clash = WORKSPACE_SHORTCUT_NAMES.find(
      (other) => other !== props.name && workspaceShortcutSame(props.bindings[other], binding),
    );
    if (clash) {
      setNeedsModifier(false);
      setConflict(props.labels[clash]);
      return;
    }
    props.onChange(binding);
    clearMessage();
    stop();
  }

  function start(): void {
    if (recording()) return;
    clearMessage();
    setRecording(true);
    setWorkspaceShortcutRecording(true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("pointerdown", onPointerDown, true);
  }

  onCleanup(stop);

  return (
    <Item data-settings-row={`settings.shortcuts.${props.name}`} class="settings-modal-row">
      <ItemContent>
        <ItemTitle>{props.labels[props.name]}</ItemTitle>
        <Show when={message()}>
          <ItemDescription>{message()}</ItemDescription>
        </Show>
      </ItemContent>
      <ItemActions>
        <div class="workspace-shortcut-field" ref={(element) => (field = element)} tabindex={-1}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            class="workspace-shortcut-trigger"
            aria-pressed={recording() ? "true" : "false"}
            onClick={() => (recording() ? cancel() : start())}
          >
            {chip()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={props.stored === null}
            onClick={() => {
              clearMessage();
              props.onChange(null);
              stop();
            }}
          >
            {t("settings.shortcuts.clear")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={props.stored === undefined}
            onClick={() => {
              clearMessage();
              props.onChange(undefined);
              stop();
            }}
          >
            {t("settings.shortcuts.reset")}
          </Button>
        </div>
      </ItemActions>
    </Item>
  );
}
