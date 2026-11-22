import type { ImDevice } from "@openbot/contracts/ipc";
import { ImDevices, type ImEnrollChallenge } from "@openbot/ui/features/im/ImDevices";
import { createSignal, onSettled } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createMockIm } from "../src/preview/mock-im";

const meta = {
  title: "IM/ImDevices",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = 1_700_000_000_000;

const SEED: ImDevice[] = [
  {
    deviceId: "device-macbook",
    publicKey: "ed25519:2b9f…c41a",
    status: "active",
    enrolledAt: NOW - 86_400_000,
    certExpiresAt: NOW + 89 * 86_400_000,
  },
  {
    deviceId: "device-phone",
    publicKey: "ed25519:91de…07b2",
    status: "pending",
    enrolledAt: null,
    certExpiresAt: null,
  },
];

function ImDevicesStory(props: { expiresInMs?: number | undefined }) {
  const mock = createMockIm({ devices: SEED });
  const [devices, setDevices] = createSignal<ImDevice[]>(SEED);
  onSettled(() => {
    void mock.devices.list().then((page) => setDevices(page.items));
  });
  return (
    <ImDevices
      devices={devices()}
      onEnroll={async (deviceName: string, publicKey: string): Promise<ImEnrollChallenge> => {
        const challenge = await mock.devices.enrollBegin(deviceName, publicKey);
        await mock.devices.list().then((page) => setDevices(page.items));
        return props.expiresInMs === undefined
          ? challenge
          : { ...challenge, expiresAt: Date.now() + props.expiresInMs };
      }}
      onApprove={async (deviceId: string, pairingCode: string) => {
        await mock.devices.enrollApprove(deviceId, pairingCode);
        await mock.devices.list().then((page) => setDevices(page.items));
      }}
      onRevoke={async (deviceId: string) => {
        await mock.devices.revoke(deviceId);
        await mock.devices.list().then((page) => setDevices(page.items));
      }}
      onCancel={async (deviceId: string) => {
        await mock.devices.enrollCancel(deviceId);
        await mock.devices.list().then((page) => setDevices(page.items));
      }}
    />
  );
}

export const Default: Story = {
  render: () => <ImDevicesStory />,
};

export const Expired: Story = {
  render: () => <ImDevicesStory expiresInMs={2_000} />,
};
