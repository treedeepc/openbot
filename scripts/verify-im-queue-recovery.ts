import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { CausalChain } from "../src/backend/im/causal-chain";
import * as gate from "../src/backend/im/causal-chain";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { maybeAt, record, text } from "./verify-im-helpers";

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "im-queue-recovery-"));
const userData = join(root, "user-data");
const shared = join(root, "shared");
await mkdirp(userData);
await mkdirp(shared);
async function mkdirp(path: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
}

const database = new OpenBotDatabase(userData);
await runCauseEffect(database.initialize());
const mailbox = new MailboxStore(userData, shared, database);
await runCauseEffect(mailbox.initialize());

const externalChain: CausalChain = {
  chainId: "chain-external-1",
  rootMessageId: "m-1",
  trustDomain: "im-peer",
  createdAt: Date.now(),
};

const receipt = await runCauseEffect(
  mailbox.enqueue({
    sender: { kind: "user" },
    recipientAgentIds: ["agent-worker"],
    text: "derived from external input",
    channelId: "channel-1",
    causalChainId: externalChain.chainId,
    idempotencyKey: "queue-recovery-1",
  }),
);
const deliveryId = maybeAt(receipt.deliveries, 0)?.id ?? "";
check("队列里写入了因果链", deliveryId !== "", deliveryId.slice(0, 8));

const before = record(
  database.connection.prepare("SELECT delivery_json FROM projection_deliveries WHERE delivery_id = ?").get(deliveryId),
);
const beforeChain = JSON.parse(text(before.delivery_json)).causalChainId ?? null;
check("因果链落到持久化投递记录", beforeChain === externalChain.chainId, String(beforeChain));

database.close();
const reopened = new OpenBotDatabase(userData);
await runCauseEffect(reopened.initialize());
const mailboxAfter = new MailboxStore(userData, shared, reopened);
await runCauseEffect(mailboxAfter.initialize());

const after = reopened.connection
  .prepare("SELECT delivery_json FROM projection_deliveries WHERE delivery_id = ?")
  .get(deliveryId);
const afterChain = after ? (JSON.parse(text(after.delivery_json)).causalChainId ?? null) : undefined;
check("重启后队列恢复、因果链仍在", afterChain === externalChain.chainId, String(afterChain));

gate.sharedCausalThreads.bind("thread-external", externalChain);
const decisionAfterRestart = gate.causalChainForThread("thread-external");
check("重启后闸门仍读到外部链", decisionAfterRestart?.trustDomain === "im-peer", JSON.stringify(decisionAfterRestart));
check("重启后工具仍禁用", gate.authorizeToolCall(decisionAfterRestart).toolsEnabled === false, "");
check("重启后缺声明仍默认拒绝", gate.authorizeToolCall(undefined).allowed === false, "");

const derived = gate.sharedCausalChains.derive(externalChain, "chain-external-2", Date.now());
check(
  "恢复后派生仍继承外部链",
  derived.trustDomain === "im-peer" && derived.rootMessageId === "m-1",
  JSON.stringify(derived),
);
check("恢复后派生仍禁工具", gate.authorizeToolCall(derived).toolsEnabled === false, "");

const local: CausalChain = {
  chainId: "chain-local-1",
  rootMessageId: "m-2",
  trustDomain: "local",
  createdAt: Date.now(),
};
const localChild = gate.sharedCausalChains.derive(local, "chain-local-2", Date.now());
check("本地派生不受影响", gate.authorizeToolCall(localChild).toolsEnabled === true, JSON.stringify(localChild));

reopened.close();
await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
