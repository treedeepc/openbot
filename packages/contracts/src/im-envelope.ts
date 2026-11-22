import { type HostGrantKind, openHostGrant, sealHostGrant } from "./host-grant";
import { ImProtocolError } from "./ipc-im";
import { isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

export const IM_ENVELOPE_VERSION = 1;
export const IM_ENVELOPE_KIND: HostGrantKind = { version: IM_ENVELOPE_VERSION, info: "openbot-im-envelope-v1" };

export const IM_ENVELOPE_PAYLOAD_KINDS = ["message", "ack", "read", "presence", "enroll"] as const;
export type ImEnvelopePayloadKind = (typeof IM_ENVELOPE_PAYLOAD_KINDS)[number];

export interface ImEnvelopePayload {
  kind: ImEnvelopePayloadKind;
  remoteMessageId: string;
  body: string;
  sentAt: number;
  deviceId: string | null;
  causalChainId: string | null;
}

export interface SealedDeviceEnvelope {
  deviceId: string;
  publicKey: string;
  sealed: string;
}

function invalidEnvelope(): never {
  throw new ImProtocolError("IM envelope");
}

function decodeEnvelopePayload(value: unknown): ImEnvelopePayload {
  if (!isDynamicRecord(value)) invalidEnvelope();
  const allowed = ["kind", "remoteMessageId", "body", "sentAt", "deviceId", "causalChainId"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalidEnvelope();
  if (!isOneOf(IM_ENVELOPE_PAYLOAD_KINDS, value.kind)) invalidEnvelope();
  if (!isString(value.remoteMessageId) || value.remoteMessageId.length === 0 || value.remoteMessageId.length > 64)
    invalidEnvelope();
  if (!isString(value.body) || value.body.length > 8_000) invalidEnvelope();
  if (!isNumber(value.sentAt) || !Number.isFinite(value.sentAt)) invalidEnvelope();
  if (value.deviceId !== null && !isString(value.deviceId)) invalidEnvelope();
  if (value.causalChainId !== null && !isString(value.causalChainId)) invalidEnvelope();
  return {
    kind: value.kind,
    remoteMessageId: value.remoteMessageId,
    body: value.body,
    sentAt: value.sentAt,
    deviceId: value.deviceId ?? null,
    causalChainId: value.causalChainId ?? null,
  };
}

export function imEnvelopeNonce(chainId: string, deviceId: string): string {
  return `openbot-im-envelope-v1:${chainId}:${deviceId}`;
}

export async function sealImEnvelope(
  recipientDevicePublicKey: string,
  nonce: string,
  payload: ImEnvelopePayload,
): Promise<string> {
  return sealHostGrant(IM_ENVELOPE_KIND, recipientDevicePublicKey, nonce, payload);
}

export async function openImEnvelope(
  recipientDevicePrivateKey: CryptoKey,
  nonce: string,
  sealed: string,
): Promise<ImEnvelopePayload> {
  return openHostGrant(IM_ENVELOPE_KIND, recipientDevicePrivateKey, nonce, sealed, decodeEnvelopePayload);
}

export async function sealImEnvelopeForDevices(
  devices: readonly { deviceId: string; publicKey: string }[],
  nonce: string,
  payload: ImEnvelopePayload,
): Promise<SealedDeviceEnvelope[]> {
  const sealed: SealedDeviceEnvelope[] = [];
  for (const device of devices)
    sealed.push({ ...device, sealed: await sealImEnvelope(device.publicKey, nonce, payload) });
  return sealed;
}

export function isImEnvelopePayload(value: unknown): value is ImEnvelopePayload {
  try {
    decodeEnvelopePayload(value);
    return true;
  } catch {
    return false;
  }
}
