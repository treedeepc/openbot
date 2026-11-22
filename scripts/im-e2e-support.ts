import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export type ImCaseStatus = "pass" | "fail" | "blocked" | "skip";

export interface ImNeed {
  readonly task: string;
  readonly what: string;
  readonly artifact?: string;
}

export interface ImCaseTools {
  readonly passed: boolean;
  check(label: string, ok: boolean, detail?: string): void;
  record(label: string, ok: boolean, detail?: string): void;
  note(text: string): void;
  hold(reason: string): void;
}

export interface ImCaseSpec {
  readonly id: string;
  readonly title: string;
  readonly acceptance: string;
  readonly refs: readonly string[];
  readonly needs: readonly ImNeed[];
  readonly steps: readonly string[];
  readonly run?: (tools: ImCaseTools) => Promise<void> | void;
}

export interface ImNeedResult {
  readonly task: string;
  readonly what: string;
  readonly artifact: string | null;
  readonly ready: boolean;
}

export interface ImCaseResult {
  readonly id: string;
  readonly title: string;
  readonly acceptance: string;
  readonly refs: readonly string[];
  readonly steps: readonly string[];
  readonly status: ImCaseStatus;
  readonly detail: string;
  readonly checks: readonly string[];
  readonly needs: readonly ImNeedResult[];
  readonly durationMs: number;
}

export interface ImGateReport {
  readonly gate: string;
  readonly script: string;
  readonly milestone: string;
  readonly evidence: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly gateClosed: boolean;
  readonly counts: { pass: number; fail: number; blocked: number; skip: number };
  readonly cases: readonly ImCaseResult[];
}

const repoRoot = resolve(import.meta.dirname, "..");

const statusLabel: Record<ImCaseStatus, string> = {
  pass: "通过",
  fail: "失败",
  blocked: "阻塞",
  skip: "跳过",
};

const statusMark: Record<ImCaseStatus, string> = {
  pass: "✅",
  fail: "❌",
  blocked: "⛔",
  skip: "⏭️",
};

export function artifactReady(artifact: string | undefined): boolean {
  return Boolean(artifact) && existsSync(resolve(repoRoot, artifact ?? ""));
}

export class ImGate {
  readonly gate: string;
  readonly script: string;
  readonly milestone: string;
  readonly evidence: string;
  readonly #specs: ImCaseSpec[] = [];

  constructor(init: { gate: string; script: string; milestone: string; evidence: string }) {
    this.gate = init.gate;
    this.script = init.script;
    this.milestone = init.milestone;
    this.evidence = init.evidence;
  }

  case(spec: ImCaseSpec): void {
    this.#specs.push(spec);
  }

  get specs(): readonly ImCaseSpec[] {
    return this.#specs;
  }

  async run(): Promise<ImGateReport> {
    const startedAt = new Date().toISOString();
    const cases: ImCaseResult[] = [];
    for (const spec of this.#specs) cases.push(await runCase(spec));
    const counts = {
      pass: cases.filter((entry) => entry.status === "pass").length,
      fail: cases.filter((entry) => entry.status === "fail").length,
      blocked: cases.filter((entry) => entry.status === "blocked").length,
      skip: cases.filter((entry) => entry.status === "skip").length,
    };
    const report: ImGateReport = {
      gate: this.gate,
      script: this.script,
      milestone: this.milestone,
      evidence: this.evidence,
      startedAt,
      finishedAt: new Date().toISOString(),
      gateClosed: counts.fail === 0 && counts.blocked === 0 && counts.skip === 0 && cases.length > 0,
      counts,
      cases,
    };
    writeEvidence(report);
    printSummary(report);
    return report;
  }
}

async function runCase(spec: ImCaseSpec): Promise<ImCaseResult> {
  const needs: ImNeedResult[] = spec.needs.map((need) => ({
    task: need.task,
    what: need.what,
    artifact: need.artifact ?? null,
    ready: artifactReady(need.artifact),
  }));
  const started = Date.now();
  const base = {
    id: spec.id,
    title: spec.title,
    acceptance: spec.acceptance,
    refs: spec.refs,
    steps: spec.steps,
    needs,
  };
  if (!spec.run) {
    const pending = needs.filter((need) => !need.ready);
    const blockers = (pending.length > 0 ? pending : needs).map((need) => need.task);
    return {
      ...base,
      status: "blocked",
      detail: `断言待前置交付后补写：${blockers.join("、") || "无"}`,
      checks: [],
      durationMs: Date.now() - started,
    };
  }
  const checks: string[] = [];
  const notes: string[] = [];
  const holds: string[] = [];
  const tools: ImCaseTools = {
    get passed() {
      return !checks.some((line) => line.startsWith("失败"));
    },
    check(label, ok, detail) {
      checks.push(`${ok ? "通过" : "失败"}｜${label}${detail ? `｜${detail}` : ""}`);
      if (!ok) throw new Error(`${label}${detail ? `：${detail}` : ""}`);
    },
    record(label, ok, detail) {
      checks.push(`${ok ? "通过" : "失败"}｜${label}${detail ? `｜${detail}` : ""}`);
    },
    note(text) {
      notes.push(text);
    },
    hold(reason) {
      holds.push(reason);
    },
  };
  try {
    await spec.run(tools);
    const failed = checks.filter((line) => line.startsWith("失败"));
    if (failed.length > 0) throw new Error(failed.join("；"));
    const passedCount = checks.filter((line) => line.startsWith("通过")).length;
    if (holds.length > 0) {
      return {
        ...base,
        status: "blocked",
        detail: `${holds.join("；")}｜已跑 ${checks.length} 项断言（${passedCount} 条通过）`,
        checks,
        durationMs: Date.now() - started,
      };
    }
    return {
      ...base,
      status: "pass",
      detail: `${checks.length} 项断言通过${notes.length > 0 ? `；${notes.join("；")}` : ""}`,
      checks,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ...base,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      checks,
      durationMs: Date.now() - started,
    };
  }
}

function writeEvidence(report: ImGateReport): void {
  const out = resolve(repoRoot, report.evidence);
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(out, "cases.md"), casesMarkdown(report));
}

