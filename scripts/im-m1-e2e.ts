import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { plugin } from "bun";
import { createHostGrantKeyPair, sealHostGrant } from "../packages/contracts/src/host-grant";
import {
  IM_ENVELOPE_KIND,
  type ImEnvelopePayload,
  imEnvelopeNonce,
  openImEnvelope,
  sealImEnvelope,
  sealImEnvelopeForDevices,
} from "../packages/contracts/src/im-envelope";
import {
  decodeImDelivery,
  decodeImMessage,
  decodeImMessages,
  IM_ERROR_CODES,
  IM_LIMITS,
  IM_SPECIFIC_ERROR_CODES,
  type ImDelivery,
  type ImDevice,
  type ImMessage,
  ImProtocolError,
  imFromHost,
  imFromMain,
  parseImAck,
  parseImProxySet,
  parseImSendMessage,
} from "../packages/contracts/src/ipc-im";
import { ImAuditLog } from "../src/backend/im/audit";
import { ImDeviceStore } from "../src/backend/im/device-store";
import { ImHostApi } from "../src/backend/im/host-api";
import {
  createImIdentity,
  ImDeviceRegistry,
  imFingerprint,
  issueDeviceCertificate,
  verifyDeviceCertificate,
} from "../src/backend/im/identity";
import { ImService } from "../src/backend/im/im-service";
import { IM_LAN_PEER_OFFLINE, ImLanOutbox } from "../src/backend/im/lan-outbox";
import { ImMessageStore, type ImStoredMessage } from "../src/backend/im/messages";
import { ImWithdrawService } from "../src/backend/im/withdraw";
import {
  actualRows,
  buildDatabaseAtVersion,
  buildReleasedDatabase,
  expectedRowsAfterUpgrade,
  HARNESS_APPLIED_AT,
  healthProblems,
  latestAppliedVersion,
  openHarnessDatabase,
  query,
  readAppliedVersions,
  readNormalizedDeclarations,
  readTableRows,
  readTableShapes,
  releasedDatabaseCases,
  seedEveryTable,
  sortedRows,
} from "../src/backend/migration-harness";
import { IM_TABLES_AFTER_MIGRATION, migration as imMigration } from "../src/backend/migrations/0068-im";
import {
  LATEST_SCHEMA_VERSION,
  migrateOpenBotDatabase,
  openBotDatabaseNeedsMigration,
} from "../src/backend/openbot-database-schema";
import { createMockIm } from "../src/renderer/src/preview/mock-im";
import { type ImCaseTools, ImGate } from "./im-e2e-support";

const gate = new ImGate({
  gate: "T14a M1 关卡：两台机器能互发",
  script: "scripts/im-m1-e2e.ts",
  milestone: "P0-M1",
  evidence: "evidence/im-m1",
});

const imTableNames = Object.keys(IM_TABLES_AFTER_MIGRATION);

function storedMessage(
  localMessageId: string,
  threadId: string,
  sender: {
    localServerId: string;
    localMemberId: string;
    peerServerId: string;
    peerAgentId: string;
    remoteMessageId: string;
    deviceId: string;
    nonce: string;
  },
  body: string,
): ImStoredMessage {
  return {
    localServerId: sender.localServerId,
    localMemberId: sender.localMemberId,
    localMessageId,
    threadId,
    remoteMessageId: sender.remoteMessageId,
    peerServerId: sender.peerServerId,
    peerAgentId: sender.peerAgentId,
    senderKind: "peer",
    senderAgentId: sender.peerAgentId,
    deviceId: sender.deviceId,
    body,
    causalChainId: null,
    proxiedBy: null,
    proxyVisibility: null,
    nonce: sender.nonce,
    signature: "sig",
    verified: true,
    sentAt: 1_700_000_000_000,
    expiresAt: 1_700_086_400_000,
  };
}

