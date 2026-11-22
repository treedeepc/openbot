import type { ServerCompatibility, ServerSummary } from "@openbot/contracts/ipc";
import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import { IM_MESSAGES_CAPABILITY, IM_PEERS_CAPABILITY } from "@openbot/contracts/team-protocol/im-v1";
import { imEntryAvailable, imEntrySupportFor } from "@openbot/team-client/im-client";
import type { RemoteServerConnectionStatus } from "../src/main/remote-server-connection-status";
import type { StoredRemoteServerView } from "../src/main/remote-server-store";
import { remoteServerSummaries } from "../src/main/remote-server-summaries";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
};

function statusOf(compatibility: ServerCompatibility | null): RemoteServerConnectionStatus {
  return {
    state: "online",
    compatibility,
    issue: null,
    connectionSequence: 1,
    capabilitiesPending: false,
    hostRestart: null,
    hostedSleep: null,
    hostedIssue: null,
    hostedStart: null,
  };
}

function compatibilityOf(capabilities: readonly string[]): ServerCompatibility {
  return {
    localAppVersion: "0.75.0",
    hostAppVersion: "0.75.0",
    localProtocol: { minimum: 1, maximum: 10 },
    hostProtocol: { minimum: 1, maximum: 10 },
    negotiatedProtocol: 10,
    capabilities: [...capabilities],
  };
}

function storedServer(id: string): StoredRemoteServerView {
  return {
    id,
    name: id,
    apiUrl: `https://${id}.example`,
    fingerprint: "AAAA-BBBB",
    username: "user",
    encryptedToken: "token",
    remoteDesktopAvailable: false,
    role: "member",
  };
}

const remoteWithoutIm = storedServer("srv-no-im");
const remoteWithIm = storedServer("srv-with-im");
const statuses = new Map<string, RemoteServerConnectionStatus>([
  [remoteWithoutIm.id, statusOf(compatibilityOf(["agent-tasks-v1"]))],
  [remoteWithIm.id, statusOf(compatibilityOf([IM_PEERS_CAPABILITY, IM_MESSAGES_CAPABILITY]))],
]);

const summaries: ServerSummary[] = remoteServerSummaries(
  [remoteWithoutIm, remoteWithIm],
  LOCAL_SERVER_ID,
  (serverId) => statuses.get(serverId) ?? statusOf(null),
);

function summaryOf(id: string): ServerSummary {
  const found = summaries.find((server) => server.id === id);
  if (!found) throw new Error(`missing summary ${id}`);
  return found;
}

function railFormOf(server: ServerSummary): "openIm" | "no-entry" {
  const support = imEntrySupportFor(server);
  return support.session && imEntryAvailable(support) ? "openIm" : "no-entry";
}

const local = summaryOf(LOCAL_SERVER_ID);
check("真实取值路径：本地 summary 由 remoteServerSummaries 产出", local.kind === "local", local.kind);
check(
  "真实取值路径：本地 compatibility 仍是 null（没伪造握手）",
  local.compatibility === null,
  JSON.stringify(local.compatibility),
);

process.stdout.write("\n== 对照 1：本地实例有 IM 能力 → 入口出现 ==\n");
const localSupport = imEntrySupportFor(local);
check(
  "对照1 本地实例 session 判真（IM 入口渲染的那一条）",
  localSupport.session === true,
  JSON.stringify(localSupport),
);
check("对照1 本地实例入口动作是 openIm，不是 hidden", railFormOf(local) === "openIm", railFormOf(local));
check(
  "对照1 本地实例四段齐（收件箱/联系人/会话/设备）",
  localSupport.inbox && localSupport.contacts && localSupport.session && localSupport.devices,
  JSON.stringify(localSupport),
);

process.stdout.write("\n== 对照 2：远程实例没声明 im-* → 不提供可用入口（两种形态都合规）==\n");
const noIm = summaryOf(remoteWithoutIm.id);
check(
  "对照2 前置：该远程实例确实声明了能力清单",
  (noIm.compatibility?.capabilities.length ?? 0) > 0,
  JSON.stringify(noIm.compatibility?.capabilities),
);
check("对照2 前置：清单里确实没有 im-*", !(noIm.compatibility?.capabilities ?? []).includes(IM_PEERS_CAPABILITY), "");
const noImSupport = imEntrySupportFor(noIm);
check("对照2 远程缺 im-peers/im-messages → session 判否", noImSupport.session === false, JSON.stringify(noImSupport));
check(
  "对照2 解析器判否：没有可用入口（无点击路径）",
  railFormOf(noIm) === "no-entry" && imEntryAvailable(noImSupport) === false,
  JSON.stringify({ form: railFormOf(noIm), available: imEntryAvailable(noImSupport) }),
);
check(
  "对照2 形态合规：不渲染 或 渲染为不可点击的禁用态并说明原因——两种都接受（合规矩阵措辞已修订）",
  railFormOf(noIm) !== "openIm",
  `形态=${railFormOf(noIm)}（渲染层可取「不渲染」或「禁用+说明」两种之一）`,
);
check(
  "对照2 禁用态确实发不出请求：门控谓词为假，按钮不得启用",
  imEntryAvailable(noImSupport) === false && noImSupport.session === false,
  JSON.stringify({ available: imEntryAvailable(noImSupport), session: noImSupport.session }),
);
check(
  "对照2 对照的对照：能力齐备时同一谓词放行（不是判否写死）",
  imEntryAvailable(localSupport) === true && railFormOf(local) === "openIm",
  JSON.stringify({ available: imEntryAvailable(localSupport), form: railFormOf(local) }),
);
check(
  "对照2 七项全否（没被顺手放宽）",
  !noImSupport.inbox &&
    !noImSupport.contacts &&
    !noImSupport.session &&
    !noImSupport.devices &&
    !noImSupport.assign &&
    !noImSupport.block &&
    !noImSupport.report,
  JSON.stringify(noImSupport),
);

process.stdout.write("\n== 对照 3：远程实例声明了 im-* → 入口出现（没矫枉过正）==\n");
const withIm = summaryOf(remoteWithIm.id);
const withImSupport = imEntrySupportFor(withIm);
check("对照3 远程声明 im-* → session 判真", withImSupport.session === true, JSON.stringify(withImSupport));
check("对照3 入口动作是 openIm", railFormOf(withIm) === "openIm", railFormOf(withIm));

process.stdout.write("\n== 对照 4：远程那条门控路径没被改动 ==\n");
check(
  "对照4 远端仍是按声明清单判（没走本机那条豁免）",
  imEntrySupportFor({ kind: "remote", compatibility: null }).session === false,
  "",
);
check(
  "对照4 本机豁免只对 kind=local 生效",
  imEntrySupportFor({ kind: "local", compatibility: null }).session === true,
  "",
);

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
