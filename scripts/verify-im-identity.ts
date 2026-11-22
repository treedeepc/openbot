import {
  createImIdentity,
  ImDeviceRegistry,
  imFingerprint,
  issueDeviceCertificate,
  revokedDeviceCertificate,
  verifyDeviceCertificate,
} from "../src/backend/im/identity";
import { text } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = createImIdentity();
check(
  "Ed25519 根身份生成",
  root.publicKey.length === 64 && root.privateKey.length === 64,
  `pub=${root.publicKey.slice(0, 12)}…`,
);

const other = createImIdentity();
check("两次生成的根身份不同", root.publicKey !== other.publicKey, "");

const print1 = imFingerprint(root.publicKey);
const print2 = imFingerprint(root.publicKey);
check("指纹短语稳定可核对", print1 === print2 && print1.split(" ").length === 8, print1);
check("不同身份指纹不同", imFingerprint(other.publicKey) !== print1, "");

const now = 1_700_000_000_000;
const deviceKey = createImIdentity();
const cert = issueDeviceCertificate(root, {
  deviceId: "device-a",
  publicKey: deviceKey.publicKey,
  issuedAt: now,
  expiresAt: now + 86_400_000,
});
check("设备证书签发", cert.signature.length === 128 && cert.deviceId === "device-a", cert.deviceId);
check("证书链验证通过", verifyDeviceCertificate(cert, now + 1_000, root.publicKey) === true, "");
check("过期证书验证失败", verifyDeviceCertificate(cert, now + 86_400_001, root.publicKey) === false, "");

const forged = { ...cert, deviceId: "device-b" };
check("篡改设备号后验证失败", verifyDeviceCertificate(forged, now + 1_000, root.publicKey) === false, "");
const foreign = issueDeviceCertificate(other, {
  deviceId: "device-a",
  publicKey: deviceKey.publicKey,
  issuedAt: now,
  expiresAt: now + 86_400_000,
});
check("他根签发的证书验证失败", verifyDeviceCertificate(foreign, now + 1_000, root.publicKey) === false, "");

const revokedCert = revokedDeviceCertificate(cert);
check("撤销后证书立即失效", verifyDeviceCertificate(revokedCert, now + 1_000, root.publicKey) === false, "");

const registry = new ImDeviceRegistry(root);
const begun = registry.enrollBegin({
  localServerId: "srv-1",
  localMemberId: "me",
  deviceId: "device-c",
  publicKey: deviceKey.publicKey,
  now,
  ttlMs: 900_000,
});
check("五步入网 1 入网：待批准", begun.status === "pending" && begun.cert === null, begun.status);
check("五步入网 2 状态查询", registry.enrollStatus("device-c") === "pending", registry.enrollStatus("device-c"));

let pendingRefused = false;
const wrongCode = begun.pairingCode === "0000-0000" ? "1111-1111" : "0000-0000";
try {
  registry.enrollApprove({ deviceId: "device-c", pairingCode: wrongCode, now: now + 1_000, ttlMs: 86_400_000 });
} catch (error) {
  pendingRefused = error instanceof Error && error.name === "ImPairingExpired";
}
check("配对码不符拒绝批准", pendingRefused, "");

const approved = registry.enrollApprove({
  deviceId: "device-c",
  pairingCode: text(begun.pairingCode),
  now: now + 1_000,
  ttlMs: 86_400_000,
});
check("五步入网 3 批准：已启用且带证书", approved.status === "active" && approved.cert !== null, approved.status);
check("五步入网 4 状态查询", registry.enrollStatus("device-c") === "active", "");
check("启用设备可验真", registry.verifyDevice("device-c", now + 2_000) === true, "");
check(
  "活跃设备列表含该设备",
  registry.activeDevices().some((record) => record.deviceId === "device-c"),
  "",
);

const revoked = registry.revoke("device-c", now + 3_000);
check("五步入网 5 撤销", revoked.status === "revoked" && revoked.revokedAt === now + 3_000, revoked.status);
check("撤销后状态查询", registry.enrollStatus("device-c") === "revoked", "");
check("撤销后验证失败", registry.verifyDevice("device-c", now + 4_000) === false, "");
check("撤销后不在活跃列表", registry.activeDevices().some((record) => record.deviceId === "device-c") === false, "");
check(
  "撤销后证书失效",
  revoked.cert ? verifyDeviceCertificate(revoked.cert, now + 4_000, root.publicKey) === false : true,
  "",
);

const second = createImIdentity();
registry.enrollBegin({
  localServerId: "srv-1",
  localMemberId: "me",
  deviceId: "device-d",
  publicKey: second.publicKey,
  now: now + 5_000,
  ttlMs: 900_000,
});
registry.enrollCancel("device-d");
let unknown = false;
try {
  registry.enrollStatus("device-d");
} catch (error) {
  unknown = error instanceof Error && error.name === "ImDeviceUnknown";
}
check("取消入网后设备不存在", unknown, "");
check("未批准设备不被验真", registry.verifyDevice("device-d", now + 6_000) === false, "");

const expired = new ImDeviceRegistry(root);
expired.enrollBegin({
  localServerId: "srv-1",
  localMemberId: "me",
  deviceId: "device-e",
  publicKey: second.publicKey,
  now,
  ttlMs: 1_000,
});
let expiredRefused = false;
try {
  expired.enrollApprove({ deviceId: "device-e", pairingCode: "1111-1111", now: now + 2_000, ttlMs: 86_400_000 });
} catch (error) {
  expiredRefused = error instanceof Error && error.name === "ImPairingExpired";
}
check("配对码过期拒绝批准", expiredRefused, "");

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
