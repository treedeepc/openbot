import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { maybeAt } from "./verify-im-helpers";

const REPO = resolve(import.meta.dirname, "..");
const artifact = maybeAt(process.argv, 2) ?? join(REPO, "dist/OpenBot-0.75.0-arm64.zip");

const checks: { name: string; ok: unknown }[] = [];
const check = (name: string, ok: unknown, detail = ""): void => {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

function run(command: string, args: string[]): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("exit", (code) => resolve({ out: out.trim(), code }));
    setTimeout(() => child.kill(), 120_000);
  });
}

const info = await stat(artifact);
check("打包产物存在", info.size > 0, `${artifact} (${info.size} bytes, mtime ${info.mtime.toISOString()})`);

const root = await mkdtemp(join(tmpdir(), "im-pack-probe-"));
const unzip = await run("unzip", ["-q", artifact, "-d", root]);
check("产物可解包", unzip.code === 0, unzip.out.slice(0, 120));

const resources = join(root, "OpenBot.app/Contents/Resources/app.asar");
const markers = [
  "im/lan-channel",
  "im/wire",
  "im/relay",
  "0074-im-read-receipt",
  "openbot-im-envelope-v1",
  "im.relay.enable",
];
const found = [];
for (const marker of markers) {
  const probe = await run("grep", ["-qa", marker, resources]);
  if (probe.code === 0) found.push(marker);
}
check(
  "产物含本轮 IM 模块与迁移",
  found.length === markers.length,
  `命中 ${found.length}/${markers.length}: ${found.join(",") || "无"}`,
);

const binary = join(root, "OpenBot.app/Contents/MacOS/OpenBot");
const launch = await run(binary, ["--version"]);
check(
  "打包产物二进制可启动",
  launch.out.length > 0 || launch.code === 0,
  `${launch.out.slice(0, 80)} (exit ${launch.code})`,
);

if (found.length < markers.length) {
  process.stdout.write(
    `\n结论：该产物构建于 ${info.mtime.toISOString()}，不含本轮 IM 代码，探针只能验「产物可解包/可启动」。\n`,
  );
  process.stdout.write(`要对新 IM 代码跑打包产物探针，需要一次新的打包（按仓库惯例走 CI），再用同一条命令跑本脚本。\n`);
}

await rm(root, { recursive: true, force: true });
const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
