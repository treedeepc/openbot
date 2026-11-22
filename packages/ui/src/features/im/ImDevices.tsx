import type { ImDevice } from "@openbot/contracts/ipc";
import { type ImEnrollChallenge, imFingerprintText } from "@openbot/team-client/im-client";
import {
  IM_PAIRING_FAILURE_LABEL,
  type ImPairingFailure,
  imPairingCountdown,
  imPairingExpired,
  imPairingFailure,
} from "@openbot/team-client/im-pairing";
import { Button, Input } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, Show } from "solid-js";
import { useText } from "../../text";

export type { ImEnrollChallenge };

export interface ImDevicesProps {
  devices: readonly ImDevice[];
  onEnroll: (deviceName: string, publicKey: string) => Promise<ImEnrollChallenge>;
  onApprove: (deviceId: string, pairingCode: string) => Promise<void>;
  onRevoke: (deviceId: string) => Promise<void>;
  onCancel?: ((deviceId: string) => Promise<void>) | undefined;
}

const STATUS_LABEL = {
  pending: "im.devices.status.pending",
  active: "im.devices.status.active",
  revoked: "im.devices.status.revoked",
} as const;

export function ImDevices(props: ImDevicesProps): JSX.Element {
  const { t } = useText();
  const [name, setName] = createSignal("");
  const [publicKey, setPublicKey] = createSignal("");
  const [registeredKey, setRegisteredKey] = createSignal("");
  const [challenge, setChallenge] = createSignal<ImEnrollChallenge | null>(null);
  const [codes, setCodes] = createSignal<Record<string, string>>({});
  const [failure, setFailure] = createSignal<ImPairingFailure | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());

  createEffect(challenge, (pending) => {
    if (!pending) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  });

  async function enroll(): Promise<void> {
    const deviceName = name().trim();
    const key = publicKey().trim();
    if (deviceName === "" || key === "" || busy()) return;
    setBusy(true);
    setFailure(null);
    try {
      setRegisteredKey(key);
      setChallenge(await props.onEnroll(deviceName, key));
      setName("");
      setPublicKey("");
      setNow(Date.now());
    } finally {
      setBusy(false);
    }
  }

  async function approve(deviceId: string, pairingCode: string): Promise<void> {
    if (busy()) return;
    setBusy(true);
    setFailure(null);
    try {
      await props.onApprove(deviceId, pairingCode);
      setChallenge(null);
      setCodes((current) => ({ ...current, [deviceId]: "" }));
    } catch (error) {
      setFailure(imPairingFailure(error));
    } finally {
      setBusy(false);
    }
  }

  async function cancelEnroll(): Promise<void> {
    const pending = challenge();
    if (!pending || !props.onCancel || busy()) return;
    setBusy(true);
    try {
      await props.onCancel(pending.deviceId);
      setChallenge(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="im-devices">
      <h2 class="im-devices-title">{t("im.devices.title")}</h2>
      <form
        class="im-devices-form"
        onSubmit={(event) => {
          event.preventDefault();
          void enroll();
        }}
      >
        <Input
          size="sm"
          aria-label={t("im.devices.name")}
          placeholder={t("im.devices.name")}
          value={name()}
          onValueChange={setName}
        />
        <Input
          size="sm"
          aria-label={t("im.devices.publicKey")}
          placeholder={t("im.devices.publicKey")}
          value={publicKey()}
          onValueChange={setPublicKey}
        />
        <Button type="submit" size="sm" disabled={name().trim() === "" || publicKey().trim() === "" || busy()}>
          {t("im.devices.enroll")}
        </Button>
      </form>
      <Show when={challenge()}>
        {(pending) => (
          <div class="im-devices-challenge">
            <p class="im-devices-pairing">
              {t("im.devices.pairingCode")} <strong>{pending().pairingCode}</strong>
            </p>
            <Show
              when={!imPairingExpired(pending().expiresAt, now())}
              fallback={<p class="im-devices-expired">{t("im.devices.expired")}</p>}
            >
              <p class="im-devices-expiry">
                {t("im.devices.expiresIn", { time: imPairingCountdown(pending().expiresAt, now()) })}
              </p>
            </Show>
            <p class="im-devices-key">
              {t("im.devices.registeredKey")} <strong>{registeredKey()}</strong>
            </p>
            <Show when={pending().devicePublicKey}>
              {(key) => (
                <p class="im-devices-key">
                  {t("im.devices.echoedKey")} <strong>{key()}</strong>
                </p>
              )}
            </Show>
            <p class="im-devices-fingerprint">
              {t("im.devices.fingerprint")} <strong>{imFingerprintText(pending().fingerprint)}</strong>
            </p>
            <Show when={pending().algorithm}>
              {(algorithm) => (
                <p class="im-devices-key">
                  {t("im.devices.algorithm")} <strong>{algorithm()}</strong>
                </p>
              )}
            </Show>
            <Show when={failure()}>
              {(value) => <p class="im-devices-expired">{t(IM_PAIRING_FAILURE_LABEL[value()])}</p>}
            </Show>
            <Button
              type="button"
              size="sm"
              disabled={busy() || imPairingExpired(pending().expiresAt, now())}
              onClick={() => void approve(pending().deviceId, pending().pairingCode)}
            >
              {t("im.devices.approve")}
            </Button>
            <Show when={props.onCancel !== undefined}>
              <Button type="button" size="sm" variant="secondary" disabled={busy()} onClick={() => void cancelEnroll()}>
                {t("im.devices.cancel")}
              </Button>
            </Show>
          </div>
        )}
      </Show>
      <ul class="im-devices-list">
        <Show when={props.devices.length > 0} fallback={<p class="im-devices-empty">{t("im.devices.empty")}</p>}>
          <For each={props.devices}>
            {(device) => (
              <li class="im-device" data-status={device.status}>
                <span class="im-device-id">{device.deviceId}</span>
                <span class="im-device-status">{t(STATUS_LABEL[device.status])}</span>
                <Show when={device.fingerprint}>
                  {(value) => (
                    <span class="im-device-fingerprint">
                      {t("im.devices.fingerprint")} {imFingerprintText(value())}
                    </span>
                  )}
                </Show>
                <Show when={device.algorithm}>
                  {(value) => (
                    <span class="im-device-fingerprint">
                      {t("im.devices.algorithm")} {value()}
                    </span>
                  )}
                </Show>
                <Show when={device.status === "pending"}>
                  <Input
                    size="sm"
                    aria-label={t("im.devices.pairingCode")}
                    placeholder={t("im.devices.pairingCode")}
                    value={codes()[device.deviceId] ?? ""}
                    onValueChange={(text) => setCodes((current) => ({ ...current, [device.deviceId]: text }))}
                  />
                  <Button
                    type="button"
                    size="xs"
                    disabled={busy() || (codes()[device.deviceId] ?? "").trim() === ""}
                    onClick={() => void approve(device.deviceId, (codes()[device.deviceId] ?? "").trim())}
                  >
                    {t("im.devices.approve")}
                  </Button>
                </Show>
                <Show when={device.status === "active"}>
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    disabled={busy()}
                    onClick={() => void props.onRevoke(device.deviceId)}
                  >
                    {t("im.devices.revoke")}
                  </Button>
                </Show>
              </li>
            )}
          </For>
        </Show>
      </ul>
    </section>
  );
}