function casesMarkdown(report: ImGateReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.gate} 用例与结果`);
  lines.push("");
  lines.push(`- 脚本：\`${report.script}\``);
  lines.push(`- 里程碑：${report.milestone}`);
  lines.push(`- 证据目录：\`${report.evidence}\``);
  lines.push(`- 跑完时间：${report.finishedAt}`);
  lines.push(`- 关卡关闭：${report.gateClosed ? "是" : "否"}`);
  lines.push(
    `- 计数：通过 ${report.counts.pass} / 失败 ${report.counts.fail} / 阻塞 ${report.counts.blocked} / 跳过 ${report.counts.skip}`,
  );
  lines.push("");
  lines.push("| 用例 ID | 验收 | 标题 | 前置 | 状态 | 说明 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const entry of report.cases) {
    const needs = entry.needs.map((need) => `${need.task}${need.ready ? "" : "（未交付）"}`).join("、") || "—";
    lines.push(
      `| ${entry.id} | ${entry.acceptance} | ${entry.title} | ${needs} | ${statusMark[entry.status]} ${statusLabel[entry.status]} | ${entry.detail} |`,
    );
  }
  const detailed = report.cases;
  if (detailed.length > 0) {
    lines.push("");
    lines.push("## 明细");
    lines.push("");
    for (const entry of detailed) {
      lines.push(`### ${entry.id} ${entry.title}`);
      lines.push("");
      lines.push(`- 验收：${entry.acceptance}`);
      lines.push(`- 设计/计划出处：${entry.refs.join("、")}`);
      lines.push(`- 状态：${statusMark[entry.status]} ${statusLabel[entry.status]}（${entry.detail}）`);
      for (const [index, step] of entry.steps.entries()) lines.push(`- 步骤 ${index + 1}：${step}`);
      if (entry.needs.length > 0) {
        for (const need of entry.needs) {
          lines.push(
            `- 前置 ${need.task}：${need.what}${need.artifact ? `｜落点 \`${need.artifact}\`｜${need.ready ? "已存在" : "尚未落地"}` : ""}`,
          );
        }
      }
      for (const check of entry.checks) lines.push(`- ${check}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

function printSummary(report: ImGateReport): void {
  const short = relative(repoRoot, resolve(repoRoot, report.evidence));
  const lines = [
    "",
    `${report.gate}（${report.script}）跑完`,
    `  通过 ${report.counts.pass} / 失败 ${report.counts.fail} / 阻塞 ${report.counts.blocked} / 跳过 ${report.counts.skip}`,
    ...report.cases.map(
      (entry) => `  ${statusMark[entry.status]} ${entry.id} ${entry.acceptance} ${entry.title} — ${entry.detail}`,
    ),
    `  证据：${short}/report.json、${short}/cases.md`,
    `  关卡关闭：${report.gateClosed ? "是" : "否"}`,
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

export function tail(text: string, lines = 12): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}
