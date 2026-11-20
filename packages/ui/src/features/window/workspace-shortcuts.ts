export type WorkspaceShortcutName = "openAgents" | "cycleModules";

export type WorkspaceShortcutPlatform = "mac" | "pc";

export const WORKSPACE_SHORTCUT_NAMES = [
  "openAgents",
  "cycleModules",
] as const satisfies readonly WorkspaceShortcutName[];

export interface WorkspaceShortcutBinding {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}

export type WorkspaceShortcutBindings = Record<WorkspaceShortcutName, WorkspaceShortcutBinding | null>;

interface ShortcutKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_KEYS = new Set([
  "shift",
  "control",
  "ctrl",
  "alt",
  "option",
  "meta",
  "command",
  "cmd",
  "os",
  "altgraph",
  "capslock",
]);

export function defaultWorkspaceShortcut(
  name: WorkspaceShortcutName,
  platform: WorkspaceShortcutPlatform,
): WorkspaceShortcutBinding {
  return {
    metaKey: platform === "mac",
    ctrlKey: platform !== "mac",
    altKey: false,
    shiftKey: true,
    key: name === "openAgents" ? "a" : "s",
  };
}

export function defaultWorkspaceShortcutBindings(platform: WorkspaceShortcutPlatform): WorkspaceShortcutBindings {
  return {
    openAgents: defaultWorkspaceShortcut("openAgents", platform),
    cycleModules: defaultWorkspaceShortcut("cycleModules", platform),
  };
}

export function workspaceShortcutBindingOf(
  stored: WorkspaceShortcutBinding | null | undefined,
  name: WorkspaceShortcutName,
  platform: WorkspaceShortcutPlatform,
): WorkspaceShortcutBinding | null {
  return stored === undefined ? defaultWorkspaceShortcut(name, platform) : stored;
}

export function workspaceShortcutBindingsOf(
  stored: Partial<Record<WorkspaceShortcutName, WorkspaceShortcutBinding | null>>,
  platform: WorkspaceShortcutPlatform,
): WorkspaceShortcutBindings {
  return {
    openAgents: workspaceShortcutBindingOf(stored.openAgents, "openAgents", platform),
    cycleModules: workspaceShortcutBindingOf(stored.cycleModules, "cycleModules", platform),
  };
}

function sameBinding(binding: WorkspaceShortcutBinding, event: ShortcutKey): boolean {
  return (
    binding.metaKey === event.metaKey &&
    binding.ctrlKey === event.ctrlKey &&
    binding.altKey === event.altKey &&
    binding.shiftKey === event.shiftKey &&
    binding.key.toLowerCase() === event.key.toLowerCase()
  );
}

export function workspaceShortcutIsModifier(key: string): boolean {
  return MODIFIER_KEYS.has(key.toLowerCase());
}

export function workspaceShortcutSame(
  left: WorkspaceShortcutBinding | null | undefined,
  right: WorkspaceShortcutBinding | null | undefined,
): boolean {
  return Boolean(left && right && sameBinding(left, right));
}

export function workspaceShortcutCommand(
  event: ShortcutKey,
  bindings: WorkspaceShortcutBindings,
): WorkspaceShortcutName | undefined {
  for (const name of WORKSPACE_SHORTCUT_NAMES) {
    const binding = bindings[name];
    if (binding && sameBinding(binding, event)) return name;
  }
  return undefined;
}

export function workspaceShortcutFromEvent(event: ShortcutKey): WorkspaceShortcutBinding | undefined {
  const key = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return undefined;
  if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return undefined;
  return { metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, key };
}

export function workspaceShortcutHoldsModifier(binding: WorkspaceShortcutBinding): boolean {
  return binding.metaKey || binding.ctrlKey || binding.altKey || binding.shiftKey;
}

let shortcutRecording = false;

export function isWorkspaceShortcutRecording(): boolean {
  return shortcutRecording;
}

export function setWorkspaceShortcutRecording(value: boolean): void {
  shortcutRecording = value;
}

const KEY_LABELS: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "↵",
  return: "↵",
  tab: "⇥",
  space: "␣",
  backspace: "⌫",
  delete: "⌦",
  escape: "Esc",
  home: "↖",
  end: "↘",
  pageup: "⇞",
  pagedown: "⇟",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  backquote: "`",
  quote: "'",
  semicolon: ";",
  bracketleft: "[",
  bracketright: "]",
  minus: "-",
  equal: "=",
};

function keyLabel(key: string): string {
  const lower = key.toLowerCase();
  if (KEY_LABELS[lower]) return KEY_LABELS[lower];
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
  return key.length === 1 ? key.toUpperCase() : key;
}

export function workspaceShortcutGlyph(binding: WorkspaceShortcutBinding, platform: WorkspaceShortcutPlatform): string {
  const parts =
    platform === "mac"
      ? [binding.ctrlKey ? "⌃" : "", binding.altKey ? "⌥" : "", binding.shiftKey ? "⇧" : "", binding.metaKey ? "⌘" : ""]
      : [
          binding.ctrlKey ? "Ctrl+" : "",
          binding.altKey ? "Alt+" : "",
          binding.shiftKey ? "Shift+" : "",
          binding.metaKey ? "Meta+" : "",
        ];
  return [...parts, keyLabel(binding.key)].join("");
}
