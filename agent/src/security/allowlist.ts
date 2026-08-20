/**
 * 安全：工具白名单校验（fail-fast），按模式不同。
 * - server：禁止本地工具 + 授权写工具（只读子集）。
 * - local ：允许 coworker 全工具 + （若启用）本机工具；仍禁止明显危险的授权写工具误开。
 */
import { SERVER_TOOLS, LOCAL_SHELL_TOOLS, type RunMode } from "../mode.ts";

/** server 模式禁止：本地工具 + 会造成授权的写工具 */
const SERVER_FORBIDDEN = new Set([
  "bash", "read", "write", "edit", "grep", "find", "ls",
  "coworker_perm_apply", "coworker_skill_sync",
  "coworker_config_init", "coworker_auth_login", "coworker_auth_complete",
]);

/** local 模式禁止：明显危险的写工具（防误开；自服务直授/登录属于个人主动操作，允许） */
const LOCAL_FORBIDDEN = new Set(["coworker_skill_sync"]);

export function validateToolAllowlist(tools: string[], mode: RunMode): string[] {
  const problems: string[] = [];
  for (const t of tools) {
    if (mode === "server") {
      if (SERVER_FORBIDDEN.has(t)) {
        problems.push(`工具「${t}」在 server 模式被禁止`);
        continue;
      }
      if (!t.startsWith("coworker_")) problems.push(`工具「${t}」不是 coworker 工具，server 模式禁止`);
    } else {
      if (LOCAL_FORBIDDEN.has(t)) {
        problems.push(`工具「${t}」在 local 模式被禁止（如需请手动配置）`);
        continue;
      }
      const ok = t.startsWith("coworker_") || LOCAL_SHELL_TOOLS.includes(t);
      if (!ok) problems.push(`工具「${t}」既不是 coworker 工具也不是本机工具，无法启用`);
    }
  }
  if (!tools.includes("coworker_knowledge_search")) {
    problems.push("白名单缺少 coworker_knowledge_search（核心能力）");
  }
  return problems;
}

export { SERVER_TOOLS };
