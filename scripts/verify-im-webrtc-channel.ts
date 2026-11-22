import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createImIdentity, imFingerprint } from "../src/backend/im/identity";
import { ImLanDiscovery } from "../src/backend/im/lan";
import {
  IM_LAN_CHANNEL_LABEL,
  ImLanChannel,
  ImLanChannelRefused,
  type ImSignalMessage,
} from "../src/backend/im/lan-channel";
import { decodeImWireFrame, type ImWireFrame } from "../src/backend/im/wire";
import { maybeAt } from "./verify-im-helpers";

const REPO = resolve(import.meta.dirname, "..");
const require_ = createRequire(`${REPO}/package.json`);
const wrtc = require_("@roamhq/wrtc");

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const factory = (iceServers: unknown[]) => new wrtc.RTCPeerConnection({ iceServers });
const identity = createImIdentity();
const fingerprint = imFingerprint(identity.publicKey);

const responder = {
  announce: () => {},
  browse: (onPeer: (peer: { host: string; port: number; txt: Record<string, string> }) => void) => {
    onPeer({
      host: "127.0.0.1",
      port: 47821,
      txt: { peerServerId: "srv-2", peerAgentId: "agent-peer", publicKey: identity.publicKey },
    });
  },
  stop: () => {},
};
const lan = new ImLanDiscovery({ responder, turn: null });
lan.browse();
const peer = lan.verify({ peerServerId: "srv-2", peerAgentId: "agent-peer" }, fingerprint);
check("前置：发现→指纹核对→trusted", peer.trusted === true, "");

const signalsA: ImSignalMessage[] = [];
const signalsB: ImSignalMessage[] = [];
const framesB: ImWireFrame[] = [];
const framesA: ImWireFrame[] = [];

const turn = { urls: ["turn:127.0.0.1:3478"], username: "u", credential: "p" };
const channelA = new ImLanChannel({
  peer,
  fingerprint,
  turn: null,
  factory,
  onSignal: (signal) => signalsA.push(signal),
  onFrame: (frame) => {
    framesA.push(decodeImWireFrame(frame));
  },
});
const channelB = new ImLanChannel({
  peer: { ...peer, trusted: true },
  fingerprint,
  turn: null,
  factory,
  onSignal: (signal) => signalsB.push(signal),
  onFrame: (frame) => {
    framesB.push(decodeImWireFrame(frame));
  },
});

await channelA.open();
check(
  "T7 WebRTC：发起方发出 offer",
  signalsA.some((s) => s.kind === "offer"),
  "",
);
const offer = signalsA.find((s) => s.kind === "offer");
if (!offer) throw new Error("no offer");
await channelB.accept(offer);
const answer = signalsB.find((s) => s.kind === "answer");
check("T7 WebRTC：应答方回 answer", answer?.kind === "answer", "");

for (let round = 0; round < 40 && (channelA.state !== "open" || channelB.state !== "open"); round += 1) {
  for (const signal of signalsA.splice(0)) {
    if (signal.kind === "candidate") await channelB.accept(signal);
  }
  for (const signal of signalsB.splice(0)) {
    if (signal.kind === "candidate") await channelA.accept(signal);
  }
  if (answer && !signalsB.length) await channelA.accept(answer);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

check(
  "T7 WebRTC：双方数据通道打开",
  channelA.state === "open" && channelB.state === "open",
  `${channelA.state}/${channelB.state}`,
);
const sealed = {
  type: "forward",
  fromServerId: "srv-1",
  fromAgentId: "me",
  toServerId: "srv-2",
  toAgentId: "agent-peer",
  sealed: "ciphertext-over-webrtc",
  nonce: "n-webrtc",
  sentAt: 1,
};
channelA.send(sealed);
for (let round = 0; round < 20 && framesB.length === 0; round += 1)
  await new Promise((resolve) => setTimeout(resolve, 50));
check("T7 WebRTC：对端收到帧", framesB.length === 1, JSON.stringify(framesB));
check("T7 WebRTC：密文原样到达（通道不解密）", maybeAt(framesB, 0)?.sealed === "ciphertext-over-webrtc", "");
channelB.send({ ...sealed, sealed: "reply-ciphertext", nonce: "n-2" });
for (let round = 0; round < 20 && framesA.length === 0; round += 1)
  await new Promise((resolve) => setTimeout(resolve, 50));
check("T7 WebRTC：双向都通", maybeAt(framesA, 0)?.sealed === "reply-ciphertext", "");
check("T7 WebRTC：通道标签是约定值", IM_LAN_CHANNEL_LABEL === "openbot-im", IM_LAN_CHANNEL_LABEL);

const untrusted = { ...peer, trusted: false };
async function refused(name: string, run: () => Promise<void>, expected: string) {
  let code = "";
  try {
    await run();
  } catch (error) {
    code = error instanceof Error ? error.name : String(error);
  }
  check(name, code === expected, code || "没有报错");
}
await refused(
  "T7 连接必验指纹：未核对不能建链",
  () =>
    new ImLanChannel({
      peer: untrusted,
      fingerprint,
      factory,
      onSignal: () => {},
      onFrame: () => {},
    }).open(),
  "ImLanChannelRefused",
);
await refused(
  "T7 连接必验指纹：指纹不符不能建链",
  () =>
    new ImLanChannel({
      peer,
      fingerprint: "AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH",
      factory,
      onSignal: () => {},
      onFrame: () => {},
    }).open(),
  "ImLanChannelRefused",
);
const turnChannel = new ImLanChannel({
  peer,
  fingerprint,
  turn,
  factory,
  onSignal: () => {},
  onFrame: () => {},
});
check("T7 TURN 兜底：配置了 TURN 就走 turn 传输", turnChannel.transport === "turn", turnChannel.transport);
check(
  "T7 未开链时 send 拒",
  (() => {
    try {
      turnChannel.send({ type: "forward" });
      return false;
    } catch (error) {
      return error instanceof ImLanChannelRefused;
    }
  })(),
  "",
);

channelA.close();
channelB.close();
check("T7 关闭后通道不可用", channelA.state === "idle", channelA.state);

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed`);
if (failed.length > 0) process.exitCode = 1;
