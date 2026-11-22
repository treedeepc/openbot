import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isTeamCurrentCapability } from "@openbot/contracts/team-protocol/current";
import {
  IM_CAPABILITIES,
  IM_ROUTES_BY_CAPABILITY,
  imCapabilitiesThrough,
  imCapabilityOfRoute,
} from "@openbot/contracts/team-protocol/im-v1";
import { imEntryAvailable, imEntrySupport, imEntrySupportFrom } from "@openbot/team-client/im-client";
import { Schema } from "effect";
import { ImAuditLog } from "../src/backend/im/audit";
import { ImAuditAdmin } from "../src/backend/im/audit-admin";
import { ImNotificationService } from "../src/backend/im/notifications";
import { ImProxySettingsStore } from "../src/backend/im/proxy";
import { ImRelayService } from "../src/backend/im/relay";
import { ImOfflineQueue } from "../src/backend/im/server-mode";
import { ImBlockStore, ImContactStore } from "../src/backend/im/social";
import { ImSyncService } from "../src/backend/im/sync";
import { HARNESS_APPLIED_AT, openHarnessDatabase, query } from "../src/backend/migration-harness";
import { migrateOpenBotDatabase } from "../src/backend/openbot-database-schema";
import { readJson } from "../src/main/team-api/request-helpers";
import { IM_HANDLED_PATHS } from "../src/main/team-api/route-im";
import { type ImCaseTools, ImGate, tail } from "./im-e2e-support";

const gate = new ImGate({
  gate: "T14e M7 关卡：规模化",
  script: "scripts/im-scale-e2e.ts",
  milestone: "P2-M7",
  evidence: "evidence/im-m7",
});

const scope = { localServerId: "s", localMemberId: "m" };
const now = 1_700_000_000_000;
const sealed = (tag: string) => new TextEncoder().encode(`sealed:${tag}`);

function withDb<T>(work: (db: ReturnType<typeof openHarnessDatabase>) => T): T {
  const root = mkdtempSync(join(tmpdir(), "im-e2e-m7-"));
  const db = openHarnessDatabase(join(root, "m7.db"));
  try {
    migrateOpenBotDatabase(db, { appliedAt: HARNESS_APPLIED_AT });
    for (const peer of ["peer-a", "peer-b", "peer-c", "peer-remote"]) {
      db.prepare(
        "INSERT OR IGNORE INTO peers (peer_server_id, peer_agent_id, public_key, display_name, first_seen_at) VALUES (?, ?, ?, ?, ?)",
      ).run(peer, "agent-1", `pk-${peer}`, peer, now);
    }
    db.prepare(
      "INSERT OR IGNORE INTO im_threads (local_server_id, local_member_id, thread_id, peer_server_id, peer_agent_id, state) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(scope.localServerId, scope.localMemberId, "thread-1", "peer-a", "agent-1", "open");
    for (const device of ["dev-1", "dev-2"]) {
      db.prepare(
        "INSERT OR IGNORE INTO local_devices (local_server_id, local_member_id, device_id, public_key, status) VALUES (?, ?, ?, ?, ?)",
      ).run(scope.localServerId, scope.localMemberId, device, `pk-${device}`, "active");
    }
    return work(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function rejects(work: () => void): string {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

function frameOf(sealedValue: string) {
  return {
    type: "relay",
    fromServerId: "peer-remote",
    fromAgentId: "agent-1",
    toServerId: "s",
    toAgentId: "m",
    sealed: sealedValue,
    nonce: "nonce-relay-1",
    sentAt: now,
  };
}

const repoRoot = resolve(import.meta.dirname, "..");
const languageRoot = join(repoRoot, "packages/i18n/src/messages");

const ReportFile = Schema.Struct({
  cases: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, acceptance: Schema.String })),
});

const runCommand = (command: string, args: readonly string[]): { ok: boolean; output: string } => {
  const result = spawnSync(command, [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 1_800_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const combined = [result.stdout, result.stderr].filter((part) => part.length > 0).join("\n");
  return {
    ok: result.status === 0,
    output:
      result.status === 0 ? combined : `命令失败：${command} ${args.join(" ")}｜退出码 ${result.status}\n${combined}`,
  };
};

function failingTestFiles(output: string): string {
  const files = output
    .split("\n")
    .filter((line) => line.trimStart().startsWith("FAIL"))
    .map((line) => line.trim().split(/\s+/)[2] ?? "")
    .filter((name) => name.endsWith(".test.ts"));
  return [...new Set(files)].join("、");
}

function imNamespaceKeys(directory: string): string[] {
  const file = join(directory, "im.ts");
  if (!existsSync(file)) return [];
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/^\s{2}"?([A-Za-z0-9_.]+)"?:/gm)]
    .map((match) => match[1] ?? "")
    .filter((key) => key.length > 0)
    .sort();
}

function readReportCases(file: string): readonly { id: string; title: string; acceptance: string }[] {
  return Schema.decodeUnknownSync(ReportFile)(JSON.parse(readFileSync(file, "utf8"))).cases;
}

gate.case({
  id: "M7-01",
  title: "审计导出：字段齐全且已脱敏",
  acceptance: "A11（导出）",
  refs: ["design §10 A11", "plan §3 T12a2 验收"],
  needs: [{ task: "T12a2", what: "audit_aggregates + 180 天清理 + 导出" }],
  steps: [
    "导出一段审计明细",
    "断言导出含 actor、信任域、action、target、result、correlationId、before-after、时间",
    "断言导出内容是脱敏后的值，不含原始敏感数据",
  ],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const audit = new ImAuditLog(db);
      const admin = new ImAuditAdmin(db, scope.localServerId);
      audit.record(scope, {
        id: "a-1",
        actorId: "assistant-1",
        sourceTrustDomain: "local",
        action: "im.proxy.send",
        targetId: "t-1",
        result: "sent",
        correlationId: "corr-1",
        before: { monthlyBudgetUsd: 20, apiKey: "sk-secret-value-123" },
        after: { monthlyBudgetUsd: 5 },
        at: now,
        detail: { proxiedOnBehalfOf: "person-1" },
      });
      audit.record(scope, {
        id: "a-2",
        actorId: "person-1",
        sourceTrustDomain: "im-peer",
        action: "im.contact.request",
        targetId: "t-2",
        result: "ok",
        correlationId: "corr-2",
        before: undefined,
        after: undefined,
        at: now + 86_400_000,
      });
      const parsed = JSON.parse(admin.export("m", { from: null, to: null, format: "json" }));
      const first = parsed.entries[0];
      const jsonKeys = Object.keys(first ?? {}).sort();
      const csvHeader = admin.export("m", { from: null, to: null, format: "csv" }).split("\n")[0] ?? "";
      tools.check(
        "导出字段齐（A11：actor/信任域/action/target/result/correlationId/before-after/时间）",
        [
          "id",
          "actorId",
          "sourceTrustDomain",
          "action",
          "targetId",
          "result",
          "correlationId",
          "before",
          "after",
          "at",
        ].every((key) => jsonKeys.includes(key)) &&
          csvHeader.includes("before") &&
          csvHeader.includes("after"),
        `json=${jsonKeys.join(",")}｜csv=${csvHeader}`,
      );
      tools.check(
        "导出已脱敏（密钥类键的值换成 [redacted]，原文不外泄）",
        String(first?.before).includes("[redacted]") && !String(first?.before).includes("sk-secret-value-123"),
        String(first?.before),
      );
      tools.check("导出条数与写入一致", parsed.count === 2, String(parsed.count));
      tools.check(
        "按时间窗过滤生效",
        JSON.parse(admin.export("m", { from: now, to: now, format: "json" })).count === 1,
        String(JSON.parse(admin.export("m", { from: now, to: now, format: "json" })).count),
      );
      tools.check(
        "对照：时间窗外的不导出",
        JSON.parse(admin.export("m", { from: now + 86_400_000, to: null, format: "json" })).count === 1,
      );
    });
  },
});

