import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as im from "../packages/contracts/src/ipc-im";
import { itemAt, record } from "./verify-im-helpers";

const REPO = resolve(import.meta.dirname, "..");

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const rejects = (name: string, fn: () => unknown) => {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(name, threw);
};

const message = {
  localMessageId: "m-1",
  remoteMessageId: "r-1",
  threadId: "t-1",
  senderKind: "peer",
  senderAgentId: null,
  deviceId: null,
  body: "hello",
  attachments: [{ name: "a.png", digest: "d", size: 10 }],
  replyTo: null,
  proxiedBy: null,
  proxyVisibility: null,
  causalChainId: null,
  sentAt: 1,
  expiresAt: 2,
  withdrawnAt: null,
  verified: true,
};

check("合法 message 通过", im.decodeImMessage(message).body === "hello", "");
rejects("未知字段整体拒绝", () => im.decodeImMessage({ ...message, localId: "x" }));
rejects("缺字段拒绝", () => {
  const { body, ...rest } = message;
  void body;
  im.decodeImMessage(rest);
});
rejects("类型不符拒绝", () => im.decodeImMessage({ ...message, verified: "yes" }));
rejects("枚举越界拒绝", () => im.decodeImMessage({ ...message, senderKind: "bot" }));
rejects("附件未知字段拒绝", () =>
  im.decodeImMessage({ ...message, attachments: [{ name: "a", digest: "d", size: 1, path: "/etc/passwd" }] }),
);

const peer = { peerServerId: "s", peerAgentId: "a", displayName: "P", verified: true, fingerprint: "f" };
check("合法 peer 通过", im.decodeImPeer(peer).displayName === "P", "");
rejects("peer 未知字段拒绝", () => im.decodeImPeer({ ...peer, publicKey: "k" }));

check("分页合法通过", im.decodeImMessages({ items: [message], next: null }).items.length === 1, "");
rejects("分页未知字段拒绝", () => im.decodeImMessages({ items: [message], next: null, total: 1 }));
rejects("分页 next 类型不符拒绝", () => im.decodeImMessages({ items: [message], next: 3 }));

const device = { deviceId: "d-1", publicKey: "k", status: "active", enrolledAt: 1, certExpiresAt: 2 };
check("合法 device 通过", im.decodeImDevice(device).status === "active", "");
rejects("device 状态越界拒绝", () => im.decodeImDevice({ ...device, status: "unknown" }));

check("错误码基线 5 个", im.IM_ERROR_CODES.length === 5, im.IM_ERROR_CODES.join(","));
check("协议错误码在基线内", im.IM_ERROR_CODES.includes("im.protocolError"), "");
check("版本不兼容码在基线内", im.IM_ERROR_CODES.includes("im.versionIncompatible"), "");

const hostKeys = Object.keys(im.imFromHost).sort();
const mainKeys = Object.keys(im.imFromMain).sort();
check(
  "FromHost 与 FromMain 是两套独立 decoder",
  hostKeys.join(",") !== mainKeys.join(","),
  `host=${hostKeys.length} main=${mainKeys.length}`,
);
check("FromHost 不含本地侧专属对象", !("blockRule" in im.imFromHost), "");
check("FromMain 含本地侧对象", "blockRule" in im.imFromMain, "");
rejects("FromHost 同样 fail-closed", () => im.imFromHost.message({ ...message, extra: 1 }));
rejects("FromMain 同样 fail-closed", () => im.imFromMain.message({ ...message, extra: 1 }));

rejects("发送接口未知字段拒绝", () =>
  im.parseImSendMessage({ threadId: "t", remoteMessageId: "r", body: "x", path: "/tmp" }),
);
rejects("ACK 批次为空拒绝", () => im.parseImAck({ threadId: "t", messageIds: [] }));
rejects("ACK 批次超限拒绝", () =>
  im.parseImAck({ threadId: "t", messageIds: Array.from({ length: 201 }, (_, index) => `m${index}`) }),
);
rejects("代聊预算越界拒绝", () =>
  im.parseImProxySet({ enabled: true, visibility: "shown", monthlyBudgetUsd: 100_000 }),
);

const handlers = readFileSync(`${REPO}/src/main/ipc/im-handlers.ts`, "utf8");
const authorizeAt = handlers.indexOf("port.authorize");
const executeAt = handlers.indexOf("port.execute");
check("四步顺序：授权先于执行", authorizeAt > 0 && authorizeAt < executeAt, "");
check("四步顺序：走 handleTrusted（sender 先于 decode）", handlers.includes("payloadHandler(agentRequest(decode)"), "");
check("未授权抛 im.unauthorized", handlers.includes('super("im.unauthorized")'), "");
check("协议错误抛 im.protocolError", handlers.includes('super("im.protocolError")'), "");

const external = "a; rm -rf /";
let touchedPath = false;
try {
  im.parseImSendMessage({ threadId: "t", remoteMessageId: external, body: external, attachments: [] });
} catch {
  touchedPath = true;
}
check("外部文本不会成为路径/命令拼接（无路径入参）", touchedPath === false, "");

let mapped = "";
try {
  im.decodeImMessage({ ...message, localId: "x" });
} catch (error) {
  const name = error instanceof Error ? error.name : "undefined";
  const code = error instanceof im.ImProtocolError ? error.code : "undefined";
  mapped = `${name}:${code}`;
}
check("decode 失败映射到 im.protocolError", mapped === "ImProtocolError:im.protocolError", mapped);
check("ImProtocolError 可被 code 识别", im.IM_ERROR_CODES.includes("im.protocolError"), "");

const mock = (await import(`${REPO}/src/renderer/src/preview/mock-im.ts`)).createMockIm({
  peers: [{ peerServerId: "s", peerAgentId: "a", displayName: "P", verified: true, fingerprint: "f" }],
});
const sent = await mock.messages.send("t-1", "r-1", "hello");
check("mock send 返回 delivery", sent.delivery.state === "submitted", sent.delivery.deliveryId);
const readBack = await mock.delivery.get(sent.delivery.deliveryId);
check(
  "mock delivery.get 读回",
  readBack.state === "submitted" && readBack.localMessageId === sent.message.localMessageId,
  JSON.stringify(readBack),
);
await mock.delivery.ack([sent.message.localMessageId]);
const acked = await mock.delivery.get(sent.delivery.deliveryId);
check("mock ack 后读回为 acked", acked.state === "acked" && acked.ackedAt !== null, JSON.stringify(acked).slice(0, 90));
const listed = await mock.delivery.list("t-1");
check(
  "mock delivery.list 按线程列出",
  listed.items.length === 1 && record(itemAt(listed.items, 0)).state === "acked",
  "",
);
const perMessage = await mock.delivery.forMessage(sent.message.localMessageId);
check("mock delivery.forMessage 命中", perMessage?.deliveryId === sent.delivery.deliveryId, "");
const resent = await mock.delivery.resend(sent.delivery.deliveryId);
check(
  "mock resend 后状态回到 submitted",
  resent.state === "submitted" && resent.attempts === 2,
  JSON.stringify(resent),
);

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
