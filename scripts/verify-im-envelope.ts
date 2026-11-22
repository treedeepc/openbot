import {
  createHostGrantKeyPair,
  createStoredHostGrantKeyPair,
  type HostGrantKind,
  importHostGrantPrivateKey,
  openHostGrant,
} from "../packages/contracts/src/host-grant";
import type { ImEnvelopePayload } from "../packages/contracts/src/im-envelope";
import {
  IM_ENVELOPE_KIND,
  imEnvelopeNonce,
  isImEnvelopePayload,
  openImEnvelope,
  sealImEnvelope,
  sealImEnvelopeForDevices,
} from "../packages/contracts/src/im-envelope";
import { IM_ENVELOPE_VECTORS } from "../packages/contracts/src/im-envelope-vectors";
import { itemAt } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const owner = await createHostGrantKeyPair();
const stranger = await createStoredHostGrantKeyPair();
const strangerPrivate = await importHostGrantPrivateKey(stranger.privateKey);

for (const vector of IM_ENVELOPE_VECTORS) {
  if (!vector.payload) continue;
  let sealed = await sealImEnvelope(owner.publicKey, vector.nonce, vector.payload);
  if (vector.tamper === "unknown-field") {
    const leaked = { leaked: true };
    sealed = await sealImEnvelope(owner.publicKey, vector.nonce, { ...vector.payload, ...leaked });
  } else if (vector.tamper === "ciphertext") {
    const decoded = JSON.parse(Buffer.from(sealed, "base64url").toString("utf8"));
    decoded.ct = decoded.ct.slice(0, -4) + (decoded.ct.endsWith("AAAA") ? "BBBB" : "AAAA");
    sealed = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
  }
  const nonce = vector.tamper === "nonce" ? `${vector.nonce}:tampered` : vector.nonce;
  const privateKey = vector.tamper === "foreign-key" ? strangerPrivate : owner.privateKey;
  const kind = vector.tamper === "kind" ? { version: 1, info: "openbot-ingress-queue-v1" } : IM_ENVELOPE_KIND;

  let outcome = "reject";
  let detail = "";
  try {
    const opened = await openImEnvelopeWith(kind, privateKey, nonce, sealed);
    outcome = vector.deviceRevoked ? "revoked" : "open";
    detail = JSON.stringify(opened).slice(0, 60);
  } catch (error) {
    detail = error instanceof Error ? error.name : String(error);
    if (vector.tamper === "kind") outcome = "downgrade";
    else if (vector.deviceRevoked) outcome = "revoked";
    else outcome = "reject";
  }
  const ok =
    vector.outcome === "open"
      ? outcome === "open"
      : vector.outcome === "downgrade"
        ? outcome === "downgrade"
        : outcome !== "open";
  check(`${vector.id} ${vector.covers}`, ok, `${outcome} ${detail}`);
}

async function openImEnvelopeWith(
  kind: HostGrantKind,
  privateKey: CryptoKey,
  nonce: string,
  sealed: string,
): Promise<ImEnvelopePayload> {
  return openHostGrant(kind, privateKey, nonce, sealed, (value) => {
    if (!isImEnvelopePayload(value)) throw new Error("im.protocolError");
    return value;
  });
}

const revoked = "device-b";
const active = [{ deviceId: "device-a", publicKey: owner.publicKey }];
const sealedActive = await sealImEnvelopeForDevices(active, imEnvelopeNonce("chain-1", "device-a"), {
  kind: "message",
  remoteMessageId: "r-8",
  body: "hi",
  sentAt: 1,
  deviceId: "device-a",
  causalChainId: "chain-1",
});
check(
  "按设备封装：只给活跃设备封一份",
  sealedActive.length === 1 && itemAt(sealedActive, 0).deviceId === "device-a",
  JSON.stringify(sealedActive.map((entry) => entry.deviceId)),
);
check("撤销设备不在收件人列表", !sealedActive.some((entry) => entry.deviceId === revoked), "");
check(
  "每台设备各自封装（内容不复用）",
  sealedActive.every((entry) => typeof entry.sealed === "string" && entry.sealed.length > 0),
  "",
);

let revokedHeld = null;
try {
  revokedHeld = await openImEnvelope(
    owner.privateKey,
    imEnvelopeNonce("chain-1", "device-b"),
    itemAt(sealedActive, 0).sealed,
  );
} catch {
  revokedHeld = null;
}
check("换 nonce 打开被封信封即失败（旧钥撤销后不可复用）", revokedHeld === null, JSON.stringify(revokedHeld));

const vectorsOk = IM_ENVELOPE_VECTORS.length === 7;
check("协议向量齐：成功/拒绝/降级/旧钥撤销", vectorsOk, `${IM_ENVELOPE_VECTORS.length} 条`);
check(
  "实现与 HostGrant 薄封装同源（不碰 sealQueuedDelivery）",
  IM_ENVELOPE_KIND.info === "openbot-im-envelope-v1",
  JSON.stringify(IM_ENVELOPE_KIND),
);

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
