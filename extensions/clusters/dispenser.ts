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
  clearPlan,
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
const AGENTS_LABEL: Record<DispenseAgent, string> = {
  codex: "Codex",
  claude: "Claude Code",
  reasonix: "Reasonix",
  dsh: "DeepSeek Harness",
  grok: "Grok Build",
  omp: "omp",
  opencode: "OpenCode",
};
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
      "铁律：① 写命令（apply/models/restore/repair）**直接调用、绝不传 confirm**——应用会先拉只读预览，" +
      "把变更计划放进确认卡片（确认/取消按钮）让用户点；**有 UI 时传 confirm 会被直接拒绝**（card_required），" +
      "因为确认只能由用户点，模型不能自带确认绕过；" +
      "只有无 UI 场景（守护进程/脚本）才可用 confirm=true，且此时本会话必须先跑过 plan（还原先跑 backups）；" +
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
        Type.Boolean({
          description:
            "仅无 UI 场景（守护进程/脚本）使用：传 true 表示已获授权，不再弹应用内确认卡片。" +
            "应用内交互时不要传——写命令会自动弹卡片（内含计划）让用户点确认。",
        }),
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

      const isWrite = WRITE_COMMANDS.includes(command);
      const args: string[] = [];
      if (agent) args.push("--agent", agent);
      if (params.mainModel) args.push("--main-model", String(params.mainModel));
      if (params.backup) args.push("--backup", String(params.backup));

      if (isWrite) {
        if (params.confirm === true) {
          // 应用内（有 UI）一律走卡片：确认必须由用户点，模型不能自带 confirm 绕过
          // （曾出现：模型先 plan 再 apply(confirm=true)，用户根本没看到任何卡片就被写入）
          if (ctx.hasUI) {
            return errResult(
              "应用内写操作一律走确认卡片：不要传 confirm——去掉 confirm 重新调用本命令，应用会弹出内含变更计划的确认卡片让用户点。",
              { blocked: true, gate: "card_required" },
            );
          }
          // 无 UI（守护进程/脚本）：本会话内必须先出过计划（「先看后写」门禁）
          const planGate = checkPlanGate(command, agent ?? "", false);
          if (planGate) return errResult(planGate, { blocked: true, gate: "plan_first" });
        } else {
          // 交互路径：工具自己先拉只读预览，把计划放进确认卡片里直接给用户点（不用打字回复）
          const previewCmd = command === "restore" ? "backups" : "plan";
          const preview = await runDispenser(previewCmd, args);
          if (!preview.json?.ok) {
            return errResult(
              `无法生成${previewCmd === "plan" ? "变更计划" : "备份列表"}，已中止（未做任何写入）：${renderDispenseResult(preview.json, preview.stderr)}`,
              { previewFailed: true },
            );
          }
          if (previewCmd === "plan") recordPlan("plan", agent ?? "");
          else recordPlan("backups", agent ?? "");
          const previewText = renderDispenseResult(preview.json, "");
          const confirm = await confirmWrite(ctx, {
            title: `授权分发 · ${AGENTS_LABEL[agent as DispenseAgent] ?? agent}`,
            message:
              `${previewText}\n\n` +
              `——\n本操作只改上述受管配置块；写前自动备份，失败可用 restore 还原。`,
          });
          if (!confirm.ok) {
            return errResult(`已取消（未做任何写入）：${confirm.reason ?? "用户未确认"}`, { blocked: true, cancelled: true });
          }
        }
      }

      if (isWrite) args.push("--yes");

      const r = await runDispenser(command, args);
      const text = renderDispenseResult(r.json, r.json ? String(r.json.summary ?? "") : r.stderr || "命令未返回结果");

      // 计划类命令成功 → 记录，放行后续写操作；写操作成功 → 清记录，下次必须重新先看后写
      if (r.json?.ok) {
        if (command === "plan") recordPlan("plan", agent ?? "");
        if (command === "backups") recordPlan("backups", agent ?? "");
        if (isWrite) clearPlan(agent ?? "");
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
