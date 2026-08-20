/**
 * /coworker 命令族：引导、状态、权限、审计。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runLark, userIdentityOf, countScopes } from "./core/lark.ts";
import { readAudit, loadUserConfig, packageRoot } from "./core/config.ts";
import { loadPolicy, canUseCluster } from "./core/safety.ts";
import { listPermissions } from "./core/catalog.ts";
import { companySkillsDir, listLocalSkills, skillSyncSources } from "./core/skillsync.ts";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function registerCommands(pi: ExtensionAPI): void {
  // ---------------- /coworker:setup 入职引导 ----------------
  pi.registerCommand("coworker:setup", {
    description: "企业入职引导：检查环境、登录飞书、申请权限、接入知识问答",
    handler: async (_args, ctx) => {
      const prompt = `请为用户执行企业入职引导（按顺序逐项推进，每步向用户确认）：
1) 调用 coworker_check_env 检查 lark-cli / 配置 / 登录态。
2) 若 lark-cli 未安装：给出安装指引（npm install -g @larksuite/cli 或运行公司 bootstrap.sh），并询问用户是否要安装。
3) 若配置未初始化：调用 coworker_config_init 发起，把授权链接和二维码给用户，等待其完成授权。
4) 若未登录：调用 coworker_auth_login 发起授权（按需 --scope/--domain），把链接+二维码给用户，结束本轮等用户授权，再调用 coworker_auth_complete 完成。
5) 登录后：复核 coworker_check_env。
6) 开通个人 Bot：调用 coworker_bot_setup，引导用户在控制台启用事件/机器人能力/发布，并告知如何启动守护进程与私聊自己的 Bot。
7) 调用 coworker_knowledge_search 确认公司百科可访问。
8) 最后调用 coworker_perm_list 展示可申请的权限，询问用户是否需要申请（用 coworker_perm_apply）。
全程遵守企业安全规则：写操作先确认、最小权限、不编造。`;
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      ctx.ui.notify("已发起入职引导，请跟随对话逐步完成", "info");    },
  });

  // ---------------- /coworker:status 环境状态 ----------------
  pi.registerCommand("coworker:status", {
    description: "查看企业就绪环境状态（lark-cli / 配置 / 登录）",
    handler: async (_args, ctx) => {
      const lines: string[] = ["企业就绪状态"];
      const ver = await runLark(["--version"], { timeoutMs: 15_000 });
      if (ver.exitCode === -1) {
        lines.push("• lark-cli：❌ 未安装（npm i -g @larksuite/cli 或 bootstrap.sh）");
      } else {
        lines.push(`• lark-cli：✅ ${(ver.stdout || ver.stderr || "?").trim().split("\n")[0]}`);
        const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
        lines.push(cfg.ok ? "• 配置：✅ 已初始化" : "• 配置：❌ 未初始化（/coworker:setup 引导）");
        const auth = await runLark(["auth", "status", "--json"], { as: "user", timeoutMs: 60_000 });
        const u = userIdentityOf(auth.envelope);
        lines.push(
          auth.ok && u
            ? `• 登录：✅ ${u.userName ?? u.openId ?? "?"}（scope ${countScopes(u.scope)} 个）`
            : "• 登录：❌ 未登录（/coworker:setup 引导授权）",
        );
      }
      ctx.ui.notify("Coworker 状态\n" + lines.join("\n"), "info");
    },
  });

  // ---------------- /coworker:perm 权限 ----------------
  pi.registerCommand("coworker:perm", {
    description: "查看/申请企业权限（岗位、知识库、文档）",
    handler: async (args, ctx) => {
      const perms = listPermissions();
      if (perms.length === 0) {
        ctx.ui.notify("权限目录为空：请管理员维护 config/catalog.json", "warning");
        return;
      }
      const prompt =
        (args ? `用户补充：${args}\n` : "") +
        `请为用户展示企业权限目录（调用 coworker_perm_list），并简要说明每条权限的授予方式（自服务/审批/申请访问）。` +
        `然后询问用户要申请哪条，用 coworker_perm_apply 处理（写操作需用户确认）。可先用 coworker_perm_check 探测现状。`;
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      ctx.ui.notify(`权限目录共 ${perms.length} 项，已展开，请查看对话`, "info");    },
  });

  // ---------------- /coworker:audit 审计 ----------------
  pi.registerCommand("coworker:audit", {
    description: "查看本机企业操作审计日志（需 governance 角色）",
    handler: async (args, ctx) => {
      const policy = loadPolicy();
      if (!canUseCluster("governance", loadUserConfig(), policy)) {
        ctx.ui.notify("无权限：当前角色无权查看审计日志，请联系管理员在 policy.json 中分配 governance 集群。", "warning");
        return;
      }
      const n = Math.min(Math.max(parseInt(args || "20", 10) || 20, 1), 100);
      const entries = readAudit(n);
      if (entries.length === 0) {
        ctx.ui.notify("审计日志：暂无记录。", "info");
        return;
      }
      const lines = entries.map(
        (e) => `${e.ts.slice(0, 19)} [${e.cluster}] ${e.action} ${e.resource} → ${e.result}`,
      );
      ctx.ui.notify(`审计日志（最近 ${entries.length} 条）\n` + lines.join("\n"), "info");
    },
  });

  // ---------------- /coworker:bot 个人 Bot 开通 --------------
  pi.registerCommand("coworker:bot", {
    description: "开通/查看个人飞书 Bot（应用、事件订阅、守护进程）",
    handler: async (args, ctx) => {
      const prompt =
        (args ? `用户补充：${args}\n` : "") +
        `请调用 coworker_bot_setup 检查个人 Bot 开通状态：应用是否配置、控制台需启用的事件与机器人能力、事件总线是否运行；并给出启动守护进程与在飞书私聊 Bot 的指引。`;
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      ctx.ui.notify("已发起个人 Bot 开通检查，请查看对话", "info");
    },
  });

  // ---------------- /coworker:skills 公司技能 -------------
  pi.registerCommand("coworker:skills", {
    description: "查看公司技能：包内技能、本地动态技能、可同步的知识源",
    handler: async (_args, ctx) => {
      const policy = loadPolicy();
      if (!canUseCluster("knowledge", loadUserConfig(), policy)) {
        ctx.ui.notify("无权限：当前角色无权查看公司技能。", "warning");
        return;
      }
      const pkgSkillsDir = join(packageRoot(), "skills");
      const pkgSkills = existsSync(pkgSkillsDir)
        ? readdirSync(pkgSkillsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && existsSync(join(pkgSkillsDir, e.name, "SKILL.md")))
            .map((e) => e.name)
        : [];
      const localDir = companySkillsDir();
      const local = listLocalSkills(localDir);
      const syncSources = skillSyncSources();
      const lines = [
        `包内技能（${pkgSkills.length}）：${pkgSkills.join(", ") || "—"}`,
        `本地动态技能（${local.length}）：${local.join(", ") || "—"}`,
        `  目录：${localDir}`,
        `可同步的知识源（${syncSources.length}）：`,
        ...syncSources.map((s) => `  • ${s.name}（${s.id}）→ ${s.skillSync.targetDir ?? localDir}`),
        syncSources.length === 0 ? "  （未配置，管理员需在 knowledge.json 加 skillSync）" : "",
        ``,
        `全局 lark 技能：见 ~/.pi/agent/skills（lark-wiki/base/doc/approval 等已内置）`,
        ``,
        `同步技能用 coworker_skill_sync（默认 dry-run，写入需确认）。`,
      ];
      ctx.ui.notify("公司技能\n" + lines.join("\n"), "info");
    },
  });

  // ---------------- /coworker 概览 ----------------
  pi.registerCommand("coworker", {
    description: "企业就绪助手概览（集群状态与可用命令）",
    handler: async (_args, ctx) => {
      const cfg = loadUserConfig();
      const policy = loadPolicy();
      const clusters = ["onboarding", "permissions", "knowledge", "governance"];
      const clusterName: Record<string, string> = {
        onboarding: "入职引导",
        permissions: "权限申请",
        knowledge: "知识问答",
        governance: "治理与安全",
      };
      const status = clusters
        .map((c) => `  ${canUseCluster(c, cfg, policy) ? "✅" : "⛔"} ${clusterName[c]} (${c})`)
        .join("\n");
      ctx.ui.notify(
        "pi-coworker 企业 AI 助手\n" +
          [
            `角色：${cfg.roles.length ? cfg.roles.join(", ") : "employee（默认）"}`,
            `可用集群：`,
            status,
            ``,
            `命令：/coworker:setup 入职引导 · /coworker:status 状态 · /coworker:perm 权限 · /coworker:skills 技能 · /coworker:audit 审计`,
          ].join("\n"),
        "info",
      );
    },
  });
}