function insertPeer(
  db: DatabaseSync,
  peerServerId: string,
  peerAgentId: string,
  publicKey: string,
  displayName: string,
): void {
  db.prepare(
    "INSERT INTO peers (peer_server_id, peer_agent_id, public_key, display_name, first_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(peerServerId, peerAgentId, publicKey, displayName, 1_700_000_000_000);
}

function insertThread(
  db: DatabaseSync,
  threadId: string,
  peerServerId: string,
  peerAgentId: string,
  localServerId = "s",
  localMemberId = "m",
): void {
  db.prepare(
    "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(localServerId, localMemberId, threadId, peerServerId, peerAgentId, "open");
}

async function rejectsAsync(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

function rejects(work: () => void): string {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

function protocolErrorCode(work: () => void): string {
  try {
    work();
  } catch (error) {
    return error instanceof ImProtocolError
      ? error.code
      : `非协议错误(${error instanceof Error ? error.name : String(error)})`;
  }
  return "未抛错";
}

function protocolErrorLabel(work: () => void): string {
  try {
    work();
  } catch (error) {
    return error instanceof ImProtocolError ? error.message : "";
  }
  return "";
}

interface ImRejection {
  code: string;
  label: string;
}

async function envelopeRejection(work: () => Promise<ImEnvelopePayload>): Promise<ImRejection | null> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ImProtocolError) return { code: error.code, label: error.label };
    return { code: "非协议错误", label: error instanceof Error ? error.name : String(error) };
  }
  return null;
}

function validMessage(): ImMessage {
  return {
    localMessageId: "msg-1",
    remoteMessageId: "remote-1",
    threadId: "thread-1",
    senderKind: "peer",
    senderAgentId: null,
    deviceId: null,
    body: "hello",
    attachments: [],
    replyTo: null,
    proxiedBy: null,
    proxyVisibility: null,
    causalChainId: null,
    sentAt: 1_700_000_000_000,
    expiresAt: 1_700_086_400_000,
    withdrawnAt: null,
    verified: true,
  };
}

function validDelivery(): ImDelivery {
  return {
    deliveryId: "del-1",
    localMessageId: "msg-1",
    state: "acked",
    attempts: 1,
    createdAt: 1_700_000_000_000,
    ackedAt: 1_700_000_001_000,
    error: null,
  };
}

function validDevice(): ImDevice {
  return {
    deviceId: "dev-1",
    publicKey: "public-key-1",
    status: "active",
    enrolledAt: 1_700_000_000_000,
    certExpiresAt: 1_700_086_400_000,
  };
}

function withoutMessageField(field: keyof ImMessage): Partial<ImMessage> {
  const copy: Partial<ImMessage> = { ...validMessage() };
  delete copy[field];
  return copy;
}

interface ImIpcEvent {
  senderFrame?: { url?: string | null } | null;
}

interface ImIpcRequest {
  serverId: string;
  payload: unknown;
}

type ImIpcListener = (event: ImIpcEvent, payload: ImIpcRequest) => unknown;

const imIpcListeners = new Map<string, ImIpcListener>();

function installImElectronStub(): void {
  plugin({
    name: "im-electron-stub",
    setup(build) {
      build.module("electron", () => ({
        exports: {
          ipcMain: {
            handle: (channel: string, listener: ImIpcListener) => imIpcListeners.set(channel, listener),
          },
        },
        loader: "object",
      }));
    },
  });
}

const tableExists = (db: DatabaseSync, name: string): boolean =>
  query(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;

const fail = (message: string): never => {
  throw new Error(message);
};

function assertNoForeignProblems(tools: ImCaseTools, label: string, db: DatabaseSync): void {
  const problems = query(db, "PRAGMA foreign_key_check");
  tools.check(label, problems.length === 0, `${problems.length} 处外键问题`);
}

function assertNoForeignProblemsIn(tools: ImCaseTools, label: string, ...dbs: DatabaseSync[]): void {
  for (const [index, db] of dbs.entries()) assertNoForeignProblems(tools, `${label}（库 ${index + 1}）`, db);
}

gate.case({
  id: "M1-01",
  title: "两台机器互发文本/图片/文件并可回看",
  acceptance: "A5（互发与回看部分；撤回部分归 T14d3）",
  refs: ["design §10 A5", "plan §2 P0-M1 出口", "plan §5 A5"],
  needs: [
    { task: "T4a", what: "im_messages 读写与发送状态机", artifact: "src/backend/im/messages.ts" },
    { task: "T18a1", what: "host route im:message:send/list", artifact: "src/backend/im/im-service.ts" },
  ],
  steps: [
    "机器 A 与机器 B 各起一个实例，互加为联系人并完成指纹核对",
    "A 向 B 发送文本、图片、文件各一条",
    "B 侧三条都能回看，内容与附件一致，顺序按发送时间",
    "A 侧发送状态依次出现「本地已提交→服务端已持久化→对端已收下」，不出现假的「已送达」",
  ],
  run: (tools) => {
    const db = openHarnessDatabase();
    try {
      migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
      insertThread(db, "thread-a", "peer-1", "agent-1", "server-1", "member-a");
      insertThread(db, "thread-b", "peer-2", "agent-1", "server-1", "member-b");
      insertPeer(db, "peer-1", "agent-1", "public-key-peer-1", "Peer One");
      insertPeer(db, "peer-2", "agent-1", "public-key-peer-2", "Peer Two");
      const service = new ImService(db, "server-1");
      const sent = service.sendFromClient("member-a", {
        threadId: "thread-a",
        remoteMessageId: "rm-1",
        body: "hello from A",
        attachments: [{ name: "a.txt", digest: "d1", size: 3 }],
        replyTo: null,
        proxiedBy: null,
        proxyVisibility: null,
      });
      tools.record("互发：文本 + 附件都落库", sent.body === "hello from A" && sent.attachments.length === 1);
      const back = service.listMessages("member-a", { threadId: "thread-a" });
      tools.record("回看：内容与附件一致", back.items.length === 1 && back.items[0]?.body === "hello from A");

      tools.record(
        "跨成员隔离：B 看不到 A 的消息",
        service.listMessages("member-b", { threadId: "thread-a" }).items.length === 0,
      );
      tools.record(
        "跨成员隔离：B 的对端列表与 A 不同",
        service.listPeers("member-b", {}).items.every((peer) => peer.peerServerId !== "peer-1"),
      );
      const foreign = rejects(() => {
        service.verifyPeer("member-b", { peerServerId: "peer-1", peerAgentId: "agent-1", fingerprint: "x" });
      });
      tools.record("跨成员隔离：B 不能验 A 的对端", foreign === "im.notFound", foreign);

      tools.record(
        "重复 remoteMessageId 拒（im.duplicateMessage）",
        rejects(() => {
          service.sendFromClient("member-a", {
            threadId: "thread-a",
            remoteMessageId: "rm-1",
            body: "dup",
            attachments: [],
            replyTo: null,
            proxiedBy: null,
            proxyVisibility: null,
          });
        }) === "im.duplicateMessage",
      );
      tools.record("重复未写第二条", service.listMessages("member-a", { threadId: "thread-a" }).items.length === 1);

      const wrong = rejects(() => {
        service.verifyPeer("member-a", {
          peerServerId: "peer-1",
          peerAgentId: "agent-1",
          fingerprint: "not-the-right-one",
        });
      });
      tools.record("指纹不符返回 im.confirmMismatch", wrong === "im.confirmMismatch", wrong);
      const verified = service.verifyPeer("member-a", {
        peerServerId: "peer-1",
        peerAgentId: "agent-1",
        fingerprint: imFingerprint("public-key-peer-1"),
      });
      tools.record("指纹一致才置为已验证", verified.verified === true);

      const storedRow = query(
        db,
        "SELECT verified, signature FROM im_messages WHERE local_message_id = ?",
        sent.localMessageId,
      )[0];
      tools.record(
        "口径钉住：host route 对本地撰写的消息记 verified=false + 空 signature（签名属 T3 信封层）",
        sent.verified === false && storedRow?.verified === 0 && storedRow?.signature === "",
        `verified=${storedRow?.verified} signature=${JSON.stringify(storedRow?.signature)}`,
      );
      tools.hold(
        "阻塞在「两台物理机器」这一步：①真实网络路径有两条证据——verify-im-tcp-cross.ts（两进程 + 回环 TCP，我复核 7/7）与 verify-im-lan-mutual.ts（真 mDNS + 真 wrtc + 真 TCP 信令 + 真封包，我复跑 5/5），**但都是同一台机器的两个进程，不等于两台机器**，只能作等价证据（见 evidence/im-m1/equivalent-evidence.md）。②打包产物探针**我复跑 4/4、6 个 IM 标记全中**（新包 2026-11-22 01:44Z），LAN/wire/relay 已接进入口。③剩下就是两台物理机器跑一次（M1-28 专列该条），另需先解 mDNS A 记录写死 127.0.0.1、deviceKeyOf 调用方预置、信令走明文 TCP 三件；route 层「无身份一律 im.unauthorized」也随跨机链路一起验",
      );
    } finally {
      db.close();
    }
  },
});

gate.case({
  id: "M1-02",
  title: "指纹可核对：显示指纹短语并标记已验证",
  acceptance: "A13-验证标记 / A10-验证标记",
  refs: ["design §10 A13", "design §10 A10", "plan §3 T2 验收"],
  needs: [
    { task: "T2", what: "Ed25519 根身份、指纹短语、设备证书签发/验证/撤销" },
    { task: "T11a1", what: "界面验证标记", artifact: "packages/ui/src/features/im/ImSession.tsx" },
  ],
  steps: [
    "A 与 B 首次对话，界面显示对方指纹短语，状态为「未验证」",
    "双方各自核对指纹短语并确认，状态变为「已验证」",
    "验证后每条消息显示「签名已验证」",
    "指纹不一致时拒绝置为已验证，并保留未验证标记",
  ],
  run: (tools) => {
    tools.note(
      "核对语义按单向写：verified = 「由本实例核对」。peerVerifiedUs 字段在但无数据源（本库只记「我核过谁」，不记「谁核过我」），后端如实报恒 false 未糊假值；产品口径为「保留字段、前端不接、界面按单向渲染」，故本用例不为它立断言",
    );
    const a = createImIdentity();
    const b = createImIdentity();
    const fa = imFingerprint(a.publicKey);
    const fb = imFingerprint(b.publicKey);
    tools.record("指纹短语是 8 组大写十六进制", /^[0-9A-F]{4}( [0-9A-F]{4}){7}$/.test(fa), fa);
    tools.record("同一身份指纹稳定、可重复核对", imFingerprint(a.publicKey) === fa, fa);
    tools.record("不同身份指纹不同", fa !== fb, `${fa} / ${fb}`);
    tools.record("指纹分 8 段、可人工逐段比对", fa.split(" ").length === 8);
    const mutated = `${a.publicKey.startsWith("0") ? "1" : "0"}${a.publicKey.slice(1)}`;
    tools.record("公钥变动即指纹变动", imFingerprint(mutated) !== fa);
    const db = openHarnessDatabase();
    try {
      migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
      insertPeer(db, "peer-1", "agent-1", "public-key-peer-1", "Peer One");
      insertThread(db, "thread-1", "peer-1", "agent-1", "server-1", "member-a");
      const service = new ImService(db, "server-1");
      tools.record(
        "未核对前状态为未验证",
        service.peerVerifiedAt("member-a", { peerServerId: "peer-1", peerAgentId: "agent-1" }) === null,
      );
      const wrong = rejects(() => {
        service.verifyPeer(
          "member-a",
          { peerServerId: "peer-1", peerAgentId: "agent-1", fingerprint: "wrong" },
          1_700_000_000_000,
        );
      });
      tools.record("指纹不一致拒绝置为已验证", wrong === "im.confirmMismatch", wrong);
      tools.record(
        "指纹不一致不落 verified_at",
        service.peerVerifiedAt("member-a", { peerServerId: "peer-1", peerAgentId: "agent-1" }) === null,
      );
      const verified = service.verifyPeer(
        "member-a",
        { peerServerId: "peer-1", peerAgentId: "agent-1", fingerprint: imFingerprint("public-key-peer-1") },
        1_700_000_100_000,
      );
      tools.record("核对通过后状态为已验证", verified.verified === true);
      tools.record(
        "verified_at 落指纹核对通过的时间",
        service.peerVerifiedAt("member-a", { peerServerId: "peer-1", peerAgentId: "agent-1" }) === 1_700_000_100_000,
      );
      tools.record(
        "撤销后清 verified_at",
        service.revokePeerVerification("member-a", { peerServerId: "peer-1", peerAgentId: "agent-1" }) === true &&
          service.peerVerifiedAt("member-a", { peerServerId: "peer-1", peerAgentId: "agent-1" }) === null,
      );
    } finally {
      db.close();
    }
    tools.note(
      "「验证后每条消息显示签名已验证」属渲染行为，已划出本用例范围，由界面证据收口。证据已到（前端 T11a1 第十九轮截图，Storybook/ImSession 实渲染、走真 i18n 文案、未注入能力）：同一屏两个标记两套措辞分开渲染——会话头指纹核对状态写「由本实例核对」（im.session.verified，未核对时是「本实例尚未核对」），每条消息行写「签名已验证」（im.message.verified），两者互不混用。本用例只验后端可验命题：指纹短语可读、8 组大写十六进制可人工逐段比对、验证标记可写、指纹不一致拒置已验证——11 项断言",
    );
  },
});

gate.case({
  id: "M1-03",
  title: "未知字段信封被拒：im.protocolError、不入库不入队、记原因",
  acceptance: "A16c",
  refs: ["design §10 A16c", "design §6.4/§6.8 fail-closed", "plan §3 T1b 验收"],
  needs: [
    { task: "T1b", what: "ipc-im 契约 + FromHost/FromMain 独立 decoder", artifact: "packages/contracts/src/ipc-im.ts" },
    { task: "T3", what: "im-envelope 封装与开启", artifact: "packages/contracts/src/im-envelope.ts" },
  ],
  steps: [
    "构造信封：远端在信封里指定本地 local_message_id",
    "构造信封：远端在信封里指定本地 thread_id / 本地会话键",
    "构造信封：携带一个协议里不存在的未知字段",
    "三种信封都必须整体被拒、返回 im.protocolError、不生成消息、不入队列",
    "拒绝原因落审计或日志，可查到是哪一类越界",
    "本地 local_message_id / thread_id 由接收方生成，不接受远端指定",
  ],
  run: async (tools) => {
    const pair = await createHostGrantKeyPair();
    const payload: ImEnvelopePayload = {
      kind: "message",
      remoteMessageId: "remote-1",
      body: "hello",
      sentAt: 1_700_000_000_000,
      deviceId: "device-a",
      causalChainId: "chain-1",
    };
    const nonce = imEnvelopeNonce("chain-1", "device-a");
    const sealed = await sealImEnvelope(pair.publicKey, nonce, payload);
    const opened = await openImEnvelope(pair.privateKey, nonce, sealed);
    tools.check(
      "合法信封按设备公钥封装并解封",
      opened.remoteMessageId === payload.remoteMessageId && opened.body === payload.body,
    );

    const smuggled: ReadonlyArray<readonly [string, () => Promise<string>]> = [
      [
        "远端指定 local_message_id",
        () => sealHostGrant(IM_ENVELOPE_KIND, pair.publicKey, nonce, { ...payload, localMessageId: "local-1" }),
      ],
      [
        "远端指定 thread_id",
        () => sealHostGrant(IM_ENVELOPE_KIND, pair.publicKey, nonce, { ...payload, threadId: "thread-1" }),
      ],
      ["协议外未知字段", () => sealHostGrant(IM_ENVELOPE_KIND, pair.publicKey, nonce, { ...payload, smuggled: 1 })],
    ];
    let firstRejection: ImRejection | null = null;
    for (const [label, seal] of smuggled) {
      const bad = await seal();
      const rejection = await envelopeRejection(() => openImEnvelope(pair.privateKey, nonce, bad));
      firstRejection ??= rejection;
      tools.record(`${label} 整体拒且返回 im.protocolError`, rejection?.code === "im.protocolError", rejection?.code);
    }
    tools.check(
      "三种越界都未生成任何 payload（open 不返回值即不生成消息、不入队列）",
      smuggled.length === 3 && firstRejection !== null,
    );
    tools.check(
      "拒绝原因可查（错误带 IM envelope 标签）",
      firstRejection?.label === "IM envelope",
      firstRejection?.label ?? "无",
    );
    tools.check(
      "信封 payload 不含 local_message_id / thread_id（本地 ID 由接收方生成）",
      Object.keys(payload).sort().join(",") === "body,causalChainId,deviceId,kind,remoteMessageId,sentAt",
      Object.keys(payload).sort().join(","),
    );

    const wrongNonce = await sealImEnvelope(pair.publicKey, imEnvelopeNonce("chain-1", "device-b"), payload);
    tools.check(
      "换 nonce 解不开（AAD 绑定）",
      (await envelopeRejection(() => openImEnvelope(pair.privateKey, nonce, wrongNonce))) !== null,
    );
    const other = await createHostGrantKeyPair();
    tools.check(
      "非本机密钥解不开",
      (await envelopeRejection(() => openImEnvelope(other.privateKey, nonce, sealed))) !== null,
    );
    const downgrade = await sealHostGrant(
      { version: 1, info: "openbot-ingress-queue-v1" },
      pair.publicKey,
      nonce,
      payload,
    );
    tools.check(
      "降级拒：他种 HostGrantKind 的信封解不开",
      (await envelopeRejection(() => openImEnvelope(pair.privateKey, nonce, downgrade))) !== null,
    );
    tools.check(
      "IM_ENVELOPE_KIND 自成一种 HostGrantKind",
      IM_ENVELOPE_KIND.info === "openbot-im-envelope-v1" && IM_ENVELOPE_KIND.version === 1,
      `${IM_ENVELOPE_KIND.version}/${IM_ENVELOPE_KIND.info}`,
    );

    const forDevices = await sealImEnvelopeForDevices(
      [
        { deviceId: "device-a", publicKey: pair.publicKey },
        { deviceId: "device-b", publicKey: other.publicKey },
      ],
      nonce,
      payload,
    );
    tools.check("按设备公钥各封一份", forDevices.length === 2 && forDevices[0]?.sealed !== forDevices[1]?.sealed);
    tools.check(
      "每台只能开自己那份",
      (await envelopeRejection(() => openImEnvelope(pair.privateKey, nonce, forDevices[1]?.sealed ?? ""))) !== null &&
        (await envelopeRejection(() => openImEnvelope(other.privateKey, nonce, forDevices[1]?.sealed ?? ""))) === null,
    );

    const root = createImIdentity();
    const registry = new ImDeviceRegistry(root);
    const now = 1_700_000_000_000;
    const codeDeviceA = registry.enrollBegin({
      localServerId: "s",
      localMemberId: "m",
      deviceId: "device-a",
      publicKey: pair.publicKey,
      now,
      ttlMs: 60_000,
    });
    const codeDeviceB = registry.enrollBegin({
      localServerId: "s",
      localMemberId: "m",
      deviceId: "device-b",
      publicKey: other.publicKey,
      now,
      ttlMs: 60_000,
    });
    registry.enrollApprove({
      deviceId: "device-a",
      pairingCode: codeDeviceA.pairingCode ?? "",
      now,
      ttlMs: 86_400_000,
    });
    registry.enrollApprove({
      deviceId: "device-b",
      pairingCode: codeDeviceB.pairingCode ?? "",
      now,
      ttlMs: 86_400_000,
    });
    tools.check("撤销前两台都在收件人候选里", registry.activeDevices().length === 2);
    registry.revoke("device-b", now);
    const recipients = registry.activeDevices();
    tools.check(
      "撤销设备不在收件人列表",
      recipients.length === 1 && recipients.every((entry) => entry.deviceId !== "device-b"),
      recipients.map((entry) => entry.deviceId).join(","),
    );
    const afterRevoke = await sealImEnvelopeForDevices(recipients, nonce, payload);
    tools.check(
      "按撤销后的收件人列表封装，撤销设备拿不到任何信封",
      afterRevoke.length === 1 && afterRevoke.every((entry) => entry.deviceId === "device-a"),
      afterRevoke.map((entry) => entry.deviceId).join(","),
    );
  },
});

gate.case({
  id: "M1-04",
  title: "两个不同发送方复用同一 remoteMessageId：两条都入库",
  acceptance: "A16a",
  refs: ["design §10 A16a", "design §6.5 message_dedup", "plan §3 T4a 验收"],
  needs: [{ task: "T4a", what: "message_dedup 唯一键按发送方维度隔离", artifact: "src/backend/im/messages.ts" }],
  steps: [
    "发送方 P1 与 P2 各自构造相同的 remoteMessageId 发给同一接收方",
    "接收方两条都入库，互不覆盖、互不去重误判",
    "im_messages 中两条记录的 (peer_server_id, peer_agent_id, remote_message_id) 组合都存在",
  ],
  run: (tools) => {
    const db = openHarnessDatabase();
    try {
      migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
      const store = new ImMessageStore(db);
      const now = 1_700_000_000_000;
      const shared = {
        localServerId: "s",
        localMemberId: "m",
        remoteMessageId: "rm-1",
        deviceId: "dev-1",
        nonce: "nonce-1",
      };
      const senderOne = { ...shared, peerServerId: "peer-1", peerAgentId: "agent-1" };
      const senderTwo = { ...shared, peerServerId: "peer-2", peerAgentId: "agent-1" };
      insertThread(db, "thread-1", "peer-1", "agent-1");
      insertThread(db, "thread-2", "peer-2", "agent-1");
      tools.record("发送方 P1 首次未判重", store.hasDuplicate(senderOne) === false);
      store.markDuplicate({ ...senderOne, receivedAt: now });
      tools.record("P2 用同一 remoteMessageId 仍未判重（按发送方维度隔离）", store.hasDuplicate(senderTwo) === false);
      store.markDuplicate({ ...senderTwo, receivedAt: now });
      store.insertMessage(storedMessage("msg-a", "thread-1", senderOne, "from p1"));
      store.insertMessage(storedMessage("msg-b", "thread-2", senderTwo, "from p2"));
      tools.record(
        "两条都入库、互不覆盖",
        store.readMessage("s", "m", "msg-a")?.body === "from p1" &&
          store.readMessage("s", "m", "msg-b")?.body === "from p2",
      );
      tools.record(
        "两条的 (peer, agent, remoteMessageId) 组合都存在",
        store.hasDuplicate(senderOne) === true && store.hasDuplicate(senderTwo) === true,
      );
    } finally {
      db.close();
    }
  },
});

gate.case({
  id: "M1-05",
  title: "同一发送方重复同一 remoteMessageId：只入库一次并判 im.duplicateMessage",
  acceptance: "A16b",
  refs: ["design §10 A16b", "plan §3 T4a 验收"],
  needs: [{ task: "T4a", what: "message_dedup 幂等去重", artifact: "src/backend/im/messages.ts" }],
  steps: [
    "同一发送方用同一 remoteMessageId 发两次，第二次改过内容",
    "只入库一次，内容为第一次的",
    "第二次返回 im.duplicateMessage，不写第二条",
  ],
  run: (tools) => {
    const db = openHarnessDatabase();
    try {
      migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
      const store = new ImMessageStore(db);
      const now = 1_700_000_000_000;
      const sender = {
        localServerId: "s",
        localMemberId: "m",
        peerServerId: "peer-1",
        peerAgentId: "agent-1",
        remoteMessageId: "rm-1",
        deviceId: "dev-1",
        nonce: "nonce-1",
      };
      insertThread(db, "thread-1", "peer-1", "agent-1");
      store.markDuplicate({ ...sender, receivedAt: now });
      store.insertMessage(storedMessage("msg-1", "thread-1", sender, "first body"));
      tools.record("首次入库成功", store.readMessage("s", "m", "msg-1")?.body === "first body");
      tools.record("同一发送方同一 remoteMessageId 再来判重为真", store.hasDuplicate(sender) === true);
      tools.record(
        "重复登记抛 im.duplicateMessage",
        rejects(() => store.markDuplicate({ ...sender, receivedAt: now + 1 })) === "im.duplicateMessage",
      );
      tools.record(
        "第二次入库被唯一键挡住（只入库一次）",
        rejects(() => store.insertMessage(storedMessage("msg-2", "thread-1", sender, "second body"))) !== "",
      );
      tools.record("第二次不写第二条", store.listMessages("s", "m", "thread-1").length === 1);
      tools.record("内容仍为第一次的", store.readMessage("s", "m", "msg-1")?.body === "first body");
    } finally {
      db.close();
    }
  },
});

gate.case({
  id: "M1-06",
  title: "A12① 迁移与 schema 同事务：中途失败整体回滚、可安全重试",
  acceptance: "A12①",
  refs: ["design §10 A12", "plan §3 T1 验收", "plan 红线 1 迁移只追加不丢数据 + 单一来源"],
  needs: [{ task: "T1", what: "迁移与 schema 单一来源", artifact: "src/backend/migrations/0068-im.ts" }],
  steps: [
    "把库建到 IM 迁移的前一版",
    "预置一张同名但结构不同的 im_messages，让 IM 迁移跑到一半必然失败",
    "调用真实迁移引擎，断言抛错且未写入迁移标记",
    "断言失败后没有留下任何半截的 IM 表",
    "断言仍需要迁移（可安全重试）",
    "移除干扰表后重跑迁移，断言成功、外键检查为空",
  ],
  run: (tools) => {
    const db = openHarnessDatabase();
    try {
      buildDatabaseAtVersion(db, imMigration.version - 1);
      db.exec("CREATE TABLE im_messages (bogus INTEGER)");
      let thrown: unknown = null;
      try {
        migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
      } catch (error) {
        thrown = error;
      }
      tools.check(
        "IM 迁移在中途失败时抛错",
        thrown !== null,
        thrown instanceof Error ? thrown.message : String(thrown),
      );
      tools.check(
        "失败后未写入迁移标记",
        !readAppliedVersions(db).includes(imMigration.version),
        `已写入版本：${readAppliedVersions(db).join(",")}`,
      );
      const leftovers = imTableNames.filter((name) => name !== "im_messages" && tableExists(db, name));
      tools.check("失败后未留下半截的 IM 表", leftovers.length === 0, leftovers.join(","));
      tools.check("失败后仍需要迁移", openBotDatabaseNeedsMigration(db));
      db.exec("DROP TABLE im_messages");
      migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
      tools.check("安全重试后迁移成功", readAppliedVersions(db).includes(imMigration.version));
      tools.check("重试后 24 张 IM 表齐全", imTableNames.filter((name) => !tableExists(db, name)).length === 0);
      assertNoForeignProblems(tools, "重试后 PRAGMA foreign_key_check 为空", db);
    } finally {
      db.close();
    }
  },
});

gate.case({
  id: "M1-07",
  title: "A12② 全部已发布 schema fixtures 逐表升级：行数与内容保持",
  acceptance: "A12②",
  refs: ["design §10 A12", "plan 红线 1 fixtures 行数保持"],
  needs: [{ task: "T1", what: "迁移只追加不丢数据", artifact: "src/backend/migrations/0068-im.ts" }],
  steps: [
    "逐个取已发布 schema fixtures（含新装与逐版升级两类）",
    "每张表灌入 fixtures 行",
    "升级到最新 schema",
    "逐表比对升级前后行数与内容，要求完全一致",
    "应被删除的表确实删除，PRAGMA foreign_key_check 与 integrity_check 均为空",
  ],
  run: (tools) => {
    const cases = releasedDatabaseCases();
    tools.check("存在已发布 schema fixtures", cases.length > 0, `${cases.length} 个`);
    const problems: string[] = [];
    for (const released of cases) {
      const db = openHarnessDatabase();
      try {
        buildReleasedDatabase(db, released);
        seedEveryTable(db);
        const beforeHealth = healthProblems(db);
        if (beforeHealth.length > 0) problems.push(`${released.name}｜升级前不健康｜${beforeHealth.join(";")}`);
        const fromVersion = latestAppliedVersion(db);
        const before = readTableRows(db);
        migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
        const expected = expectedRowsAfterUpgrade(before, fromVersion, LATEST_SCHEMA_VERSION);
        const actual = JSON.stringify(actualRows(db, expected));
        const want = JSON.stringify(sortedRows(expected));
        if (actual !== want) problems.push(`${released.name}｜逐表行内容或行数不一致`);
        const remaining = new Set(readTableRows(db).keys());
        const leaked = expected.dropped.filter((table) => remaining.has(table));
        if (leaked.length > 0) problems.push(`${released.name}｜应删除的表仍在｜${leaked.join(",")}`);
        const afterHealth = healthProblems(db);
        if (afterHealth.length > 0) problems.push(`${released.name}｜升级后不健康｜${afterHealth.join(";")}`);
      } finally {
        db.close();
      }
    }
    tools.check("全部已发布 fixtures 升级后行数与内容保持", problems.length === 0, problems.slice(0, 6).join("；"));
  },
});

gate.case({
  id: "M1-08",
  title: "A12③ 新库与升级库 schema 一致",
  acceptance: "A12③",
  refs: ["design §10 A12", "plan 红线 1 同一段文本既是迁移又是新建库尾部"],
  needs: [{ task: "T1", what: "DDL 单一来源", artifact: "src/backend/migrations/0068-im.ts" }],
  steps: [
    "路径一：空库直接迁移到最新（新建库）",
    "路径二：从 IM 迁移前一版升级到最新（升级库）",
    "比对两条路径的表结构与规范化声明，要求完全一致",
    "两条路径 PRAGMA foreign_key_check 均为空",
  ],
  run: (tools) => {
    const fresh = openHarnessDatabase();
    const upgraded = openHarnessDatabase();
    try {
      migrateOpenBotDatabase(fresh, { appliedAt: HARNESS_APPLIED_AT });
      buildDatabaseAtVersion(upgraded, imMigration.version - 1);
      migrateOpenBotDatabase(upgraded, { appliedAt: HARNESS_APPLIED_AT });
      tools.check(
        "新库与升级库的表结构一致",
        JSON.stringify(readTableShapes(fresh)) === JSON.stringify(readTableShapes(upgraded)),
      );
      tools.check(
        "新库与升级库的规范化声明一致",
        JSON.stringify(readNormalizedDeclarations(fresh)) === JSON.stringify(readNormalizedDeclarations(upgraded)),
      );
      tools.check(
        "新库与升级库的迁移版本一致",
        JSON.stringify(readAppliedVersions(fresh)) === JSON.stringify(readAppliedVersions(upgraded)),
      );
      assertNoForeignProblemsIn(tools, "两条路径 PRAGMA foreign_key_check 为空", fresh, upgraded);
    } finally {
      fresh.close();
      upgraded.close();
    }
  },
});

gate.case({
  id: "M1-09",
  title: "A12④ 二次启动无额外变更",
  acceptance: "A12④",
  refs: ["design §10 A12", "plan §3 T1 验收"],
  needs: [{ task: "T1", what: "二次迁移无变化", artifact: "src/backend/migrations/0068-im.ts" }],
  steps: [
    "新建库跑一次迁移，记录表结构、声明与迁移版本",
    "同库再跑一次迁移，断言三者完全无变化",
    "从已发布 fixture 升级一次后再跑一次迁移，断言同样无变化",
  ],
  run: (tools) => {
    const fresh = openHarnessDatabase();
    try {
      migrateOpenBotDatabase(fresh, { appliedAt: HARNESS_APPLIED_AT });
      const first = {
        shapes: JSON.stringify(readTableShapes(fresh)),
        declarations: JSON.stringify(readNormalizedDeclarations(fresh)),
        versions: JSON.stringify(readAppliedVersions(fresh)),
      };
      migrateOpenBotDatabase(fresh, { appliedAt: "2026-12-01T00:00:00.000Z", closedCleanly: true });
      tools.check("新建库二次启动后 schema 无变化", JSON.stringify(readTableShapes(fresh)) === first.shapes);
      tools.check(
        "新建库二次启动后声明无变化",
        JSON.stringify(readNormalizedDeclarations(fresh)) === first.declarations,
      );
      tools.check("新建库二次启动后迁移版本无追加", JSON.stringify(readAppliedVersions(fresh)) === first.versions);
    } finally {
      fresh.close();
    }

    const released = releasedDatabaseCases()[0];
    if (!released) return fail("没有可用的已发布 schema fixture，无法验证升级库的二次启动");
    const upgraded = openHarnessDatabase();
    try {
      buildReleasedDatabase(upgraded, released);
      migrateOpenBotDatabase(upgraded, { appliedAt: HARNESS_APPLIED_AT });
      const afterUpgrade = {
        shapes: JSON.stringify(readTableShapes(upgraded)),
        declarations: JSON.stringify(readNormalizedDeclarations(upgraded)),
        versions: JSON.stringify(readAppliedVersions(upgraded)),
      };
      migrateOpenBotDatabase(upgraded, { appliedAt: "2026-12-01T00:00:00.000Z", closedCleanly: true });
      tools.check("升级库二次启动后 schema 无变化", JSON.stringify(readTableShapes(upgraded)) === afterUpgrade.shapes);
      tools.check(
        "升级库二次启动后声明无变化",
        JSON.stringify(readNormalizedDeclarations(upgraded)) === afterUpgrade.declarations,
      );
      tools.check(
        "升级库二次启动后迁移版本无追加",
        JSON.stringify(readAppliedVersions(upgraded)) === afterUpgrade.versions,
      );
    } finally {
      upgraded.close();
    }
  },
});

gate.case({
  id: "M1-10",
  title: "设备未入网：其消息签名校验失败",
  acceptance: "A13（未入网）",
  refs: ["design §10 A13", "plan §3 T2 验收"],
  needs: [{ task: "T2", what: "设备证书签发/验证/撤销 + local_devices 五步入网" }],
  steps: [
    "设备 B 处于 pending（未批准）状态，向 A 发一条签名消息",
    "A 侧签名校验失败，消息不被当作可信消息",
    "审计记录失败原因（设备未入网/未批准）",
  ],
  run: (tools) => {
    const trusted = createImIdentity();
    const foreign = createImIdentity();
    const deviceKey = createImIdentity();
    const now = 1_700_000_000_000;
    const window = 86_400_000;
    const input = { deviceId: "dev-1", publicKey: deviceKey.publicKey, issuedAt: now, expiresAt: now + window };
    const legit = issueDeviceCertificate(trusted, input);
    tools.record("受信根签发的证书可验真", verifyDeviceCertificate(legit, now, trusted.publicKey) === true);

    const impostor = issueDeviceCertificate(foreign, input);
    tools.record("他根签发的证书对受信根被拒", verifyDeviceCertificate(impostor, now, trusted.publicKey) === false);
    tools.record(
      "同一张他根证书对他自己的根能过（证明拒的是根不匹配，不是签名坏）",
      verifyDeviceCertificate(impostor, now, foreign.publicKey) === true,
    );
    tools.record(
      "篡改设备号的证书被拒",
      verifyDeviceCertificate({ ...legit, deviceId: "dev-2" }, now, trusted.publicKey) === false,
    );
    const flippedSignature = `${legit.signature.startsWith("0") ? "1" : "0"}${legit.signature.slice(1)}`;
    tools.record(
      "篡改签名的证书被拒",
      verifyDeviceCertificate({ ...legit, signature: flippedSignature }, now, trusted.publicKey) === false,
    );
    tools.record(
      "过期证书被拒",
      verifyDeviceCertificate({ ...legit, expiresAt: now - 1 }, now, trusted.publicKey) === false,
    );

    const registry = new ImDeviceRegistry(trusted);
    registry.enrollBegin({
      localServerId: "s",
      localMemberId: "m",
      deviceId: "dev-pending",
      publicKey: deviceKey.publicKey,
      now,
      ttlMs: 60_000,
    });
    tools.record("未批准（pending）设备不被验真", registry.verifyDevice("dev-pending", now) === false);
    tools.record("未批准设备不在活跃列表", registry.activeDevices().length === 0);
    const auditDb = openHarnessDatabase();
    try {
      migrateOpenBotDatabase(auditDb, { appliedAt: HARNESS_APPLIED_AT });
      const audit = new ImAuditLog(auditDb);
      const scope = { localServerId: "s", localMemberId: "m" };
      const secretToken = "super-secret-token-value";
      audit.record(scope, {
        id: "audit-m1-10",
        actorId: "peer-1/agent-1",
        sourceTrustDomain: "im-peer",
        action: "im.device.verify",
        targetId: "dev-pending",
        result: "rejected",
        correlationId: "corr-m1-10",
        before: undefined,
        after: undefined,
        at: now,
        detail: { reason: "device not enrolled", devicePublicKey: deviceKey.publicKey, token: secretToken },
      });
      const read = audit.read(scope, "audit-m1-10");
      tools.record(
        "拒绝原因写入审计且可读回",
        read !== null && read.action === "im.device.verify" && read.result === "rejected",
      );
      tools.record("信任域标为外部", read?.sourceTrustDomain === "im-peer");
      tools.record(
        "审计字段齐全（actor/信任域/action/target/result/correlationId/时间）",
        read !== null &&
          read.actorId.length > 0 &&
          read.targetId === "dev-pending" &&
          read.correlationId === "corr-m1-10" &&
          read.at === now,
      );
      tools.record("写入前脱敏：密钥类键名被脱敏", !String(read?.redactedDetail).includes(secretToken));
      tools.record(
        "写入前脱敏：长串公钥被脱敏",
        !String(read?.redactedDetail).includes(deviceKey.publicKey.slice(0, 24)),
      );
      tools.record("脱敏后仍保留非敏感原因", String(read?.redactedDetail).includes("device not enrolled"));
      tools.record(
        "只追加：同 id 再写被主键拒绝且原事件未被篡改",
        rejects(() => {
          audit.record(scope, {
            id: "audit-m1-10",
            actorId: "tampered",
            sourceTrustDomain: "local",
            action: "tampered",
            targetId: "x",
            result: "ok",
            correlationId: "c",
            before: undefined,
            after: undefined,
            at: now + 1,
          });
        }) !== "" && audit.read(scope, "audit-m1-10")?.action === "im.device.verify",
      );
      tools.record(
        "ImAuditLog 只暴露追加与读取（无 update/delete）",
        Object.getOwnPropertyNames(ImAuditLog.prototype).sort().join(",") ===
          "byCorrelation,constructor,list,read,record",
        Object.getOwnPropertyNames(ImAuditLog.prototype).sort().join(","),
      );
    } finally {
      auditDb.close();
    }
  },
});

gate.case({
  id: "M1-11",
  title: "设备入网与批准：enroll/begin→approve 后可发可收，含此前按其公钥封装的离线消息",
  acceptance: "A13（入网与批准）",
  refs: ["design §10 A13", "design §6.6", "plan §3 T2/T18a3 验收"],
  needs: [
    { task: "T2", what: "五步入网流程与证书签发" },
    { task: "T18a3", what: "host route im:devices:enrollBegin|enrollApprove|enrollStatus" },
  ],
  steps: [
    "设备 B 发起 enroll/begin，A 侧收到入网请求",
    "A 核对配对码/指纹后 approve，B 转为 active",
    "B 可发可收，签名校验通过",
    "在 B 批准前，按 B 公钥封装的离线消息在批准后仍能解开并收下",
  ],
  run: async (tools) => {
    const root = createImIdentity();
    const registry = new ImDeviceRegistry(root);
    const deviceKey = createImIdentity();
    const now = 1_700_000_000_000;
    const codeDevB = registry.enrollBegin({
      localServerId: "s",
      localMemberId: "m",
      deviceId: "dev-b",
      publicKey: deviceKey.publicKey,
      now,
      ttlMs: 60_000,
    });
    tools.record("enrollBegin 后状态为 pending", registry.enrollStatus("dev-b") === "pending");
    tools.record("批准前不被验真", registry.verifyDevice("dev-b", now) === false);
    const approved = registry.enrollApprove({
      deviceId: "dev-b",
      pairingCode: codeDevB.pairingCode ?? "",
      now,
      ttlMs: 86_400_000,
    });
    tools.record("approve 后状态为 active", approved.status === "active");
    tools.record("approve 后签发设备证书", approved.cert !== null && approved.cert.deviceId === "dev-b");
    tools.record("approve 后签名校验通过", registry.verifyDevice("dev-b", now) === true);
    tools.record(
      "配对码不符拒绝批准",
      rejects(() => {
        const codeDeviceC = registry.enrollBegin({
          localServerId: "s",
          localMemberId: "m",
          deviceId: "dev-c",
          publicKey: deviceKey.publicKey,
          now,
          ttlMs: 60_000,
        });
        registry.enrollApprove({
          deviceId: "dev-c",
          pairingCode: `not-${codeDeviceC.pairingCode ?? ""}`,
          now,
          ttlMs: 60_000,
        });
      }) === "im.pairingExpired",
    );
    tools.record(
      "配对码过期拒绝批准",
      rejects(() => {
        const codeDeviceD = registry.enrollBegin({
          localServerId: "s",
          localMemberId: "m",
          deviceId: "dev-d",
          publicKey: deviceKey.publicKey,
          now,
          ttlMs: 1_000,
        });
        registry.enrollApprove({
          deviceId: "dev-d",
          pairingCode: codeDeviceD.pairingCode ?? "",
          now: now + 2_000,
          ttlMs: 60_000,
        });
      }) === "im.pairingExpired",
    );
    const deviceEnvelope = await createHostGrantKeyPair();
    const earlyNonce = imEnvelopeNonce("chain-1", "dev-early");
    const earlyPayload: ImEnvelopePayload = {
      kind: "message",
      remoteMessageId: "remote-early",
      body: "queued before approval",
      sentAt: now,
      deviceId: "dev-early",
      causalChainId: "chain-1",
    };
    const queuedBeforeApproval = await sealImEnvelope(deviceEnvelope.publicKey, earlyNonce, earlyPayload);
    tools.record(
      "批准前按其公钥封装的离线消息，批准后能解开（设备密钥跨入网稳定）",
      (await envelopeRejection(() => openImEnvelope(deviceEnvelope.privateKey, earlyNonce, queuedBeforeApproval))) ===
        null,
    );

    const db = openHarnessDatabase();
    try {
      migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
      const store = new ImDeviceStore(db);
      const persistedRoot = createImIdentity();
      const approvedKey = createImIdentity();
      const pendingKey = createImIdentity();
      const lateKey = createImIdentity();
      tools.record(
        "给了 store 却不给作用域必须抛错（杜绝静默空载入）",
        rejects(() => {
          new ImDeviceRegistry(persistedRoot, store);
        }) === "im.protocolError",
      );
      const first = new ImDeviceRegistry(persistedRoot, store, { localServerId: "s", localMemberId: "m" });
      const codeApproved = first.enrollBegin({
        localServerId: "s",
        localMemberId: "m",
        deviceId: "dev-approved",
        publicKey: approvedKey.publicKey,
        now,
        ttlMs: 60_000,
      });
      first.enrollApprove({
        deviceId: "dev-approved",
        pairingCode: codeApproved.pairingCode ?? "",
        now,
        ttlMs: 86_400_000,
      });
      const codePending = first.enrollBegin({
        localServerId: "s",
        localMemberId: "m",
        deviceId: "dev-pending",
        publicKey: pendingKey.publicKey,
        now,
        ttlMs: 60_000,
      });
      tools.record("落盘后 store 能按作用域读回", store.list("s", "m").length === 2, `${store.list("s", "m").length}`);

      const reopened = new ImDeviceRegistry(persistedRoot, store, { localServerId: "s", localMemberId: "m" });
      tools.record(
        "跨会话对照组：已批准设备重开后仍可验真",
        reopened.verifyDevice("dev-approved", now) === true,
        `activeDevices=${reopened.activeDevices().length}`,
      );
      const expiredAttempt = rejects(() => {
        const late = new ImDeviceRegistry(persistedRoot, store, { localServerId: "s", localMemberId: "m" });
        const codeLate = late.enrollBegin({
          localServerId: "s",
          localMemberId: "m",
          deviceId: "dev-late",
          publicKey: lateKey.publicKey,
          now,
          ttlMs: 60_000,
        });
        late.enrollApprove({
          deviceId: "dev-late",
          pairingCode: codeLate.pairingCode ?? "",
          now: now + 120_000,
          ttlMs: 86_400_000,
        });
      });
      tools.record(
        "对照组：过期的码重开后必须 im.pairingExpired（TTL 生效）",
        expiredAttempt === "im.pairingExpired",
        expiredAttempt,
      );
      const hasPairingCode = query(db, "PRAGMA table_info(local_devices)").some((row) => row.name === "pairing_code");
      if (!hasPairingCode) {
        tools.hold(
          "新语义未落地：0069（local_devices.pairing_code 列）与随机配对码都还没有——迁移只到 0068、identity.ts 仍留 imPairingCode 派生回退。「未过期的码重开后仍可批准」待跑；当前实测：未过期的原随机码重开后不可批（配对码未持久化）",
        );
      } else {
        const approveAfterReopen = rejects(() => {
          reopened.enrollApprove({
            deviceId: "dev-pending",
            pairingCode: codePending.pairingCode ?? "",
            now,
            ttlMs: 86_400_000,
          });
        });
        tools.record("跨会话：未过期的码重开后仍可批准", approveAfterReopen === "", approveAfterReopen);
        tools.record("跨会话批准后签名校验通过", reopened.verifyDevice("dev-pending", now) === true);
      }
    } finally {
      db.close();
    }
  },
});

gate.case({
  id: "M1-12",
  title: "设备撤销：revoke 后新消息失败、历史按证书有效期仍可验证",
  acceptance: "A13（撤销）",
  refs: ["design §10 A13", "design §6.6 时序表", "plan §3 T2 验收"],
  needs: [{ task: "T2", what: "设备证书撤销与旧钥保留 ≥ 40 天" }],
  steps: [
    "对设备 B 执行 revoke，状态转 revoked",
    "B 发的新消息签名校验失败，不被接受",
    "撤销前的历史消息按证书有效期仍可验证通过",
    "撤销动作本身写审计",
  ],
  run: (tools) => {
    const root = createImIdentity();
    const registry = new ImDeviceRegistry(root);
    const deviceKey = createImIdentity();
    const now = 1_700_000_000_000;
    const codeDevB = registry.enrollBegin({
      localServerId: "s",
      localMemberId: "m",
      deviceId: "dev-b",
      publicKey: deviceKey.publicKey,
      now,
      ttlMs: 60_000,
    });
    const approved = registry.enrollApprove({
      deviceId: "dev-b",
      pairingCode: codeDevB.pairingCode ?? "",
      now,
      ttlMs: 86_400_000,
    });
    const certBefore = approved.cert;
    tools.record("撤销前可验真", registry.verifyDevice("dev-b", now) === true);
    const revoked = registry.revoke("dev-b", now + 1_000);
    tools.record("撤销后状态为 revoked", revoked.status === "revoked");
    tools.record("撤销后新消息签名校验失败", registry.verifyDevice("dev-b", now + 1_000) === false);
    tools.record("撤销后不在活跃列表", registry.activeDevices().length === 0);
    tools.record("撤销后证书有效期归零", revoked.cert?.expiresAt === 0, `${revoked.cert?.expiresAt}`);
    tools.record(
      "撤销前的历史消息按证书有效期仍可验证（撤销不作废历史）",
      certBefore !== null && verifyDeviceCertificate(certBefore, now + 3_600_000, root.publicKey) === true,
    );
    tools.record(
      "同一张历史证书过了有效期后同样验不过（历史仍受证书有效期约束）",
      certBefore !== null && verifyDeviceCertificate(certBefore, now + 86_400_001, root.publicKey) === false,
    );
    const db = openHarnessDatabase();
    try {
      migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
      const store = new ImDeviceStore(db);
      const persistedRoot = createImIdentity();
      const keptKey = createImIdentity();
      const droppedKey = createImIdentity();
      const first = new ImDeviceRegistry(persistedRoot, store, { localServerId: "s", localMemberId: "m" });
      const codeKeep = first.enrollBegin({
        localServerId: "s",
        localMemberId: "m",
        deviceId: "dev-keep",
        publicKey: keptKey.publicKey,
        now,
        ttlMs: 60_000,
      });
      first.enrollApprove({ deviceId: "dev-keep", pairingCode: codeKeep.pairingCode ?? "", now, ttlMs: 86_400_000 });
      const codeDrop = first.enrollBegin({
        localServerId: "s",
        localMemberId: "m",
        deviceId: "dev-drop",
        publicKey: droppedKey.publicKey,
        now,
        ttlMs: 60_000,
      });
      first.enrollApprove({ deviceId: "dev-drop", pairingCode: codeDrop.pairingCode ?? "", now, ttlMs: 86_400_000 });
      first.revoke("dev-drop", now + 1_000);
      const stored = store.read("s", "m", "dev-drop");
      tools.record(
        "撤销已落盘（revoked_at 有值、证书失效）",
        stored?.status === "revoked" && stored.revokedAt !== null && stored.cert?.expiresAt === 0,
        `status=${stored?.status} revokedAt=${stored?.revokedAt} certExpires=${stored?.cert?.expiresAt}`,
      );
      const reopened = new ImDeviceRegistry(persistedRoot, store, { localServerId: "s", localMemberId: "m" });
      tools.record(
        "跨会话对照组：未撤销设备重开后仍可验真",
        reopened.verifyDevice("dev-keep", now) === true,
        `activeDevices=${reopened.activeDevices().length}`,
      );
      tools.record("跨会话：撤销设备重开后仍不可验真", reopened.verifyDevice("dev-drop", now) === false);
      tools.record(
        "跨会话：撤销设备重开后不在活跃列表",
        reopened.activeDevices().every((entry) => entry.deviceId !== "dev-drop"),
      );
    } finally {
      db.close();
    }
    const auditDb = openHarnessDatabase();
    try {
      migrateOpenBotDatabase(auditDb, { appliedAt: HARNESS_APPLIED_AT });
      const audit = new ImAuditLog(auditDb);
      const scope = { localServerId: "s", localMemberId: "m" };
      audit.record(scope, {
        id: "audit-m1-12",
        actorId: "local/member",
        sourceTrustDomain: "local",
        action: "im.device.revoke",
        targetId: "dev-drop",
        result: "revoked",
        correlationId: "corr-m1-12",
        before: { status: "active" },
        after: { status: "revoked" },
        at: now + 1_000,
      });
      const read = audit.read(scope, "audit-m1-12");
      tools.record(
        "撤销动作写入审计且可读回",
        read !== null && read.action === "im.device.revoke" && read.result === "revoked",
      );
      tools.record(
        "before/after 都留痕",
        read?.before?.includes("active") === true && read?.after?.includes("revoked") === true,
      );
      tools.record(
        "只追加：同 id 再写被拒且原事件未被篡改",
        rejects(() => {
          audit.record(scope, {
            id: "audit-m1-12",
            actorId: "tampered",
            sourceTrustDomain: "local",
            action: "tampered",
            targetId: "x",
            result: "ok",
            correlationId: "c",
            before: undefined,
            after: undefined,
            at: now + 2,
          });
        }) !== "" && audit.read(scope, "audit-m1-12")?.action === "im.device.revoke",
      );
    } finally {
      auditDb.close();
    }
  },
});

gate.case({
  id: "M1-13",
  title: "A13 设备用户流程证据（桌面 + Web）",
  acceptance: "A13（用户流程）",
  refs: ["design §10 A13", "plan §3 T11a3/T16a3 验收"],
  needs: [
    {
      task: "T11a3",
      what: "界面设备最小管理（入网、批准、撤销）",
      artifact: "packages/ui/src/features/im/ImDevices.tsx",
    },
    { task: "T16a3", what: "Web 设备最小管理" },
  ],
  steps: [
    "桌面端走一遍入网→批准→撤销，逐步截图",
    "Web 端走同一遍流程，逐步截图",
    "两处都能看到指纹核对与状态变化，撤销后入口与状态一致",
  ],
  run: (tools: ImCaseTools) => {
    const root = mkdtempSync(join(tmpdir(), "im-e2e-m1-13-"));
    const db = openHarnessDatabase(join(root, "m1-13.db"));
    try {
      migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
      const now = 1_700_000_000_000;
      const host = new ImHostApi(db, "s", {}, createImIdentity());
      tools.check("入网前设备列表为空", host.listDevices("m").items.length === 0);
      const challenge = host.enrollBegin("m", { deviceName: "iphone", publicKey: "pk-iphone", now });
      tools.check(
        "入网给出挑战：配对码 + 指纹（供人工核对）",
        challenge.pairingCode.length > 0 && challenge.fingerprint.length > 0,
        `code=${challenge.pairingCode} fp=${challenge.fingerprint}`,
      );
      tools.check(
        "入网后状态是待批准（不是直接 active）",
        host.enrollStatus("m", { deviceId: challenge.deviceId }).state !== "active",
        host.enrollStatus("m", { deviceId: challenge.deviceId }).state,
      );
      tools.check(
        "对照：错配对码批准被拒",
        rejects(() =>
          host.enrollApprove("m", { deviceId: challenge.deviceId, pairingCode: "0000-0000", now: now + 1 }),
        ) !== "",
      );
      const approved = host.enrollApprove("m", {
        deviceId: challenge.deviceId,
        pairingCode: challenge.pairingCode,
        now: now + 2_000,
      });
      tools.check("批准后转 active", approved.state === "active", approved.state);
      tools.check(
        "列表里看得到该设备",
        host.listDevices("m").items.some((item) => item.deviceId === challenge.deviceId),
      );
      const revoked = host.deviceRevoke("m", { deviceId: challenge.deviceId, now: now + 4_000 });
      tools.check("撤销后转 revoked", revoked.state === "revoked", revoked.state);
      tools.check(
        "撤销后列表状态一致（入口与状态不打架）",
        host.listDevices("m").items.every((item) => item.state === "revoked"),
        host
          .listDevices("m")
          .items.map((item) => item.state)
          .join(","),
      );
      tools.check(
        "对照：撤销后凭旧码再批不复活（enrollApprove 对非 pending 是无操作，status 仍是 revoked）",
        host.enrollApprove("m", {
          deviceId: challenge.deviceId,
          pairingCode: challenge.pairingCode,
          now: now + 6_000,
        }).state === "revoked",
      );
      tools.note(
        "桌面/Web 的逐步截图属界面证据：前端本轮已附 5 张（im-t17-device-enroll / device-approved / device-revoked 等），走的是预览 mock。mock 的 enrollBegin 回固定码、enrollApprove 不校验也不清码，所以「单次使用 + TTL」两条由 M1-11 的后端断言佐证；本用例验真路由背后的语义（入网→核对指纹→批准→撤销）",
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
});

gate.case({
  id: "M1-14",
  title: "A13 设备用户流程证据（移动端）",
  acceptance: "A13（用户流程）",
  refs: ["design §10 A13", "plan §3 T11a3/T17a3 验收"],
  needs: [
    { task: "T11a3", what: "界面设备最小管理", artifact: "packages/ui/src/features/im/ImDevices.tsx" },
    { task: "T17a3", what: "移动端设备最小管理" },
  ],
  steps: [
    "移动端走一遍入网→批准→撤销，逐步截图",
    "截图带「移动端无局域网发现」的例外说明（产品例外）",
    "状态与桌面端一致",
  ],
  run: (tools: ImCaseTools) => {
    tools.hold(
      "只剩移动端截图没出：`im-devices-v1` 的 6 条 route 本轮已实现（route-im.ts 已接 devicesList/enrollBegin/enrollApprove/enrollStatus/enrollCancel/deviceRevoke），后端流程语义已由 M1-13 的 9 项断言覆盖（真路由背后的入网→核对指纹→批准→撤销）。卡的是**移动端构建工具链**（Xcode 26.6 Swift 编译器崩在 react-native-keyboard-controller），M1-14 的移动端截图出不来，继续冻结",
    );
  },
});

gate.case({
  id: "M1-15",
  title: "局域网未送达→保留草稿→上线自动重发，全程无假状态",
  acceptance: "A9",
  refs: ["design §10 A9", "plan §5 A9", "plan §3 T7 验收"],
  needs: [{ task: "T7", what: "mDNS 发现 + WebRTC 直连 + TURN 兜底" }],
  steps: [
    "对方离线时通过局域网发送，界面显示「未送达，保留草稿」",
    "全程不得出现假的「已排队」「已送达」",
    "对方上线后自动重发成功，也可手动重发本地草稿",
    "连接前必须校验指纹，mDNS 只作提示不做信任依据",
  ],
  run: async (tools: ImCaseTools) => {
    const root = mkdtempSync(join(tmpdir(), "im-e2e-m1-15-"));
    const db = openHarnessDatabase(join(root, "m1-15.db"));
    try {
      migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
      const now = 1_700_000_000_000;
      db.prepare(
        "INSERT INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("s", "m", "thread-1", "peer-a", "agent-1", "open");
      const messages = new ImMessageStore(db);
      const delivered: string[] = [];
      const outbox = new ImLanOutbox(db, "s", (input) => {
        delivered.push(input.deliveryId);
      });
      const seed = (localMessageId: string, deliveryId: string, body: string) => {
        messages.insertMessage({
          localServerId: "s",
          localMemberId: "m",
          localMessageId,
          threadId: "thread-1",
          remoteMessageId: `rm-${localMessageId}`,
          peerServerId: "peer-a",
          peerAgentId: "agent-1",
          senderKind: "self",
          senderAgentId: null,
          deviceId: null,
          body,
          causalChainId: null,
          proxiedBy: null,
          proxyVisibility: null,
          nonce: `nonce-${localMessageId}`,
          signature: "",
          verified: false,
          sentAt: now,
          expiresAt: now + 86_400_000,
        });
        messages.insertDelivery({
          localServerId: "s",
          localMemberId: "m",
          deliveryId,
          localMessageId,
          peerServerId: "peer-a",
          peerAgentId: "agent-1",
          createdAt: now,
        });
      };

      seed("lm-1", "d-1", "undelivered-body");
      const draft = await outbox.markUndelivered("m", { deliveryId: "d-1", at: now + 1000 });
      tools.check(
        "未送达态：state=failed、原因可读、attempts 记上",
        draft !== null && draft.error === IM_LAN_PEER_OFFLINE && draft.attempts === 1,
        `error=${String(draft?.error)} attempts=${String(draft?.attempts)}`,
      );
      tools.check(
        "记了下次重试时间（读回可见，30s 退避）",
        outbox.drafts("m").find((entry) => entry.deliveryId === "d-1")?.nextRetryAt === now + 1000 + 30_000,
        `读回=${String(outbox.drafts("m").find((entry) => entry.deliveryId === "d-1")?.nextRetryAt)}`,
      );
      tools.check(
        "缺陷：markUndelivered 的返回值应带 nextRetryAt（现在返回更新前快照，恒 null）",
        draft !== null && draft.nextRetryAt !== null,
        `返回值=${String(draft?.nextRetryAt)}｜读回=${String(outbox.drafts("m").find((entry) => entry.deliveryId === "d-1")?.nextRetryAt)}`,
      );
      tools.check(
        "全程不假报已发：状态停在 failed，不是 persisted/acked",
        messages.readDelivery("d-1")?.state === "failed",
        String(messages.readDelivery("d-1")?.state),
      );
      tools.check(
        "草稿保留：未送达那条留在待发队列，正文/线程/对端都在",
        (() => {
          const list = outbox.drafts("m");
          const item = list.find((entry) => entry.deliveryId === "d-1");
          return (
            item !== undefined &&
            item.body === "undelivered-body" &&
            item.threadId === "thread-1" &&
            item.peerServerId === "peer-a"
          );
        })(),
      );
      tools.check(
        "对照：草稿只留未送达的（没把已发的也塞进待发区）",
        outbox.drafts("m").every((entry) => entry.error !== null),
        outbox
          .drafts("m")
          .map((entry) => entry.deliveryId)
          .join(","),
      );

      seed("lm-2", "d-2", "retry-body");
      await outbox.markUndelivered("m", { deliveryId: "d-2", at: now + 2000 });
      await outbox.markUndelivered("m", { deliveryId: "d-2", at: now + 3000 });
      tools.check(
        "连续失败仍在队列（attempts 累加、原因更新、不丢不静默）",
        (() => {
          const item = outbox.drafts("m").find((entry) => entry.deliveryId === "d-2");
          return item !== undefined && item.attempts === 2 && item.error !== null;
        })(),
        `attempts=${String(outbox.drafts("m").find((entry) => entry.deliveryId === "d-2")?.attempts)}`,
      );

      const resent = await outbox.resend("m", { deliveryId: "d-1", at: now + 4000 });
      tools.check(
        "手动重发成功并推进状态机 failed → persisted",
        resent.outcome === "delivered" && resent.state === "persisted" && delivered.includes("d-1"),
        `${resent.outcome}/${resent.state}`,
      );
      tools.check(
        "对照：已送达的不重发（skipped-delivered，状态与次数都不动）",
        (await outbox.resend("m", { deliveryId: "d-1", at: now + 5000 })).outcome === "skipped-delivered",
      );
      tools.check(
        "状态机不可逆：已送达不能再标回未送达（ImDeliveryDelivered）",
        (await rejectsAsync(() => outbox.markUndelivered("m", { deliveryId: "d-1", at: now + 6000 }))) ===
          "im.notResendable",
      );

      seed("lm-3", "d-3", "withdrawn-body");
      await outbox.markUndelivered("m", { deliveryId: "d-3", at: now + 7000 });
      new ImWithdrawService(db, "s").withdraw("m", {
        threadId: "thread-1",
        localMessageId: "lm-3",
        at: now + 8000,
      });
      const withdrawn = await outbox.resend("m", { deliveryId: "d-3", at: now + 9000 });
      tools.check(
        "对照：已撤回的不重发（skipped-withdrawn，草稿退掉）",
        withdrawn.outcome === "skipped-withdrawn" && outbox.drafts("m").every((entry) => entry.deliveryId !== "d-3"),
        `${withdrawn.outcome} drafts=${outbox
          .drafts("m")
          .map((entry) => entry.deliveryId)
          .join(",")}`,
      );

      seed("lm-4", "d-4", "honest-body");
      await outbox.markUndelivered("m", { deliveryId: "d-4", at: now + 10_000 });
      const withdraw = new ImWithdrawService(db, "s");
      const scene = withdraw.withdraw("m", { threadId: "thread-1", localMessageId: "lm-4", at: now + 11_000 });
      tools.check(
        "诚实面（重点）：撤回未送达的消息判为 lan-undelivered，不谎称已通知收件人",
        scene.scene === "lan-undelivered",
        `scene=${scene.scene}`,
      );

      seed("lm-5", "d-5", "online-body");
      messages.setDeliveryState("d-5", "persisted", now + 12_000);
      const onlineScene = new ImWithdrawService(db, "s").withdraw("m", {
        threadId: "thread-1",
        localMessageId: "lm-5",
        at: now + 13_000,
      });
      tools.check(
        "对照：已送达的撤回判为 online（不是 lan-undelivered）",
        onlineScene.scene === "online",
        `scene=${onlineScene.scene}`,
      );

      seed("lm-6", "d-6", "auto-body");
      await outbox.markUndelivered("m", { deliveryId: "d-6", at: now + 14_000 });
      const auto = await outbox.onPeerOnline({ peerServerId: "peer-a", peerAgentId: "agent-1", at: now + 15_000 });
      tools.check(
        "对方上线自动重发成功（不需手调）",
        auto.some((item) => item.deliveryId === "d-6" && item.outcome === "delivered"),
        auto.map((item) => `${item.deliveryId}:${item.outcome}`).join(","),
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
});

gate.case({
  id: "M1-16",
  title: "fail-closed：未知字段整体拒",
  acceptance: "T1b 契约（fail-closed）",
  refs: ["plan §3 T1b 验收", "design §6.4/§6.8 fail-closed", "packages/contracts/src/ipc-im.ts strictObject"],
  needs: [{ task: "T1b", what: "正式 schema + fail-closed decoder", artifact: "packages/contracts/src/ipc-im.ts" }],
  steps: [
    "取一条合法的 IM message，先断言能解出",
    "各处塞一个协议里不存在的字段（顶层、消息体、附件内）",
    "每一处都必须整体抛错，不得忽略未知字段继续",
    "对照：去掉未知字段后恢复正常解出",
  ],
  run: (tools) => {
    const base = validMessage();
    tools.check("合法消息可解出", rejects(() => decodeImMessage(base)) === "");
    tools.check("消息顶层未知字段整体拒", rejects(() => decodeImMessage({ ...base, smuggled: 1 })) !== "");
    tools.check(
      "附件内未知字段整体拒",
      rejects(() => decodeImMessage({ ...base, attachments: [{ name: "a", digest: "d", size: 1, smuggled: 3 }] })) !==
        "",
    );
    tools.check(
      "发送请求侧未知字段整体拒",
      rejects(() =>
        parseImSendMessage({
          threadId: "thread-1",
          remoteMessageId: "remote-1",
          body: "hello",
          attachments: [],
          replyTo: null,
          proxiedBy: null,
          proxyVisibility: null,
          smuggled: 1,
        }),
      ) !== "",
    );
    tools.check(
      "分页结构未知字段整体拒",
      rejects(() => decodeImMessages({ items: [base], next: null, smuggled: 1 })) !== "",
    );
    tools.check("去掉未知字段后恢复可解", rejects(() => decodeImMessage(base)) === "");
  },
});

gate.case({
  id: "M1-17",
  title: "fail-closed：缺字段拒",
  acceptance: "T1b 契约（fail-closed）",
  refs: ["plan §3 T1b 验收", "design §6.4"],
  needs: [{ task: "T1b", what: "正式 schema + fail-closed decoder", artifact: "packages/contracts/src/ipc-im.ts" }],
  steps: ["逐个删掉必填字段（localMessageId/body/verified 等）", "每次都整体抛错", "可选字段删掉不算缺字段，仍能解出"],
  run: (tools) => {
    for (const field of ["localMessageId", "remoteMessageId", "body", "attachments", "sentAt", "verified"] as const) {
      tools.check(`缺字段 ${field} 整体拒`, rejects(() => decodeImMessage(withoutMessageField(field))) !== "");
    }
    const optional: Partial<ImMessage> = { ...validMessage() };
    delete optional.replyTo;
    delete optional.proxiedBy;
    delete optional.causalChainId;
    tools.check("可选字段缺失仍可解出", rejects(() => decodeImMessage(optional)) === "");
  },
});

gate.case({
  id: "M1-18",
  title: "fail-closed：类型不符拒",
  acceptance: "T1b 契约（fail-closed）",
  refs: ["plan §3 T1b 验收"],
  needs: [{ task: "T1b", what: "类型约束 decoder", artifact: "packages/contracts/src/ipc-im.ts" }],
  steps: [
    "把 body 由字符串换成数字、verified 由布尔换成字符串、sentAt 由数字换成字符串、attachments 由数组换成对象",
    "每种类型不符都整体抛错",
  ],
  run: (tools) => {
    const cases: ReadonlyArray<readonly [string, () => void]> = [
      ["body 数字", () => decodeImMessage({ ...validMessage(), body: 123 })],
      ["verified 字符串", () => decodeImMessage({ ...validMessage(), verified: "yes" })],
      ["sentAt 字符串", () => decodeImMessage({ ...validMessage(), sentAt: "2026-11-21" })],
      ["attachments 对象", () => decodeImMessage({ ...validMessage(), attachments: { name: "a" } })],
      ["localMessageId 空串", () => decodeImMessage({ ...validMessage(), localMessageId: "" })],
    ];
    for (const [label, work] of cases) tools.check(`${label} 整体拒`, rejects(work) !== "");
  },
});

gate.case({
  id: "M1-19",
  title: "fail-closed：枚举越界拒",
  acceptance: "T1b 契约（fail-closed）",
  refs: ["plan §3 T1b 验收", "design §6.4"],
  needs: [{ task: "T1b", what: "闭合枚举 decoder", artifact: "packages/contracts/src/ipc-im.ts" }],
  steps: [
    "senderKind 给闭合枚举之外的值",
    "deliveryState 给闭合枚举之外的值",
    "proxyVisibility 给闭合枚举之外的值",
    "三者都整体抛错，不做兜底映射",
  ],
  run: (tools) => {
    tools.check(
      "senderKind 越界整体拒",
      rejects(() => decodeImMessage({ ...validMessage(), senderKind: "hacker" })) !== "",
    );
    tools.check("senderKind 空串整体拒", rejects(() => decodeImMessage({ ...validMessage(), senderKind: "" })) !== "");
    tools.check(
      "deliveryState 越界整体拒",
      rejects(() => decodeImDelivery({ ...validDelivery(), state: "delivered" })) !== "",
    );
    tools.check(
      "proxyVisibility 越界整体拒",
      rejects(() => decodeImMessage({ ...validMessage(), proxyVisibility: "invisible" })) !== "",
    );
    tools.check("合法枚举值仍可解出", rejects(() => decodeImMessage(validMessage())) === "");
  },
});

gate.case({
  id: "M1-20",
  title: "fail-closed：附件内未知字段与超长拒",
  acceptance: "T1b 契约（fail-closed）",
  refs: ["plan §3 T1b 验收", "design §6.4 附件独立加密并绑定 attachmentsDigest"],
  needs: [{ task: "T1b", what: "附件 decoder 严格字段集", artifact: "packages/contracts/src/ipc-im.ts" }],
  steps: [
    "附件里带协议外字段（如 srcPath、url）",
    "附件缺 name/digest/size 任一项",
    "附件 name 超过 255 或 digest 超过 128",
    "四种都整体拒，附件不得借字段夹带本地路径",
  ],
  run: (tools) => {
    const cases: ReadonlyArray<readonly [string, () => void]> = [
      [
        "附件内未知字段 srcPath 整体拒",
        () =>
          decodeImMessage({
            ...validMessage(),
            attachments: [{ name: "a", digest: "d", size: 1, srcPath: "/etc/passwd" }],
          }),
      ],
      [
        "附件夹带 url 整体拒",
        () =>
          decodeImMessage({ ...validMessage(), attachments: [{ name: "a", digest: "d", size: 1, url: "https://x" }] }),
      ],
      ["附件缺 digest 整体拒", () => decodeImMessage({ ...validMessage(), attachments: [{ name: "a", size: 1 }] })],
      [
        "附件 name 超长整体拒",
        () => decodeImMessage({ ...validMessage(), attachments: [{ name: "a".repeat(256), digest: "d", size: 1 }] }),
      ],
      [
        "附件 digest 超长整体拒",
        () => decodeImMessage({ ...validMessage(), attachments: [{ name: "a", digest: "d".repeat(129), size: 1 }] }),
      ],
    ];
    for (const [label, work] of cases) tools.check(label, rejects(work) !== "");
    tools.check(
      "合法附件可解出",
      rejects(() => decodeImMessage({ ...validMessage(), attachments: [{ name: "a", digest: "d", size: 1 }] })) === "",
    );
  },
});

gate.case({
  id: "M1-21",
  title: "错误码基线：im.protocolError / im.versionIncompatible 在公共码里",
  acceptance: "T1b 契约（错误码基线）",
  refs: ["plan §3 T1b 验收", "design §10 A16c"],
  needs: [{ task: "T1b", what: "公共错误码基线 + 37 条具体码", artifact: "packages/contracts/src/ipc-im.ts" }],
  steps: [
    "公共错误码恰为 5 条：unauthorized/rateLimited/protocolError/versionIncompatible/notFound",
    "断言 im.protocolError 与 im.versionIncompatible 在内",
    "具体码 37 条，与公共码不重叠",
    "ImError 是两层的并集",
  ],
  run: (tools) => {
    tools.check("公共错误码 5 条", IM_ERROR_CODES.length === 5, IM_ERROR_CODES.join(","));
    tools.check("im.protocolError 在基线内", IM_ERROR_CODES.includes("im.protocolError"));
    tools.check("im.versionIncompatible 在基线内", IM_ERROR_CODES.includes("im.versionIncompatible"));
    tools.check("具体错误码条数与契约一致", IM_SPECIFIC_ERROR_CODES.length === 37, `${IM_SPECIFIC_ERROR_CODES.length}`);
    const publicCodes = IM_ERROR_CODES.map((code) => String(code));
    const overlap = IM_SPECIFIC_ERROR_CODES.filter((code) => publicCodes.includes(String(code)));
    tools.check("公共码与具体码不重叠", overlap.length === 0, overlap.join(","));
    tools.check(
      "具体码全部带 im. 前缀",
      IM_SPECIFIC_ERROR_CODES.every((code) => code.startsWith("im.")),
    );
    tools.note(
      "基线变动留痕：35 → 37，是 PM 指示补的两个码 im.peerOffline / im.messageWithdrawn（前端点出它们不在清单里、日后 error 收窄成枚举会炸）。属合法契约追加，非漂移；基线数字固定是为了抓未授权的增删",
    );
    tools.note("decode 失败到 im.protocolError 的映射在 M1-26 单独实测");
  },
});

gate.case({
  id: "M1-22",
  title: "FromHost 与 FromMain 两族独立",
  acceptance: "T1b 契约（decoder 两族独立）",
  refs: ["plan §3 T1b 验收", "plan 红线 3"],
  needs: [
    { task: "T1b", what: "FromHost 12 / FromMain 22 独立 decoder 族", artifact: "packages/contracts/src/ipc-im.ts" },
  ],
  steps: [
    "FromHost 族 12 个 decoder，FromMain 族 22 个",
    "收件箱/联系人/拉黑/举报/代聊/通知/搜索/审计/频道是 main 族专属，host 族不得解这些形状",
    "presence 是 host 族专属",
    "两族共有的形状解码结果一致",
  ],
  run: (tools) => {
    const hostKeys = Object.keys(imFromHost).sort();
    const mainKeys = Object.keys(imFromMain).sort();
    tools.check("FromHost 族 12 个 decoder", hostKeys.length === 12, hostKeys.join(","));
    tools.check("FromMain 族 22 个 decoder", mainKeys.length === 22, mainKeys.join(","));
    const mainOnlyNames = [
      "auditEntries",
      "blockRule",
      "blockRules",
      "channelMember",
      "contact",
      "contacts",
      "notificationSettings",
      "proxySettings",
      "report",
      "reports",
      "searchResults",
    ];
    const mainOnly = mainKeys.filter((key) => !hostKeys.includes(key));
    tools.check(
      "main 族专属恰好是收件箱/联系人/拉黑/举报/代聊/通知/搜索/审计/频道这 11 个",
      mainOnly.join(",") === mainOnlyNames.join(","),
      mainOnly.join(","),
    );
    tools.check(
      "host 族解不了 main 族专属形状",
      mainOnlyNames.every((key) => !hostKeys.includes(key)),
    );
    const hostOnly = hostKeys.filter((key) => !mainKeys.includes(key));
    tools.check("host 族专属 presence 不在 main 族", hostOnly.join(",") === "presence", hostOnly.join(","));
    const shared = hostKeys.filter((key) => mainKeys.includes(key));
    tools.check("两族共有 11 个形状", shared.length === 11, shared.join(","));
    tools.check(
      "host 族没有 main 族专属 decoder 的入口",
      mainOnlyNames.every((key) => !Object.hasOwn(imFromHost, key)),
    );
    tools.check(
      "共有形状在两族都可解出",
      rejects(() => imFromHost.message(validMessage())) === "" &&
        rejects(() => imFromMain.message(validMessage())) === "",
    );
    tools.check(
      "共有形状在两族下的拒收行为一致",
      rejects(() => imFromHost.message({ ...validMessage(), smuggled: 1 })) !== "" &&
        rejects(() => imFromMain.message({ ...validMessage(), smuggled: 1 })) !== "",
    );
    const pagePayload = { items: [validMessage()], next: null };
    tools.check(
      "共有形状 messages 分页在两族下行为一致",
      rejects(() => imFromHost.messages(pagePayload)) === "" &&
        rejects(() => imFromMain.messages(pagePayload)) === "" &&
        rejects(() => imFromHost.messages({ ...pagePayload, smuggled: 1 })) !== "" &&
        rejects(() => imFromMain.messages({ ...pagePayload, smuggled: 1 })) !== "",
    );
    tools.check(
      "共有形状 device 在两族下行为一致",
      rejects(() => imFromHost.device(validDevice())) === "" &&
        rejects(() => imFromMain.device(validDevice())) === "" &&
        rejects(() => imFromHost.device({ ...validDevice(), smuggled: 1 })) !== "" &&
        rejects(() => imFromMain.device({ ...validDevice(), smuggled: 1 })) !== "",
    );
  },
});

gate.case({
  id: "M1-23",
  title: "ACK 批次：空批次与超 200 拒，200 为边界",
  acceptance: "T1b 契约（限额）",
  refs: ["plan §3 T1b 验收", "IM_LIMITS.ackBatch", "plan §3 T4b1（A8 主验收归 T14d2）"],
  needs: [{ task: "T1b", what: "IM_LIMITS 与批次校验", artifact: "packages/contracts/src/ipc-im.ts" }],
  steps: [
    "messageIds 为空数组 → 整体拒",
    "messageIds 201 条 → 整体拒",
    "messageIds 200 条 → 通过（边界含）",
    "messageIds 1 条 → 通过",
  ],
  run: (tools) => {
    const ack = (count: number) => ({
      threadId: "thread-1",
      messageIds: Array.from({ length: count }, (_, index) => `m${index}`),
    });
    tools.check("空批次整体拒", rejects(() => parseImAck(ack(0))) !== "");
    tools.check("超 200 整体拒", rejects(() => parseImAck(ack(201))) !== "");
    tools.check("200 条为边界可通过", rejects(() => parseImAck(ack(200))) === "");
    tools.check("1 条可通过", rejects(() => parseImAck(ack(1))) === "");
    tools.check("ackBatch 上限确为 200", IM_LIMITS.ackBatch === 200, `${IM_LIMITS.ackBatch}`);
  },
});

gate.case({
  id: "M1-24",
  title: "代聊预算越界拒，0 与 1000 为边界",
  acceptance: "T1b 契约（限额）",
  refs: ["plan §3 T1b 验收", "IM_LIMITS.monthlyBudgetUsd", "design §10 A15（A15 主验收归 T14d1）"],
  needs: [{ task: "T1b", what: "代聊预算上下限校验", artifact: "packages/contracts/src/ipc-im.ts" }],
  steps: [
    "monthlyBudgetUsd 超上限（1001）→ 整体拒",
    "monthlyBudgetUsd 为负（-1）→ 整体拒",
    "monthlyBudgetUsd 为 0 与 1000 → 通过（含边界）",
    "断言上限确为 1000",
  ],
  run: (tools) => {
    const proxy = (monthlyBudgetUsd: number) => ({ enabled: true, visibility: "shown", monthlyBudgetUsd });
    tools.check("预算超上限整体拒", rejects(() => parseImProxySet(proxy(1001))) !== "");
    tools.check("预算为负整体拒", rejects(() => parseImProxySet(proxy(-1))) !== "");
    tools.check("预算 0 为边界可通过", rejects(() => parseImProxySet(proxy(0))) === "");
    tools.check("预算 1000 为边界可通过", rejects(() => parseImProxySet(proxy(1000))) === "");
    tools.check(
      "monthlyBudgetUsd 上限确为 1000",
      IM_LIMITS.monthlyBudgetUsd === 1_000,
      `${IM_LIMITS.monthlyBudgetUsd}`,
    );
  },
});

gate.case({
  id: "M1-25",
  title: "四步信任边界顺序：sender 先于 decode、授权先于执行",
  acceptance: "T1b 契约（四步信任边界）",
  refs: ["plan 红线 3", "src/main/ipc/im-handlers.ts imHandler", "src/main/trusted-ipc.ts handleTrusted"],
  needs: [{ task: "T1b", what: "imHandler 四步信任边界封装", artifact: "src/main/ipc/im-handlers.ts" }],
  steps: [
    "把 Electron 的 ipcMain 换成观测替身（真实 IPC 边界要 Electron 运行时，属 T18a1 接线），其余走真实 handleTrusted + imHandler",
    "不可信 senderFrame.url：整体拒，且 decode 都没被调用",
    "可信 sender：顺序必须是 decode → authorize → execute",
    "authorize 抛 im.unauthorized：execute 不跑",
    "decode 抛错：authorize 与 execute 都不跑（fail-closed 在授权之前）",
  ],
  run: async (tools) => {
    installImElectronStub();
    const { ImUnauthorized, imHandler } = await import("../src/main/ipc/im-handlers");
    const order: string[] = [];
    const trustedEvent = { senderFrame: { url: "openbot-app://app/index.html" } };
    const request = { serverId: "server-1", payload: {} };

    const happy = imHandler(
      (value) => {
        order.push("decode");
        return value;
      },
      {
        authorize: () => {
          order.push("authorize");
        },
        execute: () => {
          order.push("execute");
          return "ok";
        },
      },
      () => ({ localServerId: "server-1", localMemberId: "member-1" }),
    );
    happy("im:e2e-trust-happy");
    const happyListener = imIpcListeners.get("im:e2e-trust-happy");
    tools.check("imHandler 经真实 handleTrusted 注册成功", happyListener !== undefined);
    if (!happyListener) return;
    order.length = 0;
    const result = await happyListener(trustedEvent, request);
    tools.check(
      "可信 sender 下按 decode → authorize → execute 顺序执行",
      order.join(" → ") === "decode → authorize → execute",
      order.join(" → "),
    );
    tools.check("执行结果返回", result === "ok");

    order.length = 0;
    const untrusted = ["https://evil.example/", "file:///etc/passwd", "openbot-app://other/", "not a url", ""];
    const rejected = untrusted.filter((url) => {
      try {
        return happyListener({ senderFrame: { url } }, request) === undefined && false;
      } catch {
        return true;
      }
    });
    tools.record(
      "逐个不可信 sender 全部被拒",
      rejected.length === untrusted.length,
      `${rejected.length}/${untrusted.length}`,
    );
    let nullSenderRejected = false;
    try {
      happyListener({ senderFrame: null }, request);
    } catch {
      nullSenderRejected = true;
    }
    tools.record("senderFrame 为空同样被拒", nullSenderRejected);
    tools.check("sender 校验先于 decode：被拒时 decode 一次都没跑", order.length === 0, order.join(" → ") || "(空)");

    order.length = 0;
    const denied = imHandler(
      (value) => {
        order.push("decode");
        return value;
      },
      {
        authorize: () => {
          order.push("authorize");
          throw new ImUnauthorized();
        },
        execute: () => {
          order.push("execute");
          return "ok";
        },
      },
      () => ({ localServerId: "server-1", localMemberId: "member-1" }),
    );
    denied("im:e2e-trust-denied");
    const deniedListener = imIpcListeners.get("im:e2e-trust-denied");
    if (!deniedListener) return;
    let deniedMessage = "";
    try {
      await deniedListener(trustedEvent, request);
    } catch (error) {
      deniedMessage = error instanceof Error ? error.message : String(error);
    }
    tools.check("授权先于执行：授权抛错时 execute 不跑", order.join(" → ") === "decode → authorize", order.join(" → "));
    tools.check("授权失败返回 im.unauthorized", deniedMessage === "im.unauthorized", deniedMessage);

    order.length = 0;
    const malformed = imHandler(
      () => {
        order.push("decode");
        throw new Error("Invalid IM payload.");
      },
      {
        authorize: () => {
          order.push("authorize");
        },
        execute: () => {
          order.push("execute");
          return "ok";
        },
      },
      () => ({ localServerId: "server-1", localMemberId: "member-1" }),
    );
    malformed("im:e2e-trust-malformed");
    const malformedListener = imIpcListeners.get("im:e2e-trust-malformed");
    if (!malformedListener) return;
    let malformedThrew = false;
    try {
      await malformedListener(trustedEvent, request);
    } catch {
      malformedThrew = true;
    }
    tools.check("decode 失败即整体拒", malformedThrew);
    tools.check("decode 失败后授权与执行都不跑", order.join(" → ") === "decode", order.join(" → "));
  },
});

gate.case({
  id: "M1-26",
  title: "fail-closed 拒绝映射到 im.protocolError",
  acceptance: "T1b 契约（错误码映射）",
  refs: ["design §10 A16c", "plan §3 T1b 验收", "packages/contracts/src/ipc-im.ts ImProtocolError"],
  needs: [
    { task: "T1b", what: "decode 失败路径映射到 im.protocolError", artifact: "packages/contracts/src/ipc-im.ts" },
  ],
  steps: [
    "各类 fail-closed 拒绝（未知字段/缺字段/类型不符/枚举越界/附件内未知字段）逐个触发",
    "断言抛出的是 ImProtocolError 且 code 为 im.protocolError",
    "断言该 code 在 IM_ERROR_CODES 基线里",
    "断言与非协议错误可区分（不是裸 Error）",
  ],
  run: (tools) => {
    const unknownField = protocolErrorCode(() => decodeImMessage({ ...validMessage(), smuggled: 1 }));
    const missingField = protocolErrorCode(() => decodeImMessage(withoutMessageField("body")));
    const typeMismatch = protocolErrorCode(() => decodeImMessage({ ...validMessage(), body: 123 }));
    const enumOutOfRange = protocolErrorCode(() => decodeImMessage({ ...validMessage(), senderKind: "hacker" }));
    const attachmentUnknown = protocolErrorCode(() =>
      decodeImMessage({
        ...validMessage(),
        attachments: [{ name: "a", digest: "d", size: 1, srcPath: "/etc/passwd" }],
      }),
    );
    tools.check("未知字段拒映射到 im.protocolError", unknownField === "im.protocolError", unknownField);
    tools.check("缺字段拒映射到 im.protocolError", missingField === "im.protocolError", missingField);
    tools.check("类型不符拒映射到 im.protocolError", typeMismatch === "im.protocolError", typeMismatch);
    tools.check("枚举越界拒映射到 im.protocolError", enumOutOfRange === "im.protocolError", enumOutOfRange);
    tools.check("附件内未知字段拒映射到 im.protocolError", attachmentUnknown === "im.protocolError", attachmentUnknown);
    tools.check("im.protocolError 在错误码基线里", IM_ERROR_CODES.includes("im.protocolError"));
    tools.check(
      "限额拒绝同样映射到 im.protocolError",
      protocolErrorCode(() => parseImAck({ threadId: "t", messageIds: [] })) === "im.protocolError",
    );
    tools.check(
      "拒绝信息仍带可读标签（不是空串）",
      protocolErrorLabel(() => decodeImMessage({ ...validMessage(), smuggled: 1 })).startsWith("Invalid "),
      protocolErrorLabel(() => decodeImMessage({ ...validMessage(), smuggled: 1 })),
    );
  },
});

gate.case({
  id: "M1-27",
  title: "mock-im 投递读回：get / list / forMessage 与状态流转",
  acceptance: "T1b 契约（mock 投递读回）",
  refs: ["plan §3 T1b 验收", "plan §4 mock 落点", "src/renderer/src/preview/mock-im.ts"],
  needs: [{ task: "T1b", what: "mock-im delivery 读回接口", artifact: "src/renderer/src/preview/mock-im.ts" }],
  steps: [
    "发送一条消息，断言返回 submitted",
    "delivery.get 读回同一条投递",
    "ack 之后 delivery.forMessage 读回为 acked 且带 ackedAt",
    "delivery.list 按线程列出",
    "resend 后回到 submitted 且 attempts 加一",
    "查不到的投递返回 null / 抛 im.notFound",
  ],
  run: async (tools) => {
    const mock = createMockIm();
    const sent = await mock.messages.send("thread-1", "remote-1", "hello");
    tools.check("send 返回 submitted", sent.delivery.state === "submitted", sent.delivery.state);
    const read = await mock.delivery.get(sent.delivery.deliveryId);
    tools.check("delivery.get 读回同一条", read.deliveryId === sent.delivery.deliveryId && read.state === "submitted");
    await mock.delivery.ack([sent.message.localMessageId]);
    const acked = await mock.delivery.forMessage(sent.message.localMessageId);
    tools.check("ack 后 forMessage 读回 acked", acked?.state === "acked", acked?.state ?? "null");
    tools.check("acked 带 ackedAt", acked?.ackedAt !== null && acked?.ackedAt !== undefined);
    const listed = await mock.delivery.list("thread-1");
    tools.check("delivery.list 按线程列出", listed.items.length === 1, `${listed.items.length}`);
    const resent = await mock.delivery.resend(sent.delivery.deliveryId);
    tools.check("resend 回到 submitted", resent.state === "submitted", resent.state);
    tools.check("resend 使 attempts 加一", resent.attempts === 2, `${resent.attempts}`);
    tools.check("查不到的投递返回 null", (await mock.delivery.forMessage("no-such-message")) === null);
    let missing = "";
    try {
      await mock.delivery.get("no-such-delivery");
    } catch (error) {
      missing = error instanceof Error ? error.message : String(error);
    }
    tools.check("查不到的 delivery.get 抛 im.notFound", missing === "im.notFound", missing);
  },
});

gate.case({
  id: "M1-28",
  title: "两台物理机器真互发文本并可回看（需两台物理机器）",
  acceptance: "A5（互发与回看·真机出口）",
  refs: ["design §10 A5", "plan §2 P0-M1 出口原文「两台机器能互发」"],
  needs: [{ task: "T7", what: "两台物理机器互发（同机双进程不作数）" }],
  steps: [
    "两台物理机器（不同主机、不同网卡）各起一个实例",
    "经真实网络（非回环）互发文本一条",
    "对端能回看，内容与发出一致",
    "同机双进程的结果只作等价证据归档，不充当本条出口判据",
  ],
  run: (tools: ImCaseTools) => {
    tools.hold(
      "需两台物理机器。M1 出口原文是「两台机器能互发文本并可回看」，不接受同机双进程替代（同机结果只归档 evidence/im-m1/equivalent-evidence.md，不充出口判据）。【前置清单·已解 4 项】①mDNS A 记录改真实网卡（实测 192.168.3.72）②设备密钥改从 peers_devices 读 ③7 格断言覆盖面补齐（含不核对不建链对照、封包解开、互收逐字比对、回看读回）④信令客户端接线（signalRelay 走 remote(toServerId, IM_ROUTES.lanSignal, …)）。【仍缺 4 项】①跨网段/NAT 未验②TURN 兜底未实测③接口陷阱收口（remote_message_id 列名与语义不符、sealed_payload 编码口径、discord/slack/signal 三个 wrapper 的同类命名）④两台物理机器跑一次。【等价证据现状】同机双进程真互发 10/10（我独立复跑）——证明实现链路，不是两台机器",
    );
  },
});

const report = await gate.run();
process.exitCode = report.counts.fail > 0 ? 1 : 0;