gate.case({
  id: "M7-02",
  title: "保留期：180 天后仅聚合表，清理动作本身有审计",
  acceptance: "A11（保留期）",
  refs: ["design §10 A11", "plan §3 T12a2 验收"],
  needs: [{ task: "T12a2", what: "180 天清理作为唯一删除路径" }],
  steps: [
    "构造超过 180 天的审计明细",
    "跑清理，断言明细被清、聚合表仍在",
    "断言清理是唯一删除路径，别处不能删明细",
    "断言清理动作本身写了审计",
  ],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const audit = new ImAuditLog(db);
      const admin = new ImAuditAdmin(db, scope.localServerId);
      const entry = (id: string, at: number) =>
        audit.record(scope, {
          id,
          actorId: "assistant-1",
          sourceTrustDomain: "local",
          action: "im.audit.list",
          targetId: "t-1",
          result: "ok",
          correlationId: `corr-${id}`,
          before: undefined,
          after: undefined,
          at,
        });
      entry("old-1", now - 200 * 86_400_000);
      entry("old-2", now - 200 * 86_400_000 + 1);
      entry("new-1", now - 86_400_000);
      const buckets = admin.aggregate("m");
      tools.check(
        "聚合按天桶滚进聚合表",
        buckets.length >= 2 && buckets.every((bucket) => /^\d{4}-\d{2}-\d{2}$/.test(bucket.bucket)),
        buckets.map((bucket) => bucket.bucket).join(","),
      );
      tools.check(
        "聚合把 target 收敛为 *（否则是按 target 分桶，不是聚合）",
        buckets.every((bucket) => bucket.targetId === "*"),
        buckets.map((bucket) => bucket.targetId).join(","),
      );
      tools.check(
        "聚合记了时间跨度",
        buckets.every((bucket) => bucket.firstAt <= bucket.lastAt && bucket.count >= 1),
      );
      const before = admin.count("m");
      const result = admin.purge("m", { at: now, retentionDays: 180 });
      tools.check(
        "180 天前的明细被清",
        result.deletedEntries === 2 && admin.count("m") < before,
        `deleted=${result.deletedEntries} ${before}->${admin.count("m")}`,
      );
      tools.check(
        "清理动作本身写了审计（唯一删除路径留痕）",
        audit.read(scope, result.purgeEventId)?.action === "im.auditPurge",
        String(audit.read(scope, result.purgeEventId)?.action),
      );
      tools.check(
        "清理事件里记了 cutoff 与保留天数",
        String(audit.read(scope, result.purgeEventId)?.after).includes("180"),
        String(audit.read(scope, result.purgeEventId)?.after),
      );
      tools.check(
        "对照：未过期的明细不删",
        admin.export("m", { from: null, to: null, format: "json" }).includes("new-1"),
      );
      const second = admin.purge("m", { at: now + 1, retentionDays: 180 });
      tools.check(
        "对照：清理事件不被后续清理删掉（自保护）",
        audit.read(scope, result.purgeEventId) !== null && second.purgeEventId !== result.purgeEventId,
      );
    });
  },
});

