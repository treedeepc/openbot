import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createStoredHostGrantKeyPair } from "../packages/contracts/src/host-grant";
import { itemAt } from "./verify-im-helpers";

const REPO = resolve(import.meta.dirname, "..");
const BUNDLE = resolve(REPO, ".openbot-build/im-lan-peer.mjs");

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
};

function bundle(): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(
      "bun",
      [
        "build",
        "scripts/im-lan-peer.ts",
        "--target=node",
        "--format=esm",
        "--external:@roamhq/wrtc",
        "--external:multicast-dns",
        `--outfile=${BUNDLE}`,
      ],
      { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(out))));
  });
}

function peer(
  serverId: string,
  agentId: string,
  otherServerId: string,
  otherAgentId: string,
  mode: string,
  deviceKey: string,
  peerDeviceKey: string,
  privateKey: string,
  verifyMode = "verify",
): { ready: Promise<number>; done: Promise<{ ok: boolean; [key: string]: unknown }> } {
  const child = spawn("node", [BUNDLE, serverId, agentId, otherServerId, otherAgentId, mode, verifyMode], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      IM_DEVICE_KEY: deviceKey,
      IM_PEER_DEVICE_KEY: peerDeviceKey,
      IM_DEVICE_PRIVATE_KEY: privateKey,
    },
  });
  let out = "";
  let err = "";
  let markReady = (port: number): void => {
    void port;
  };
  const ready = new Promise<number>((resolvePort) => {
    markReady = resolvePort;
  });
  const done = new Promise<{ ok: boolean; [key: string]: unknown }>((resolveResult) => {
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      const line = /^ready (\d+)$/mu.exec(out);
      if (line) markReady(Number(itemAt(line, 1)));
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("exit", () => {
      const last = out.trim().split("\n").at(-1) ?? "";
      try {
        resolveResult(JSON.parse(last));
      } catch {
        resolveResult({ ok: false, stage: "exit", out: last.slice(0, 200), err: err.slice(0, 200) });
      }
    });
    setTimeout(() => child.kill(), 60_000);
  });
  return { ready, done };
}

await bundle();
const keyA = await createStoredHostGrantKeyPair();
const keyB = await createStoredHostGrantKeyPair();
const sender = peer("srv-a", "agent-a", "srv-b", "agent-b", "send", keyA.publicKey, keyB.publicKey, keyA.privateKey);
const receiver = peer(
  "srv-b",
  "agent-b",
  "srv-a",
  "agent-a",
  "receive",
  keyB.publicKey,
  keyA.publicKey,
  keyB.privateKey,
);
const [senderPort, receiverPort] = await Promise.all([sender.ready, receiver.ready]);
const [senderResult, receiverResult] = await Promise.all([sender.done, receiver.done]);

check("两进程各自起栈并监听信令端口", senderPort > 0 && receiverPort > 0, `${senderPort}/${receiverPort}`);
check("发现层互见（真 mDNS）", Number(senderResult.discovered ?? 0) > 0, JSON.stringify(senderResult));
check(
  "WebRTC 通道建起来（真 wrtc）",
  senderResult.ok === true && receiverResult.ok === true,
  JSON.stringify({ senderResult, receiverResult }),
);
check("真互发：A 发出的帧进了 B 的队列（密文落地）", receiverResult.queued === 1, JSON.stringify(receiverResult));
check("对称：A 侧也完成投递", senderResult.sent === true, JSON.stringify(senderResult));
check(
  "封包可证：B 用自己私钥解开了 A 的封包（走的是 sealImEnvelope 路径）",
  receiverResult.openedBody === "hello-from-agent-a",
  JSON.stringify(receiverResult.openedBody),
);
check(
  "封包可证：落地密文不等于明文（不是裸传）",
  receiverResult.sealedText !== receiverResult.openedBody && receiverResult.sealedText !== receiverResult.sentBody,
  JSON.stringify(receiverResult.sealedText),
);
check(
  "互收逐字比对：B 解出的正文与 A 发送的正文逐字一致",
  receiverResult.openedBody === senderResult.sentBody,
  JSON.stringify({ sent: senderResult.sentBody, got: receiverResult.openedBody }),
);
check(
  "回看读回一致：队列行存业务 id 而非 nonce / 对端 / 设备号都对得上",
  receiverResult.remoteMessageId === "rm-agent-a" &&
    receiverResult.queuePeer === "srv-a/agent-a" &&
    receiverResult.queueDevice === "device-agent-b",
  JSON.stringify(receiverResult),
);

const keyC = await createStoredHostGrantKeyPair();
const keyD = await createStoredHostGrantKeyPair();
const blind = peer(
  "srv-c",
  "agent-c",
  "srv-d",
  "agent-d",
  "send",
  keyC.publicKey,
  keyD.publicKey,
  keyC.privateKey,
  "noverify",
);
await blind.ready;
const blindResult = await blind.done;
check(
  "对照：不核对指纹就建不了链、也发不出去",
  blindResult.channelState !== "open" && blindResult.ok !== true,
  JSON.stringify(blindResult),
);

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
for (const entry of failed) process.stdout.write(`FAIL  ${entry.name}\n`);
if (failed.length > 0) process.exitCode = 1;
