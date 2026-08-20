/**
 * /coworker 命令族：引导、状态、权限、审计。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
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
      const prompt = `请用「状态机向导」完成入职设置。核心方法：**每一步前后都调用 coworker_setup_status 校验真实完成情况**，未完成绝不跳到下一步。

流程：
1) 调用 coworker_setup_status 查看当前进度与下一步。
2) 对「下一步」执行对应动作（见下），每个手动操作都要给出清晰提示并等用户确认完成。
3) 再次调用 coworker_setup_status 确认该步已 ✅，再进入下一步。

各步骤动作与手动提示：
- 步骤0 安装 lark-cli：未安装时给出命令（npm install -g @larksuite/cli），问用户装好后复查。
- 步骤1 初始化配置：调用 coworker_config_init，把链接+二维码给用户，等其浏览器完成。
- 步骤2 用户登录：coworker_auth_login（链接+二维码）→ 结束本轮等用户授权 → coworker_auth_complete；可再用 coworker_check_env 复核。
- 步骤3 个人 Bot 控制台（**手动关键步**）：调用 coworker_bot_setup 给出控制台链接与精确点击步骤（事件订阅勾选两个事件、添加机器人能力、创建版本）；用户完成后调用 coworker_bot_setup（verify=true）——请用户给 Bot 发一条消息，你监听确认事件已通。
- 步骤4 启动守护进程：调用 coworker_daemon start 直接启动（用户机器上后台运行），再 setup_status 确认事件总线在线；也说明可用 coworker-daemon install --autostart 配置开机自启。
- 步骤5/6 知识源/权限目录：若提示公司侧未配置（占位符），说明需管理员填写并标记可跳过；已配置则用 coworker_knowledge_search 验证检索。

每步手动操作都要：告诉用户具体在哪点哪里/发什么消息，并在用户确认完成后才继续。全部完成后总结：告诉用户现在可以私聊自己的 Bot 使用了。`;
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

  // ---------------- /coworker:daemon 守护进程管理 ----------------
  pi.registerCommand("coworker:daemon", {
    description: "管理守护进程：start/stop/restart/status/logs/install(自启)/uninstall",
    handler: async (args, ctx) => {
      const cmd = (args || "status").trim();
      if (/[;|&`$]/.test(cmd) || !/^[a-z]+( --[a-z]+( \d+)?)*$/i.test(cmd)) {
        ctx.ui.notify("参数不合法。用法：/coworker:daemon start|stop|restart|status|logs|install --autostart|uninstall", "warning");
        return;
      }
      const cli = join(packageRoot(), "agent", "bin", "coworker-daemon.ts");
      try {
        const out = execFileSync(process.execPath, [cli, ...cmd.split(/\s+/)], { encoding: "utf8", timeout: 30_000 });
        ctx.ui.notify(out.trim() || "（无输出）");
      } catch (e: any) {
        ctx.ui.notify("执行失败：" + String(e?.message ?? e), "error");
      }
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
            `命令：/coworker:setup 引导 · /coworker:status 状态 · /coworker:daemon 守护 · /coworker:perm 权限 · /coworker:bot Bot · /coworker:skills 技能 · /coworker:audit 审计`,
          ].join("\n"),
        "info",
      );
    },
  });
}