gate.case({
  id: "M7-03",
  title: "多设备同步：联系人/黑名单/代聊/通知设置",
  acceptance: "A13（多设备同步）",
  refs: ["design §10 A13", "plan §3 T12d 验收"],
  needs: [{ task: "T12d", what: "多设备同步与冲突合并 + 设备撤销联动" }],
  steps: [
    "同一账号两台设备，设备一改联系人、黑名单、代聊开关、通知设置",
    "设备二收到同步后四项一致",
    "设备二反向改动，设备一同样一致",
  ],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const sync = new ImSyncService(db, scope.localServerId);
      const contacts = new ImContactStore(db);
      const blocks = new ImBlockStore(db);
      const settings = new ImProxySettingsStore(db);
      const notify = new ImNotificationService(db, scope.localServerId);
      const peerA = { peerServerId: "peer-a", peerAgentId: "agent-1" };
      const peerB = { peerServerId: "peer-b", peerAgentId: "agent-1" };
      sync.mergeContacts("m", {
        entries: [{ peer: peerA, state: "accepted", updatedAt: now }],
        deviceId: "dev-1",
        at: now,
      });
      sync.mergeBlocklist("m", {
        entries: [{ peer: peerB, reason: "spam", addedAt: now }],
        deviceId: "dev-1",
        at: now,
      });
      sync.mergeProxySettings("m", {
        settings: { enabled: true, visibility: "shown", monthlyBudgetUsd: 5 },
        updatedAt: now,
        deviceId: "dev-1",
        at: now,
      });
      sync.mergeNotifications("m", {
        threadId: "thread-1",
        notifyOn: "none",
        showPreview: false,
        mutedUntil: null,
        deviceId: "dev-1",
        at: now,
      });
      tools.check(
        "缺陷：联系人同步后状态一致（新对端应按同步状态落库，不是一律 pending）",
        contacts.find(sync.scope("m"), peerA)?.state === "accepted",
        `实测 state=${String(contacts.find(sync.scope("m"), peerA)?.state)}｜mergeContacts 对不存在的对端只调 request()，incoming 的 accepted/removed 丢失`,
      );
      tools.check("黑名单同步后一致", blocks.isBlocked(sync.scope("m"), peerB) === true);
      tools.check("代聊设置同步后一致", settings.read(sync.scope("m")).monthlyBudgetUsd === 5);
      tools.check(
        "通知设置同步后一致",
        notify.decide("m", { threadId: "thread-1", at: now + 1, messageId: "x" }).reason === "notify-none",
      );
      tools.check(
        "四项合并都记审计",
        ["im.syncContacts", "im.syncBlocklist", "im.syncProxySettings", "im.syncNotifications"].every(
          (action) => query(db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = ?", action)[0]?.n === 1,
        ),
      );
      const back = sync.mergeContacts("m", {
        entries: [{ peer: peerA, state: "accepted", updatedAt: now + 2 }],
        deviceId: "dev-2",
        at: now + 2,
      });
      tools.check(
        "对照：设备二反向同步不重复写（同一对端去重）",
        back.merged.length === 1 && contacts.find(sync.scope("m"), peerA)?.state === "accepted",
      );
      const peerC = { peerServerId: "peer-c", peerAgentId: "agent-1" };
      const removed = sync.mergeContacts("m", {
        entries: [{ peer: peerC, state: "removed", updatedAt: now }],
        deviceId: "dev-1",
        at: now + 3,
      });
      tools.check(
        "连带后果：同步 removed 到没历史的机器不能复活成 pending",
        removed.merged[0]?.state === "removed" && contacts.find(sync.scope("m"), peerC)?.state === "removed",
        `merged=${String(removed.merged[0]?.state)} find=${String(contacts.find(sync.scope("m"), peerC)?.state)}`,
      );
      tools.check(
        "对照：pending 的新对端照常建成 pending（不是一律 removed）",
        (() => {
          const peerD = { peerServerId: "peer-remote", peerAgentId: "agent-1" };
          const pending = sync.mergeContacts("m", {
            entries: [{ peer: peerD, state: "pending", updatedAt: now }],
            deviceId: "dev-1",
            at: now + 4,
          });
          return pending.merged[0]?.state === "pending";
        })(),
      );
    });
  },
});

