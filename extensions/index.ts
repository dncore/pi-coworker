/**
 * pi-coworker —— 企业就绪 pi agent 扩展入口。
 *
 * 组装四个工作集群 + /coworker 命令族：
 *   onboarding 入职引导 · permissions 权限申请 · knowledge 知识问答 · governance 治理与安全
 *
 * 设计见 DESIGN.md；纯本机 agent 形态见 docs/DESIGN-LOCAL.md。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { registerGovernance } from "./clusters/governance.ts";
import { registerOnboarding } from "./clusters/onboarding.ts";
import { registerPermissions } from "./clusters/permissions.ts";
import { registerKnowledge } from "./clusters/knowledge.ts";
import { registerSkillsCluster } from "./clusters/skills.ts";
import { registerCommands } from "./commands.ts";
import { registerPersonal } from "./clusters/personal.ts";
import { companySkillsDir } from "./core/skillsync.ts";
import {
  bindPi,
  resolveMageneConfig,
  fetchMageneModels,
  registerMageneProvider,
} from "./core/magene.ts";

export default function coworker(pi: ExtensionAPI): void {
  // 让 magene 模块记住 pi 实例（工具内注册/注销 provider 需要）
  bindPi(pi);
  // 安全钩子最先注册，保证先拦截后放行
  registerGovernance(pi);
  // 工作集群
  registerOnboarding(pi);
  registerPermissions(pi);
  registerKnowledge(pi);
  registerSkillsCluster(pi);
  registerPersonal(pi);
  // 命令族
  registerCommands(pi);

  // 公司技能动态加载：resources_discover 返回本地技能目录（~/.coworker/skills 或配置路径）
  pi.on("resources_discover", () => {
    const dir = companySkillsDir();
    return { skillPaths: existsSync(dir) ? [dir] : [] };
  });

  // 模型网关自动注册（非阻塞）：凭证已配置则后台拉取模型并注册 provider。
  // 守护进程（pi --mode rpc）加载同一扩展时同样生效，使 Bot Agent 可直接使用 magene/ 模型。
  void (async () => {
    try {
      const cfg = resolveMageneConfig();
      if (!cfg.apiKey || cfg.baseUrl.includes("<")) return; // 未配置或占位符
      const ids = await fetchMageneModels(cfg.baseUrl, cfg.apiKey, 10_000);
      registerMageneProvider(cfg.baseUrl, cfg.apiKey, ids);
    } catch {
      // 网关不可达/无凭证时保持未注册，不阻塞启动
    }
  })();
}
