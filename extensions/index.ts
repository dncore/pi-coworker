/**
 * pi-coworker —— 企业就绪 pi agent 扩展入口。
 *
 * 组装四个工作集群 + /coworker 命令族：
 *   onboarding 入职引导 · permissions 权限申请 · knowledge 知识问答 · governance 治理与安全
 *
 * 设计见 DESIGN.md。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { registerGovernance } from "./clusters/governance.ts";
import { registerOnboarding } from "./clusters/onboarding.ts";
import { registerPermissions } from "./clusters/permissions.ts";
import { registerKnowledge } from "./clusters/knowledge.ts";
import { registerSkillsCluster } from "./clusters/skills.ts";
import { registerCommands } from "./commands.ts";
import { companySkillsDir } from "./core/skillsync.ts";

export default function coworker(pi: ExtensionAPI): void {
  // 安全钩子最先注册，保证先拦截后放行
  registerGovernance(pi);
  // 工作集群
  registerOnboarding(pi);
  registerPermissions(pi);
  registerKnowledge(pi);
  registerSkillsCluster(pi);
  // 命令族
  registerCommands(pi);

  // 公司技能动态加载：resources_discover 返回本地技能目录（~/.coworker/skills 或配置路径）
  pi.on("resources_discover", () => {
    const dir = companySkillsDir();
    return { skillPaths: existsSync(dir) ? [dir] : [] };
  });
}