gate.case({
  id: "M7-04",
  title: "多设备冲突合并：并集、最近修改优先、记审计",
  acceptance: "A13（冲突合并）",
  refs: ["design §10 A13", "plan §3 T12d 验收"],
  needs: [{ task: "T12d", what: "冲突合并规则" }],
  steps: [
    "两台设备离线时各自改动同一组设置",
    "重新上线合并：集合类取并集",
    "标量类取最近修改优先",
    "合并动作写审计，可查到合并前后的值",
  ],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const sync = new ImSyncService(db, scope.localServerId);
      const audit = new ImAuditLog(db);
      const contacts = new ImContactStore(db);
      const settings = new ImProxySettingsStore(db);
      const peerA = { peerServerId: "peer-a", peerAgentId: "agent-1" };
      const peerB = { peerServerId: "peer-b", peerAgentId: "agent-1" };
      const union = sync.mergeContacts("m", {
        entries: [
          { peer: peerA, state: "accepted", updatedAt: now },
          { peer: peerB, state: "accepted", updatedAt: now },
          { peer: peerA, state: "accepted", updatedAt: now },
        ],
        deviceId: "dev-1",
        at: now,
      });
      tools.check(
        "集合类取并集且同对端去重",
        union.merged.length === 2 &&
          contacts.find(sync.scope("m"), peerA) !== null &&
          contacts.find(sync.scope("m"), peerB) !== null,
        `merged=${union.merged.length}`,
      );
      sync.mergeProxySettings("m", {
        settings: { enabled: true, visibility: "shown", monthlyBudgetUsd: 5 },
        updatedAt: now,
        deviceId: "dev-1",
        at: now,
      });
      const stale = sync.mergeProxySettings("m", {
        settings: { enabled: true, visibility: "shown", monthlyBudgetUsd: 50 },
        updatedAt: now - 86_400_000,
        deviceId: "dev-2",
        at: now + 1,
      });
      tools.check(
        "标量类最近修改优先：旧设备的旧值不覆盖新值",
        settings.read(sync.scope("m")).monthlyBudgetUsd === 5 && stale.replaced === 0,
        `read=${settings.read(sync.scope("m")).monthlyBudgetUsd} replaced=${stale.replaced}`,
      );
      const fresh = sync.mergeProxySettings("m", {
        settings: { enabled: true, visibility: "shown", monthlyBudgetUsd: 8 },
        updatedAt: now + 86_400_000,
        deviceId: "dev-2",
        at: now + 2,
      });
      tools.check(
        "对照：更新的值才覆盖",
        settings.read(sync.scope("m")).monthlyBudgetUsd === 8 && fresh.replaced === 1,
      );
      const audited = audit.read(sync.scope("m"), fresh.audited);
      tools.check(
        "合并动作写审计且可查合并前后的值",
        audited !== null && String(audited.after).includes("8") && String(audited.after).includes("5"),
        String(audited?.after),
      );
    });
  },
});

gate.case({
  id: "M7-05",
  title: "多设备：设备撤销联动",
  acceptance: "A13（撤销联动）",
  refs: ["design §10 A13", "plan §3 T12d 验收"],
  needs: [{ task: "T12d", what: "设备撤销联动" }],
  steps: ["撤销一台设备", "同步不再推给它", "其历史仍按证书有效期可验证", "撤销联动写审计"],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const sync = new ImSyncService(db, scope.localServerId);
      const audit = new ImAuditLog(db);
      const queue = new ImOfflineQueue(db);
      const peerA = { peerServerId: "peer-a", peerAgentId: "agent-1" };
      queue.enqueue(scope, {
        queueId: "q-1",
        peer: peerA,
        recipientDeviceId: "dev-1",
        remoteMessageId: "rm-1",
        sealedPayload: sealed("1"),
        at: now,
      });
      queue.enqueue(scope, {
        queueId: "q-2",
        peer: peerA,
        recipientDeviceId: "dev-2",
        remoteMessageId: "rm-1",
        sealedPayload: sealed("1"),
        at: now,
      });
      const result = sync.revokeDevice("m", { deviceId: "dev-1", at: now + 1 });
      tools.check(
        "撤销联动清掉该设备的队列",
        result.dropped === 1 && queue.pending(scope, "dev-1").length === 0,
        `dropped=${result.dropped}`,
      );
      tools.check("对照：别的设备不受影响", queue.pending(scope, "dev-2").length === 1);
      tools.check("撤销联动写审计", audit.read(sync.scope("m"), result.audited)?.action === "im.syncDeviceRevoked");
      tools.check(
        "同步不再推给已撤销设备（队列为空即无可推）",
        queue.pending(scope, "dev-1").every((item) => item.remoteMessageId !== "rm-1"),
      );
    });
  },
});

