import type { ImNotificationSettings, ImProxySettings } from "@openbot/contracts/ipc";
import type { ImHostPort } from "@openbot/team-client/im-client";
import { ImSettings } from "@openbot/ui/features/im/ImSettings";
import type { JSX } from "@solidjs/web";
import { createSignal, onSettled } from "solid-js";

const DEFAULT_PROXY: ImProxySettings = { enabled: false, visibility: "shown", monthlyBudgetUsd: 20 };
const DEFAULT_NOTIFICATIONS: ImNotificationSettings = {
  threadId: null,
  mutedUntil: null,
  notifyOn: "all",
  showPreview: true,
};

export function ImSettingsPanel(props: {
  port: ImHostPort | null;
  networking: { lanDiscovery: boolean; selfHosted: boolean };
  onNetworkingChange: (next: { lanDiscovery: boolean; selfHosted: boolean }) => void;
  lanDiscoverySupported?: boolean | undefined;
  onOpenIm?: ((button: HTMLElement) => void) | undefined;
}): JSX.Element {
  const [proxy, setProxy] = createSignal<ImProxySettings>(DEFAULT_PROXY);
  const [notifications, setNotifications] = createSignal<ImNotificationSettings>(DEFAULT_NOTIFICATIONS);
  const [searchable, setSearchable] = createSignal(false);

  onSettled(() => {
    const port = props.port;
    if (!port) return;
    void port.proxy
      .get()
      .then(setProxy)
      .catch(() => undefined);
    void port.notifications
      .get(null)
      .then(setNotifications)
      .catch(() => undefined);
    void port.profile
      .get()
      .then((profile) => setSearchable(profile.searchable))
      .catch(() => undefined);
  });

  async function saveProxy(next: ImProxySettings): Promise<void> {
    setProxy(next);
    const port = props.port;
    if (!port) return;
    try {
      setProxy(await port.proxy.set(next));
    } catch {
      setProxy(next);
    }
  }

  async function saveNotifications(next: ImNotificationSettings): Promise<void> {
    setNotifications(next);
    const port = props.port;
    if (!port) return;
    try {
      setNotifications(await port.notifications.set(next));
    } catch {
      setNotifications(next);
    }
  }

  async function saveSearchable(value: boolean): Promise<void> {
    setSearchable(value);
    const port = props.port;
    if (!port) return;
    try {
      const profile = await port.profile.get();
      setSearchable((await port.profile.update({ ...profile, searchable: value })).searchable);
    } catch {
      setSearchable(value);
    }
  }

  return (
    <ImSettings
      proxy={proxy()}
      onProxyChange={saveProxy}
      notifications={notifications()}
      onNotificationsChange={saveNotifications}
      profile={{ searchable: searchable() }}
      onSearchableChange={saveSearchable}
      networking={props.networking}
      onNetworkingChange={props.onNetworkingChange}
      lanDiscoverySupported={props.lanDiscoverySupported}
      onOpenIm={props.onOpenIm}
    />
  );
}

export { DEFAULT_NOTIFICATIONS, DEFAULT_PROXY };
