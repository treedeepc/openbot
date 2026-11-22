import { spawn } from "node:child_process";
import { resolve } from "node:path";

const PEER = resolve(import.meta.dirname, "im-tcp-peer.ts");

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

function spawnPeer(role: string, port: number, mode = "clean"): { ready: Promise<void>; done: Promise<string> } {
  const child = spawn("bun", [PEER, role, String(port), mode], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  let markReady = (): void => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const done = new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      if (out.includes("ready")) markReady();
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("exit", () => resolve(out.trim() || err.trim()));
    child.on("error", reject);
    setTimeout(() => child.kill(), 15_000);
  });
  return { ready, done };
}

async function exchange(port: number, mode = "clean"): Promise<[string, string]> {
  const serverRun = spawnPeer("server", port, mode);
  await serverRun.ready;
  const clientRun = spawnPeer("client", port);
  return Promise.all([serverRun.done, clientRun.done]);
}

const port = 47_831;
const [serverOut, clientOut] = await exchange(port);
const server = JSON.parse(serverOut.split("\n").at(-1) ?? "{}");
const client = JSON.parse(clientOut.split("\n").at(-1) ?? "{}");

check(
  "T7b 真实网络路径：两进程各起一个库实例",
  server.role === "server" && client.role === "client",
  `${server.role}/${client.role}`,
);
check("T7b 真实网络路径：客户端经 TCP 发出帧", client.acked === true, JSON.stringify(client));
check(
  "T7b 真实网络路径：服务端收到并入队",
  server.received === 1 && server.dbRows.n === 1,
  JSON.stringify(server.dbRows),
);
check(
  "T7b 真实网络路径：密文经网络后未变",
  client.sealed === "ciphertext-tcp-1" && client.nonce === "tcp-1",
  client.sealed,
);
check(
  "T7b 真实网络路径：两进程库互不串（客户端队列为空）",
  client.localQueue.n === 0,
  JSON.stringify(client.localQueue),
);
check("T7b 真实网络路径：回执带回收到的密文", client.sealed.startsWith("ciphertext-"), client.sealed);

const tamperPort = 47_832;
const [tamperServerOut, tamperClientOut] = await exchange(tamperPort, "tamper");
const tamperServer = JSON.parse(tamperServerOut.split("\n").at(-1) ?? "{}");
const tamperClient = JSON.parse(tamperClientOut.split("\n").at(-1) ?? "{}");
check(
  "对照：链路上被篡改（多塞字段）的帧在服务端解码处被拒",
  tamperServer.dbRows?.n === 0 && tamperClient.acked !== true,
  JSON.stringify({ server: tamperServer, client: tamperClient }),
);

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed`);
if (failed.length > 0) process.exitCode = 1;
