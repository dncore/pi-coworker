/**
 * 授权分发（auth-dispenser）——把本应用已配置的网关分发到本机其它 agent 的 CLI 封装。
 *
 * 背景：GUI 会话里的 agent 没有 shell 工具（工具白名单只放 coworker_*），
 * 因此「跑脚本」这一步必须由扩展以工具形式暴露；CLI 本身（dispenser/cli.ts）
 * 仍可被人工/脚本直接调用（开发排障），技能 auth-dispenser 说明两者关系。
 *
 * 安全边界（与 CLI 内的门禁互补，不替代）：
 *   - 只读命令（agents/doctor/status/plan/backups）直接放行；
 *   - 写命令（apply/models/restore/repair）要求：① 本会话内先跑过 plan（或 restore 前 backups）；
 *     ② 调用方显式 confirm:true（配合 confirmWrite 的人工确认）；
 *   - 密钥从不经 argv/stdin 传入（CLI 自己从 app 配置读）；输出里密钥已被 CLI 掩码；
 *   - 每次调用都写应用审计（appendAudit），与 CLI 自身的 dispenser.jsonl 双轨。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveDispenserCli } from "../../agent/src/runtime.ts";

const execFileP = promisify(execFile);

export type DispenseCommand = "agents" | "doctor" | "status" | "plan" | "apply" | "models" | "backups" | "restore" | "repair";
export type DispenseAgent = "codex" | "claude" | "reasonix" | "dsh" | "grok" | "omp" | "opencode";

export const WRITE_COMMANDS: readonly DispenseCommand[] = ["apply", "models", "restore", "repair"];

export interface DispenseResult {
  ok: boolean;
  /** CLI 退出码（2 = confirm_required） */
  exitCode: number;
  json: Record<string, any> | null;
  stdout: string;
  stderr: string;
}

export function dispenserCliPath(): string | null {
  return resolveDispenserCli() ?? null;
}

/** 运行 CLI 子命令（不带 shell；参数逐个传，杜绝拼接注入） */
export async function runDispenser(command: DispenseCommand, args: string[] = [], timeoutMs = 180_000): Promise<DispenseResult> {
  const cli = dispenserCliPath();
  if (!cli) {
    return { ok: false, exitCode: -1, json: null, stdout: "", stderr: "未找到授权分发 CLI（组件与随包资源都缺失）" };
  }
  try {
    const r = await execFileP(process.execPath, [cli, command, ...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, COWORKER_DISPENSER_CLI: cli },
    });
    return { ok: true, exitCode: 0, json: parseJson(String(r.stdout)), stdout: String(r.stdout), stderr: String(r.stderr) };
  } catch (e: any) {
    const stdout = String(e?.stdout ?? "");
    const stderr = String(e?.stderr ?? e?.message ?? e);
    const code = typeof e?.code === "number" ? e.code : 1;
    const json = parseJson(stdout);
    // confirm_required（2）和「业务性失败」都是正常返回，不当异常
    return { ok: json?.ok === true, exitCode: code, json, stdout, stderr };
  }
}

function parseJson(stdout: string): Record<string, any> | null {
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line) as Record<string, any>;
  } catch {
    return null;
  }
}

/** 把 CLI 的 JSON 结果转成人读文本（给模型转述给用户） */
export function renderDispenseResult(j: Record<string, any> | null, fallback: string): string {
  if (!j) return fallback;
  const lines: string[] = [];
  if (j.summary) lines.push(String(j.summary));
  if (Array.isArray(j.plan) && j.plan.length) {
    lines.push("", "计划变更：");
    for (const p of j.plan) {
      lines.push(`- ${p.path}`);
      for (const c of p.changes ?? []) lines.push(`    · ${c}`);
    }
  }
  if (Array.isArray(j.written) && j.written.length) {
    lines.push("", "已写入（写前已备份）：");
    for (const w of j.written) lines.push(`- ${w}`);
  }
  if (Array.isArray(j.extra) && j.extra.length) {
    for (const x of j.extra) lines.push(`- ${x}`);
  }
  if (Array.isArray(j.issues) && j.issues.length) {
    lines.push("", "问题：");
    for (const i of j.issues) lines.push(`- ${i}`);
  }
  if (Array.isArray(j.issuesRemaining) && j.issuesRemaining.length) {
    lines.push("", "剩余问题：");
    for (const i of j.issuesRemaining) lines.push(`- ${i}`);
  }
  if (Array.isArray(j.restored) && j.restored.length) lines.push("", `已还原：${j.restored.join("；")}`);
  if (Array.isArray(j.nextSteps) && j.nextSteps.length) lines.push("", `生效：${j.nextSteps.join("；")}`);
  if (j.gateway) lines.push("", `网关：${j.gateway.baseUrl}（凭证来源 ${j.gateway.source}，密钥 ${j.gateway.apiKeyMasked ?? "已掩码"}）`);
  if (j.code === "confirm_required") lines.push("", "⚠ 该命令属于写操作：请先把上面的计划给用户确认，再加 confirm=true 重试。");
  if (j.code === "no_backup") lines.push("", "⚠ 没有可用备份，不能还原；如实告知用户。");
  if (j.code === "needs_restore") lines.push("", "⚠ 配置文件损坏，脚本不能硬改：请先还原备份或人工修复。");
  if (j.message && !j.summary) lines.push(String(j.message));
  return lines.join("\n") || fallback;
}

// ---------------------------------------------------------------------------
// 「先看后写」门禁：写命令要求本会话内先出过计划
// ---------------------------------------------------------------------------

const PLAN_TTL_MS = 30 * 60 * 1000;
const plannedAt = new Map<string, number>();

/** 记录一次计划（plan / backups）；写命令前校验 */
export function recordPlan(kind: "plan" | "backups", agent: string): void {
  plannedAt.set(`${kind}:${agent}`, Date.now());
}

/** 写命令的前置检查：apply/models/repair 需要近期 plan；restore 需要近期 backups */
export function checkPlanGate(command: DispenseCommand, agent: string, hasExplicitPlan: boolean): string | null {
  if (!WRITE_COMMANDS.includes(command)) return null;
  const need: "plan" | "backups" = command === "restore" ? "backups" : "plan";
  if (hasExplicitPlan) return null;
  const at = plannedAt.get(`${need}:${agent}`);
  if (!at || Date.now() - at > PLAN_TTL_MS) {
    return need === "plan"
      ? `门禁：写操作前必须先出计划。请先调用 coworker_dispense(command=plan, agent=${agent}) 把变更给用户看，确认后再加 confirm=true 重试。`
      : `门禁：还原前必须先看备份。请先调用 coworker_dispense(command=backups, agent=${agent})，确认可回滚点后再加 confirm=true 重试。`;
  }
  return null;
}
