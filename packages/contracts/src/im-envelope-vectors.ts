import type { ImEnvelopePayload } from "./im-envelope";

export type ImEnvelopeVectorOutcome = "open" | "reject" | "downgrade" | "revoked";

export interface ImEnvelopeVector {
  id: string;
  covers: string;
  outcome: ImEnvelopeVectorOutcome;
  payload: ImEnvelopePayload | null;
  nonce: string;
  tamper: "none" | "kind" | "unknown-field" | "ciphertext" | "nonce" | "foreign-key";
  deviceRevoked: boolean;
}

export const IM_ENVELOPE_VECTORS: readonly ImEnvelopeVector[] = [
  {
    id: "IMV-01",
    covers: "成功：合法信封按设备公钥封装并解封",
    outcome: "open",
    payload: {
      kind: "message",
      remoteMessageId: "r-1",
      body: "hello",
      sentAt: 1,
      deviceId: "device-a",
      causalChainId: "chain-1",
    },
    nonce: "openbot-im-envelope-v1:chain-1:device-a",
    tamper: "none",
    deviceRevoked: false,
  },
  {
    id: "IMV-02",
    covers: "拒绝：payload 带未知字段整体拒（fail-closed）",
    outcome: "reject",
    payload: {
      kind: "message",
      remoteMessageId: "r-2",
      body: "hello",
      sentAt: 1,
      deviceId: "device-a",
      causalChainId: "chain-1",
    },
    nonce: "openbot-im-envelope-v1:chain-1:device-a",
    tamper: "unknown-field",
    deviceRevoked: false,
  },
  {
    id: "IMV-03",
    covers: "拒绝：AAD（nonce）被换即解不开",
    outcome: "reject",
    payload: {
      kind: "ack",
      remoteMessageId: "r-3",
      body: "",
      sentAt: 1,
      deviceId: "device-a",
      causalChainId: "chain-1",
    },
    nonce: "openbot-im-envelope-v1:chain-1:device-a",
    tamper: "nonce",
    deviceRevoked: false,
  },
  {
    id: "IMV-04",
    covers: "拒绝：密文被篡改",
    outcome: "reject",
    payload: {
      kind: "message",
      remoteMessageId: "r-4",
      body: "hello",
      sentAt: 1,
      deviceId: "device-a",
      causalChainId: "chain-1",
    },
    nonce: "openbot-im-envelope-v1:chain-1:device-a",
    tamper: "ciphertext",
    deviceRevoked: false,
  },
  {
    id: "IMV-05",
    covers: "拒绝：非本机密钥解不开",
    outcome: "reject",
    payload: {
      kind: "message",
      remoteMessageId: "r-5",
      body: "hello",
      sentAt: 1,
      deviceId: "device-a",
      causalChainId: "chain-1",
    },
    nonce: "openbot-im-envelope-v1:chain-1:device-a",
    tamper: "foreign-key",
    deviceRevoked: false,
  },
  {
    id: "IMV-06",
    covers: "降级：他种 HostGrantKind（不同 info）解不开，防降级复用",
    outcome: "downgrade",
    payload: {
      kind: "message",
      remoteMessageId: "r-6",
      body: "hello",
      sentAt: 1,
      deviceId: "device-a",
      causalChainId: "chain-1",
    },
    nonce: "openbot-im-envelope-v1:chain-1:device-a",
    tamper: "kind",
    deviceRevoked: false,
  },
  {
    id: "IMV-07",
    covers: "旧钥撤销：撤销设备不在收件人里，且其持有的信封被拒",
    outcome: "revoked",
    payload: {
      kind: "message",
      remoteMessageId: "r-7",
      body: "hello",
      sentAt: 1,
      deviceId: "device-b",
      causalChainId: "chain-1",
    },
    nonce: "openbot-im-envelope-v1:chain-1:device-b",
    tamper: "none",
    deviceRevoked: true,
  },
];