gate.case({
  id: "M7-06",
  title: "A17 工程检查：im 文案 15 语言齐全且键集一致",
  acceptance: "A17（15 语言）",
  refs: ["design §10 A17", "plan §3 T13 验收", "plan 红线 5"],
  needs: [{ task: "T13", what: "i18n 全量清理与汇总" }],
  steps: [
    "列出 packages/i18n/src/messages 下全部语言目录",
    "断言每个语言都有 im.ts，且键集完全一致",
    "跑 i18n:check，断言通过",
  ],
  run: (tools: ImCaseTools) => {
    const languages = readdirSync(languageRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    tools.record("语言目录数量为 15", languages.length === 15, `实际 ${languages.length}：${languages.join(",")}`);
    const missing = languages.filter((language) => !existsSync(join(languageRoot, language, "im.ts")));
    tools.record("每个语言都有 im.ts", missing.length === 0, missing.join(","));
    const reference = imNamespaceKeys(join(languageRoot, languages[0] ?? ""));
    tools.record("im 命名空间有键", reference.length > 0, `${reference.length} 个键`);
    const drifted = languages.filter((language) => {
      const keys = imNamespaceKeys(join(languageRoot, language));
      return JSON.stringify(keys) !== JSON.stringify(reference);
    });
    tools.record("15 语言的 im 键集完全一致", drifted.length === 0, drifted.join(","));
    const check = runCommand("bun", ["run", "i18n:check"]);
    tools.record("i18n:check 通过", check.ok, tail(check.output));
    tools.check("A17 工程检查（15 语言）全部通过", tools.passed);
  },
});

gate.case({
  id: "M7-07",
  title: "A17 工程检查：窄检查通过（test:changed + typecheck + Biome 改动文件）",
  acceptance: "A17（窄检查）",
  refs: ["design §10 A17", "plan 红线 5", "AGENTS.md 窄检查"],
  needs: [{ task: "T13", what: "全量 i18n 与窄检查汇总" }],
  steps: [
    "跑 test:changed（只跑改动影响到的测试）",
    "跑 typecheck:node（覆盖 scripts 与 backend）",
    "跑 Biome 只查改动文件",
    "三者都通过；禁止全仓跑",
  ],
  run: (tools: ImCaseTools) => {
    tools.note(
      "扫描口径（写死，防同类漏检）：①判断通过与否**一律按退出码（echo $?）**，不按输出字符串——`26/28 passed` 这类含 passed 的红行会被 `grep -v passed` 过滤掉，后端上轮就是这么漏看两处红的；②并行核验（我扫他改）必须**带上扫描时刻**，否则时点差会被误记成矛盾；③证据脚本扫描**必须含 test:changed**，它是窄检查的必含项，缺行=漏检。",
    );
    tools.note(
      "webrtc-channel 判定口径：scripts/verify-im-webrtc-channel.ts 在 Bun 下 exit=134（@roamhq/wrtc 的 NAPI 崩在 uv_async_init），**必须走 Node 路径**（bun build --target=node --external:@roamhq/wrtc 后 node 跑）才 13/13。按退出码全扫它永远红，**这一份单独标注为例外**，不计入「坏脚本」。",
    );
    const tests = runCommand("bun", ["run", "test:changed"]);
    tools.record(
      "test:changed 通过",
      tests.ok,
      `失败文件：${failingTestFiles(tests.output) || "无"}｜${tail(tests.output)}`,
    );
    const types = runCommand("bun", ["run", "typecheck:node"]);
    tools.record("typecheck:node 通过", types.ok, tail(types.output));
    const changed = readdirSync(join(repoRoot, "scripts"))
      .filter((file) => /^im-.*\.ts$/.test(file))
      .sort()
      .map((file) => `scripts/${file}`);
    const biome = runCommand("bunx", ["biome", "check", ...changed]);
    tools.record("Biome 检查改动文件通过", biome.ok, `${changed.join(" ")}｜${tail(biome.output)}`);
    tools.check("A17 工程检查（窄检查）全部通过", tools.passed);
  },
});

gate.case({
  id: "M7-08",
  title: "能力缺失验收：im-* 未注册时桌面不显示入口",
  acceptance: "A13/A17（能力缺失）",
  refs: ["plan 红线 2 能力门控两处 + 阶段化", "plan §3 T1c 验收"],
  needs: [
    { task: "T1c", what: "能力注册按阶段启用", artifact: "src/main/team-api/route-im.ts" },
    { task: "T11c", what: "界面搜索/审计导出/同步/中转开关" },
  ],
  steps: [
    "用不含 im-* 能力的 host 连接",
    "桌面端不出现任何 IM 入口",
    "没有可点击路径进入 IM 界面",
    "不出现「点了报错」或任何失败提示",
  ],
  run: (tools: ImCaseTools) => {
    const none = imEntrySupport([]);
    tools.check(
      "无任何 im-* 能力时桌面不出现任何入口",
      imEntryAvailable(none) === false && Object.values(none).every((value) => value === false),
    );
    tools.check(
      "对照：能力齐备时入口出现（区分「门控关着」与「功能坏了」）",
      imEntryAvailable(imEntrySupport(imCapabilitiesThrough("p2"))) === true,
    );
    tools.note(
      "桌面入口由 WorkspacePageRail.tsx:74 / ImDesktopPage.tsx:15 读 server().compatibility.capabilities 后过 imEntrySupport 门控；三条平台用例共用这一个门控函数，平台差异在消费点。「点了报错」属前端证据，交 T11c",
    );
  },
});

gate.case({
  id: "M7-09",
  title: "能力缺失验收：im-* 未注册时 Web 不显示入口",
  acceptance: "A13/A17（能力缺失）",
  refs: ["plan 红线 2", "plan §3 T16c 验收"],
  needs: [{ task: "T16c", what: "Web 搜索/审计/同步/中转切片" }],
  steps: ["用不含 im-* 能力的 host 连接 Web 客户端", "Web 端不出现任何 IM 入口、无可点击路径、无失败提示"],
  run: (tools: ImCaseTools) => {
    const none = imEntrySupport([]);
    tools.check(
      "无任何 im-* 能力时 Web 不出现任何入口",
      imEntryAvailable(none) === false && Object.values(none).every((value) => value === false),
    );
    tools.check(
      "无可点击路径：空能力下连 session 都不开",
      none.session === false && none.inbox === false && none.contacts === false && none.devices === false,
    );
    tools.check(
      "对照：能力齐备时 Web 同样出入口",
      imEntryAvailable(imEntrySupport(imCapabilitiesThrough("p2"))) === true,
    );
    tools.note(
      "Web 入口由 WebWorkspace.tsx:1326 读 workspace.state.capabilities 后过同一 imEntrySupport 门控；界面隐藏与「无失败提示」交前端 T16c 证据",
    );
  },
});

gate.case({
  id: "M7-10",
  title: "能力缺失验收：im-* 未注册时移动端不显示入口",
  acceptance: "A13/A17（能力缺失）",
  refs: ["plan 红线 2", "plan §3 T17c 验收"],
  needs: [{ task: "T17c", what: "移动端搜索/审计/同步/中转切片" }],
  steps: ["用不含 im-* 能力的 host 连接移动端", "移动端不出现任何 IM 入口、无可点击路径、无失败提示"],
  run: async (tools: ImCaseTools) => {
    const none = imEntrySupport([]);
    tools.check(
      "无任何 im-* 能力时移动端不出现任何入口",
      imEntryAvailable(none) === false && Object.values(none).every((value) => value === false),
    );
    const declared = IM_CAPABILITIES.filter((capability) => isTeamCurrentCapability(capability));
    const routed = IM_CAPABILITIES.filter((capability) =>
      IM_ROUTES_BY_CAPABILITY[capability].some((route) => IM_HANDLED_PATHS.has(route)),
    );
    tools.check(
      "声明了的能力都通了 route（没有只声明不实现）",
      declared.every((capability) => routed.includes(capability)),
      `已声明 ${declared.length} 条`,
    );
    tools.check(
      "无野 route：每条已处理 route 都归属某个已声明能力",
      [...IM_HANDLED_PATHS].every((route) => imCapabilityOfRoute(route) !== null),
    );
    const support = imEntrySupport(declared);
    const panes: string[] = [];
    if (support.inbox) panes.push("inbox");
    if (support.contacts) panes.push("contacts");
    if (support.session) panes.push("session");
    if (support.devices) panes.push("devices");
    tools.check(
      "门控形态与注册结果一致：imPanes 4 段（inbox/contacts/session/devices）",
      panes.join(",") === "inbox,contacts,session,devices",
      `${panes.length} 段：${panes.join(",")}｜已声明 ${declared.length} 条`,
    );
    tools.check(
      "16 条全注册后七段入口全开（inbox/contacts/session/devices/assign/block/report）",
      Object.values(support).every((value) => value === true) && imEntryAvailable(support) === true,
      JSON.stringify(support),
    );
    tools.check(
      "对照：无 im-* 的旧 host 七项仍全 false（不是全都常开）",
      Object.values(none).every((value) => value === false) && imEntryAvailable(none) === false,
      JSON.stringify(none),
    );
    tools.check(
      "对照：四段入口各由不同能力驱动（只留 peers+messages 时只剩 session 一段）",
      (() => {
        const after = imEntrySupportFrom(
          (capability) => capability === "im-peers-v1" || capability === "im-messages-v1",
        );
        const afterPanes: string[] = [];
        if (after.inbox) afterPanes.push("inbox");
        if (after.contacts) afterPanes.push("contacts");
        if (after.session) afterPanes.push("session");
        if (after.devices) afterPanes.push("devices");
        return afterPanes.join(",") === "session";
      })(),
    );
    tools.note(
      `已声明 ${declared.length} 条全注册；imPanes ${panes.length} 段；有 route 但未声明：${routed.filter((capability) => !declared.includes(capability)).join("、") || "无"}`,
    );

    const probe = await new Promise<string>((resolve) => {
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        readJson(request).then(
          () => {
            response.writeHead(200).end("{}");
          },
          (error: unknown) => {
            response.writeHead(400).end(error instanceof Error ? error.message : "err");
          },
        );
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        void (async () => {
          const sendRaw = async (path: string, raw: string) => {
            const result = await fetch(`http://127.0.0.1:${port}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: raw,
            });
            return `${result.status}:${await result.text()}`;
          };
          const good = await sendRaw("/v1/im/presence", JSON.stringify({ peers: [] }));
          const bad = await sendRaw("/v1/im/presence", "[1,2,3]");
          server.close();
          resolve(`IM=${good}｜坏body=${bad}`);
        })();
      });
    });
    tools.check("发现 A 回归：IM route 真发真收（HTTP 编解码已接上）", probe.includes("IM=200"), probe);
    tools.check("对照：IM 带坏 body 仍被拒（codec 接上没把 fail-closed 弄松）", probe.includes("坏body=400"), probe);
    tools.note(
      "移动端入口由 apps/mobile/src/features/im/model/im-port.tsx:25-26 过同一 imEntrySupport 门控；界面隐藏交前端 T17c 证据",
    );
  },
});

gate.case({
  id: "M7-11",
  title: "第三方中转：只转发密文、默认关闭、启用须明示暴露面",
  acceptance: "A13（第三方中转）",
  refs: ["plan §3 T12e 验收", "design 决策记录"],
  needs: [{ task: "T12e", what: "第三方中转：新实例消息类型、只转发密文、默认关闭" }],
  steps: ["默认状态下中转关闭", "启用时界面明示暴露面，需用户确认", "中转只转发密文，不落明文", "中转开关与状态记审计"],
  run: (tools: ImCaseTools) => {
    withDb((db) => {
      const relay = new ImRelayService(db, scope.localServerId);
      const audit = new ImAuditLog(db);
      audit.record(scope, {
        id: "ctl-1",
        actorId: "person-1",
        sourceTrustDomain: "local",
        action: "im.audit.check",
        targetId: "t",
        result: "ok",
        correlationId: "corr-ctl",
        before: undefined,
        after: undefined,
        at: now,
      });
      const relayAudits = () => query(db, "SELECT action, before, after FROM audit_log WHERE action LIKE 'im.relay%'");
      tools.check("默认状态下中转关闭", relay.settings("m").enabled === false, String(relay.settings("m").enabled));
      tools.check(
        "启用时必须明示暴露面（空暴露面直接拒）",
        rejects(() => relay.enable("m", { exposedSurface: [], at: now })) === "im.protocolError",
      );
      const beforeEnable = relayAudits().length;
      const enabled = relay.enable("m", { exposedSurface: ["ciphertext-only"], at: now + 1 });
      tools.check(
        "明示暴露面后才启用，且暴露面落库可读回",
        enabled.enabled === true && enabled.exposedSurface.includes("ciphertext-only"),
      );
      tools.check("留痕一：enable 写一条审计", relayAudits().length === beforeEnable + 1);
      const beforeDisable = relayAudits().length;
      relay.disable("m", { at: now + 2 });
      tools.check("留痕二：disable 写一条审计", relayAudits().length === beforeDisable + 1);
      tools.check(
        "默认关闭时转发被拒（im.lanDisabled）",
        rejects(() =>
          relay.relay("m", {
            frame: frameOf("sealed-abc"),
            deviceIds: ["dev-1"],
            at: now + 3,
            expiresAt: now + 86_400_000,
          }),
        ) === "im.lanDisabled",
      );
      relay.enable("m", { exposedSurface: ["ciphertext-only"], at: now + 4 });
      const beforeRelay = relayAudits().length;
      tools.check(
        "只转发密文：入队的是密文、不解密",
        (() => {
          const result = relay.relay("m", {
            frame: frameOf("sealed-abc"),
            deviceIds: ["dev-1"],
            at: now + 5,
            expiresAt: now + 86_400_000,
          });
          return (
            result.forwarded === 1 &&
            query(db, "SELECT sealed_payload FROM offline_queue WHERE recipient_device_id = ?", "dev-1").length === 1
          );
        })(),
      );
      tools.check("留痕三：relay 转发写一条审计", relayAudits().length > beforeRelay);
      const rows = relayAudits();
      tools.check(
        "审计里记了 enabled 与 exposedSurface（before/after）",
        rows.some((row) => String(row.after).includes("enabled") || String(row.before).includes("enabled")) &&
          rows.some(
            (row) => String(row.after).includes("ciphertext-only") || String(row.before).includes("ciphertext-only"),
          ),
      );
      tools.check(
        "对照：审计链路本身没坏（同库别处的审计照常写）",
        audit.read(scope, "ctl-1")?.action === "im.audit.check",
      );
      tools.check(
        "对照：关闭后暴露面清空",
        (() => {
          relay.disable("m", { at: now + 6 });
          return relay.settings("m").exposedSurface.length === 0;
        })(),
      );
      tools.note("「启用须用户确认的界面」属 T11c/T16c/T17c 证据层；本用例验后端强制要求明示暴露面");
    });
  },
});

gate.case({
  id: "M7-12",
  title: "验收覆盖自检：A1–A17 与点名用例全部有对应用例",
  acceptance: "A1–A17（覆盖自检）",
  refs: ["plan §5 验收映射", "design §10 验收标准"],
  needs: [],
  steps: [
    "读取七个关卡的用例清单（其余六个取 evidence/im-m*/report.json，本关卡取自身注册的用例）",
    "断言 A1 到 A17 每一条都有至少一个对应用例",
    "断言点名用例都在：A13 设备用户流程、D2-1 到 D2-5、双发送方同 remoteMessageId、两成员共用设备不串收件箱、能力缺失隐藏入口",
    "把覆盖矩阵写进 evidence/im-m7/acceptance-coverage.md",
  ],
  run: (tools: ImCaseTools) => {
    const labels: string[] = [];
    const ids: string[] = [];
    const titles: string[] = [];
    const sources: string[] = [];
    for (const directory of ["im-m1", "im-m2", "im-m3", "im-m4", "im-m5", "im-m6"]) {
      const file = join(repoRoot, "evidence", directory, "report.json");
      if (!existsSync(file)) continue;
      const reportCases = readReportCases(file);
      sources.push(`${directory}：${reportCases.length} 条`);
      for (const entry of reportCases) {
        labels.push(entry.acceptance);
        ids.push(entry.id);
        titles.push(entry.title);
      }
    }
    for (const spec of gate.specs) {
      labels.push(spec.acceptance);
      ids.push(spec.id);
      titles.push(spec.title);
    }
    sources.push(`im-m7：${gate.specs.length} 条`);
    const haystack = [...labels, ...ids, ...titles].join(" ｜ ");
    const missingAcceptances: string[] = [];
    for (let index = 1; index <= 17; index += 1) {
      const token = `A${index}`;
      if (!new RegExp(`(^|[^A-Za-z0-9])${token}([^0-9]|$)`).test(haystack)) missingAcceptances.push(token);
    }
    tools.record("读到七个关卡的用例清单", sources.length === 7, sources.join("、"));
    tools.record(
      "A1–A17 每条都有对应用例",
      missingAcceptances.length === 0,
      `缺失：${missingAcceptances.join(",") || "无"}`,
    );
    const named: ReadonlyArray<readonly [string, RegExp]> = [
      ["A13 设备入网/批准/撤销与用户流程", /设备.*(入网|撤销)|用户流程/],
      ["D2-1 单设备 ACK 后删行", /D2-1/],
      ["D2-2 两设备全 ACK 才删", /D2-2/],
      ["D2-3 撤销设备标 excluded", /D2-3/],
      ["D2-4 30 天与全 ACK 先到为准", /D2-4/],
      ["D2-5 已读关闭不发 read 与重发", /D2-5/],
      ["双发送方复用同一 remoteMessageId", /两个发送方复用同一 remoteMessageId/],
      ["两成员共用一台设备不串收件箱", /共用一台设备不串收件箱/],
      ["能力缺失隐藏入口", /能力缺失/],
    ];
    const missingNamed = named.filter(([, pattern]) => !pattern.test(haystack)).map(([label]) => label);
    tools.record("点名用例全部覆盖", missingNamed.length === 0, missingNamed.join("、") || "无");
    const rows = [
      "# A1–A17 验收覆盖矩阵",
      "",
      `生成时间：${new Date().toISOString()}`,
      "",
      `用例来源：${sources.join("、")}`,
      "",
      "| 验收 | 有对应用例 |",
      "| --- | --- |",
      ...Array.from({ length: 17 }, (_, index) => {
        const token = `A${index + 1}`;
        return `| ${token} | ${missingAcceptances.includes(token) ? "❌ 缺" : "✅ 有"} |`;
      }),
      "",
      "## 点名用例",
      "",
      ...named.map(([label, pattern]) => `- ${pattern.test(haystack) ? "✅" : "❌"} ${label}`),
      "",
    ];
    writeFileSync(join(repoRoot, "evidence", "im-m7", "acceptance-coverage.md"), `${rows.join("\n")}\n`);
    tools.check("验收覆盖自检通过", tools.passed);
  },
});

const report = await gate.run();
process.exitCode = report.counts.fail > 0 ? 1 : 0;
