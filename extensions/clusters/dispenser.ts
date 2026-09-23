/**
 * dispenser 集群：授权分发——把本应用已配置的网关（magene / 自定义）接入本机其它 agent。
 *
 * 安全（DESIGN.md §5）：写操作「先看后写」——写命令要求本会话先跑过 plan（还原先跑 backups），
 * 且需要用户确认（confirmWrite）；CLI 侧还有 --yes / 备份 / 掩码 / 审计四道门禁（见 dispenser/README.md）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { confirmWrite, requireCluster } from "../core/safety.ts";
import { appendAudit } from "../core/config.ts";
import { okResult, errResult } from "../core/tools.ts";
import {
  checkPlanGate,
  dispenserCliPath,
  recordPlan,
  renderDispenseResult,
  runDispenser,
  WRITE_COMMANDS,
  type DispenseAgent,
  type DispenseCommand,
} from "../core/dispenser.ts";

interface ToolCtx {
  hasUI?: boolean;
  ui?: { confirm(title: string, message: string): Promise<boolean> };
}

const AGENTS: DispenseAgent[] = ["codex", "claude", "reasonix", "dsh", "grok", "omp", "opencode"];
const COMMANDS: DispenseCommand[] = ["agents", "doctor", "status", "plan", "apply", "models", "backups", "restore", "repair"];

export function registerDispenserCluster(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "coworker_dispense",
    label: "Coworker 授权分发（把公司网关接入本机其它 agent）",
    description:
      "把本应用已配置的模型网关分发到本机其它 AI agent（codex / claude / reasonix / dsh / grok / omp / opencode），" +
      "并支持还原、修复与仅更新模型列表。协议见技能 auth-dispenser。\n" +
      "命令：agents（探测）、doctor（凭证+网关体检）、status（现状与问题）、plan（变更预览，只读）、" +
      "apply（写入）、models（仅刷新模型列表）、backups（列备份）、restore（还原）、repair（诊断并修复）。\n" +
      "铁律：① 写命令（apply/models/restore/repair）必须先给用户看清楚（plan/backups）并把摘要转述给用户，" +
      "得到用户明确同意后才带 confirm=true 重试——否则会被「先看后写」门禁拒绝；" +
      "② 绝不向用户索要 API Key、绝不把密钥写进对话（网关凭证由 CLI 从应用配置读取）；" +
      "③ 不要手工编辑这些 agent 的配置文件，一律走本工具；④ 失败即停，如实报告并给出 restore 退路。",
    parameters: Type.Object({
      command: Type.Union(COMMANDS.map((c) => Type.Literal(c)) as any, { description: "要执行的子命令" }),
      agent: Type.Optional(
        Type.Union(AGENTS.map((a) => Type.Literal(a)) as any, { description: "目标 agent（除 agents/doctor 外必填）" }),
      ),
      mainModel: Type.Optional(Type.String({ description: "主模型 id（如 deepseek-v4-pro）；不传用网关默认" })),
      backup: Type.Optional(Type.String({ description: "restore 指定的备份文件名；不传用最近一次" })),
      confirm: Type.Optional(
        Type.Boolean({ description: "写操作确认（必须先向用户展示 plan/backups 摘要并得到同意后再传 true）" }),
      ),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx: ToolCtx) {
      const gate = requireCluster("onboarding");
      if (gate) return errResult(gate);

      const command = params.command as DispenseCommand;
      if (!dispenserCliPath()) {
        return errResult("授权分发 CLI 未就绪（组件资源缺失）。请管理员检查安装包 / 组件更新，或稍后重试。", { cli: false });
      }
      const agent = params.agent as DispenseAgent | undefined;
      if (command !== "agents" && command !== "doctor" && !agent) {
        return errResult(`命令 ${command} 需要指定 agent（${AGENTS.join(" / ")}）`, { missing: "agent" });
      }

      // 「先看后写」门禁：写命令要求本会话内先出过计划
      const planGate = checkPlanGate(command, agent ?? "", false);
      if (planGate) return errResult(planGate, { blocked: true, gate: "plan_first" });

      const isWrite = WRITE_COMMANDS.includes(command);
      if (isWrite) {
        const confirm = await confirmWrite(ctx, {
          title: `确认授权分发：${command} ${agent ?? ""}`.trim(),
          message:
            `将对「${agent}」执行写操作（${command}）：只改受管配置块，写前自动备份；` +
            `失败可用 restore 还原。\n\n请确认你已经把上一步的计划（plan/backups）给用户看过并得到同意。`,
          explicitConfirm: params.confirm,
        });
        if (!confirm.ok) {
          return errResult(
            `已取消：${confirm.reason ?? "用户未确认"}。请先展示计划并征求用户同意，再带 confirm=true 重试。`,
            { blocked: true },
          );
        }
      }

      const args: string[] = [];
      if (agent) args.push("--agent", agent);
      if (params.mainModel) args.push("--main-model", String(params.mainModel));
      if (params.backup) args.push("--backup", String(params.backup));
      if (isWrite) args.push("--yes");

      const r = await runDispenser(command, args);
      const text = renderDispenseResult(r.json, r.json ? String(r.json.summary ?? "") : r.stderr || "命令未返回结果");

      // 计划类命令成功 → 记录，放行后续写操作
      if (r.json?.ok) {
        if (command === "plan") recordPlan("plan", agent ?? "");
        if (command === "backups") recordPlan("backups", agent ?? "");
      }

      appendAudit({
        cluster: "onboarding",
        action: `dispense_${command}`,
        resource: agent ?? "all",
        result: r.json?.ok ? "ok" : r.json?.code ?? "fail",
        detail: { exitCode: r.exitCode, code: r.json?.code, files: (r.json?.plan ?? []).map((p: any) => p.path) },
      });

      const details = {
        command,
        agent: agent ?? null,
        exitCode: r.exitCode,
        code: r.json?.code ?? null,
        plan: r.json?.plan ?? [],
        written: r.json?.written ?? [],
        issues: r.json?.issues ?? [],
        nextSteps: r.json?.nextSteps ?? [],
      };

      if (r.exitCode === 2 || r.json?.code === "confirm_required") {
        // 把「需要确认」原样交给模型：模型应把计划转述给用户后再带 confirm=true 重试
        return okResult(text, { ...details, needsUserConfirm: true });
      }
      return r.json?.ok ? okResult(text, details) : errResult(text, details);
    },
  });
}
