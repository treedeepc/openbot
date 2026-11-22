import { spawnSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const SOURCE = "src/backend/agent-memory-site-migration.test.ts";
const COPY = "src/backend/zz-im-drift-probe.test.ts";

const drifts: { name: string; kind: string; from: string; to: string }[] = [
  {
    name: "版本号漂移",
    kind: "版本号",
    from: "toEqual({ version: 75 })",
    to: "toEqual({ version: 74 })",
  },
  {
    name: "表清单漂移",
    kind: "表清单",
    from: "im_relay_settings: [],",
    to: "",
  },
  {
    name: "列 sentinel 漂移",
    kind: "列",
    from: 'toContain("site")',
    to: 'toContain("__site_drifted__")',
  },
];

function run(label: string): number {
  const result = spawnSync("bunx", ["vitest", "run", COPY], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(`${label} EXIT=${result.status}\n`);
  return result.status ?? -1;
}

copyFileSync(resolve(REPO, SOURCE), resolve(REPO, COPY));
const baseline = run("【基线】未注入漂移");

const rows: { name: string; kind: string; caught: string }[] = [];
for (const drift of drifts) {
  copyFileSync(resolve(REPO, SOURCE), resolve(REPO, COPY));
  const original = (await Bun.file(resolve(REPO, COPY)).text()).replace(drift.from, drift.to);
  if (original === (await Bun.file(resolve(REPO, COPY)).text())) {
    rows.push({ name: drift.name, kind: drift.kind, caught: "注入点没匹配上（探针无效）" });
    continue;
  }
  await Bun.write(resolve(REPO, COPY), original);
  const code = run(`【${drift.name}】`);
  rows.push({
    name: drift.name,
    kind: drift.kind,
    caught: code === 0 ? "抓不住（断言未红）" : "抓得住（断言红）",
  });
}

rmSync(resolve(REPO, COPY), { force: true });

process.stdout.write(`\n基线 EXIT=${baseline}（须为 0，否则探针本身不成立）\n`);
for (const row of rows) process.stdout.write(`${row.kind}｜${row.name}｜${row.caught}\n`);
process.stdout.write(`\n副本已删除：${COPY}\n`);
