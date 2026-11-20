import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  WORKSPACE_SHORTCUT_NAMES,
  type WorkspaceShortcutBinding,
  type WorkspaceShortcutBindings,
  type WorkspaceShortcutName,
  type WorkspaceShortcutPlatform,
  workspaceShortcutBindingsOf,
} from "@openbot/ui/features/window/workspace-shortcuts";
import { createSignal } from "solid-js";
import { currentDevicePlatform } from "../../send-shortcut-preference";

const STORAGE_KEY = "openbot:workspace-shortcuts";

type StoredBindings = Partial<Record<WorkspaceShortcutName, WorkspaceShortcutBinding | null>>;

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function isBinding(value: unknown): value is WorkspaceShortcutBinding {
  if (!isDynamicRecord(value)) return false;
  return (
    typeof value.key === "string" &&
    value.key.length > 0 &&
    typeof value.metaKey === "boolean" &&
    typeof value.ctrlKey === "boolean" &&
    typeof value.altKey === "boolean" &&
    typeof value.shiftKey === "boolean"
  );
}

function parseStored(raw: string | null): StoredBindings {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!isDynamicRecord(parsed)) return {};
    const stored: StoredBindings = {};
    for (const name of WORKSPACE_SHORTCUT_NAMES) {
      const value = parsed[name];
      if (value === null) stored[name] = null;
      else if (isBinding(value)) stored[name] = value;
    }
    return stored;
  } catch {
    return {};
  }
}

let unsavedPreference: StoredBindings | undefined;

function readStored(storage?: PreferenceStorage): StoredBindings {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return parseStored((storage ?? window.localStorage).getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

function writeStored(stored: StoredBindings, storage?: PreferenceStorage): void {
  try {
    (storage ?? window.localStorage).setItem(STORAGE_KEY, JSON.stringify(stored));
    unsavedPreference = undefined;
  } catch {
    unsavedPreference = stored;
  }
}

export function workspaceShortcutPlatform(): WorkspaceShortcutPlatform {
  return currentDevicePlatform() === "darwin" ? "mac" : "pc";
}

const [storedBindings, setStoredBindings] = createSignal<StoredBindings>(readStored());

function readStorageIntoSignal(event: StorageEvent): void {
  if (event.key !== null && event.key !== STORAGE_KEY) return;
  setStoredBindings(readStored());
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", readStorageIntoSignal);
  import.meta.hot?.dispose(() => {
    window.removeEventListener("storage", readStorageIntoSignal);
  });
}

export function useWorkspaceShortcutStored(): () => StoredBindings {
  return storedBindings;
}

export function useWorkspaceShortcutBindings(): () => WorkspaceShortcutBindings {
  return () => workspaceShortcutBindingsOf(storedBindings(), workspaceShortcutPlatform());
}

export function setWorkspaceShortcut(
  name: WorkspaceShortcutName,
  value: WorkspaceShortcutBinding | null | undefined,
): void {
  const next: StoredBindings = { ...readStored() };
  if (value === undefined) delete next[name];
  else next[name] = value;
  writeStored(next);
  setStoredBindings(next);
}
