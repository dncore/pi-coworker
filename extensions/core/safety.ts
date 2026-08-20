/**
 * 安全规则引擎（DESIGN.md §5）。
 * - 角色可见性：policy.rolePolicies 决定角色可用集群；工具执行前校验。
 * - 写操作确认：fail-closed，无 UI（print/rpc 无确认）时要求显式 confirm 参数。
 * - 破坏性 shell 检测（governance tool_call 钩子使用）。
 */
import { loadBundledConfig, loadUserConfig } from "./config.ts";
import type { CoworkerUserConfig } from "./config.ts";

export interface PolicyRules {
  minimalScopeLogin: boolean;
  requireUserConfirmOnWrite: boolean;
  redactSecrets: boolean;
  blockDestructiveShell: boolean;
  requireRegisteredSource: boolean;
  authLoginRequiresNoWait: boolean;
  neverSwitchIdentityOnError: boolean;
}

export interface Policy {
  rolePolicies?: Record<string, { clusters: string[] }>;
  defaultRole?: string;
  rules?: Partial<PolicyRules>;
}

const DEFAULT_RULES: PolicyRules = {
  minimalScopeLogin: true,
  requireUserConfirmOnWrite: true,
  redactSecrets: true,
  blockDestructiveShell: true,
  requireRegisteredSource: true,
  authLoginRequiresNoWait: true,
  neverSwitchIdentityOnError: true,
};

let cachedPolicy: Policy | null = null;

export function loadPolicy(): Policy {
  if (cachedPolicy) return cachedPolicy;
  const raw = loadBundledConfig("policy");
  cachedPolicy = (raw ?? {}) as Policy;
  return cachedPolicy;
}

export function policyRules(policy: Policy = loadPolicy()): PolicyRules {
  return { ...DEFAULT_RULES, ...(policy.rules ?? {}) };
}

export function userRoles(userCfg: CoworkerUserConfig = loadUserConfig()): string[] {
  const roles = userCfg.roles ?? [];
  return roles.length > 0 ? roles : [loadPolicy().defaultRole ?? "employee"];
}

/** 角色是否允许使用某集群 */
export function canUseCluster(cluster: string, userCfg?: CoworkerUserConfig, policy: Policy = loadPolicy()): boolean {
  const roles = userRoles(userCfg ?? loadUserConfig());
  const map = policy.rolePolicies ?? {};
  // 未配置任何角色策略 → 默认放行（新部署兜底），但写操作仍受 confirmWrite 约束
  if (Object.keys(map).length === 0) return true;
  for (const role of roles) {
    if (map[role]?.clusters?.includes(cluster)) return true;
  }
  return false;
}

/** 集群门禁：返回错误信息（null = 允许） */
export function requireCluster(cluster: string, userCfg?: CoworkerUserConfig, policy: Policy = loadPolicy()): string | null {
  if (canUseCluster(cluster, userCfg, policy)) return null;
  return `当前角色无权使用「${cluster}」集群。角色：${userRoles(userCfg ?? loadUserConfig()).join(", ")}。请联系管理员在 policy.json 中分配。`;
}

/**
 * 写操作确认（fail-closed）：
 * - params 显式 confirm:true → 直接通过（headless / RPC 场景）。
 * - 交互模式 → ctx.ui.confirm 弹窗。
 * - 其余（print 等无 UI）→ 拒绝，返回原因。
 */
export async function confirmWrite(
  ctx: { hasUI?: boolean; ui?: { confirm(title: string, message: string): Promise<boolean> } },
  opts: { title: string; message: string; explicitConfirm?: boolean },
): Promise<{ ok: boolean; reason?: string }> {
  if (opts.explicitConfirm === true) return { ok: true };
  if (ctx.hasUI && ctx.ui?.confirm) {
    const yes = await ctx.ui.confirm(opts.title, opts.message);
    return yes ? { ok: true } : { ok: false, reason: "用户取消了操作" };
  }
  return {
    ok: false,
    reason: "当前运行模式无交互确认能力。如需自动化执行，请在参数中显式传 confirm:true（仅限管理员脚本场景）。",
  };
}

/** 破坏性 shell 命令模式（governance tool_call 拦截） */
const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME|\.)/, why: "递归删除根/家目录" },
  { re: /\brm\s+-rf\b/, why: "强制递归删除" },
  { re: /\bdd\s+of=\/dev\//, why: "写裸设备" },
  { re: /\bmkfs\b/, why: "格式化" },
  { re: /\bshutdown\b|\breboot\b|\bpoweroff\b/, why: "关机/重启" },
  { re: /\bchmod\s+-R\s+777\b/, why: "批量放开全部权限" },
  { re: /\bchown\s+-R\b/, why: "批量变更属主" },
  { re: /\b>\s*\/dev\/sd[a-z]/, why: "覆盖裸设备" },
  { re: /\bcurl\b[^|;]*\|\s*(ba)?sh\b/, why: "管道执行远程脚本" },
  { re: /\bwget\b[^|;]*\|\s*(ba)?sh\b/, why: "管道执行远程脚本" },
];

export function detectDestructiveShell(command: string): string | null {
  for (const { re, why } of DESTRUCTIVE_PATTERNS) {
    if (re.test(command)) return why;
  }
  return null;
}

/** lark-cli auth login 必须带 --no-wait（split-flow），否则会阻塞 agent */
export function detectBlockingAuthLogin(args: string[]): boolean {
  if (!args.includes("auth") || !args.includes("login")) return false;
  return !args.includes("--no-wait");
}
