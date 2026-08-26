/**
 * Bot Agent 守护程序：两种运行模式（RUN_MODE）。
 *
 * - local  ：个人本地 Bot。本机用户身份，全 coworker 工具（可开本地工具），
 *            用户私聊自己的个人 Bot 应用。默认（零服务器、隐私在本地）。
 * - server ：公司共享 Bot。服务器 bot 身份，只读工具集，全员 @共享机器人。
 */
export type RunMode = "local" | "server";

export const LOCAL_TOOLS = [
  "coworker_check_env", "coworker_config_init", "coworker_auth_login", "coworker_auth_complete", "coworker_auth_status",
  "coworker_perm_list", "coworker_perm_check", "coworker_perm_apply", "coworker_perm_status", "coworker_perm_my", "coworker_perm_scan",
  "coworker_knowledge_search", "coworker_knowledge_fetch",
];

/** 本地模式可选开启的本机工具（LOCAL_ENABLE_SHELL=1）——默认关闭 */
export const LOCAL_SHELL_TOOLS = ["bash", "read", "write", "edit", "grep", "find", "ls"];

/** 服务器模式：只读子集（绝不包含写/本地工具） */
export const SERVER_TOOLS = [
  "coworker_auth_status",
  "coworker_perm_list", "coworker_perm_scan", "coworker_perm_check",
  "coworker_knowledge_search", "coworker_knowledge_fetch",
];

export const MODE_LABEL: Record<RunMode, string> = {
  local: "个人本地 Bot（本机·用户身份）",
  server: "公司共享 Bot（服务器·bot 身份）",
};

export function detectMode(env: NodeJS.ProcessEnv = process.env): RunMode {
  return env.RUN_MODE === "server" ? "server" : "local";
}

/** 该模式是否把 COWORKER_SERVER_MODE 传给 pi 子进程（知识工具用 bot 身份） */
export function serverModeEnv(mode: RunMode): Record<string, string> {
  return mode === "server" ? { COWORKER_SERVER_MODE: "1" } : {};
}

export function defaultTools(mode: RunMode, env: NodeJS.ProcessEnv = process.env): string[] {
  if (mode === "server") return SERVER_TOOLS;
  if (env.LOCAL_ENABLE_SHELL === "1") return [...LOCAL_TOOLS, ...LOCAL_SHELL_TOOLS];
  return [...LOCAL_TOOLS];
}

export function defaultNoBuiltin(mode: RunMode, env: NodeJS.ProcessEnv = process.env): boolean {
  if (mode === "server") return true;
  return env.LOCAL_ENABLE_SHELL !== "1";
}

/** agent 系统提示（按模式） */
export function buildPrompt(mode: RunMode, openId: string, text: string): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const wk = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
  const nowStr = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())} ${wk}`;
  const rules =
    mode === "server"
      ? [
          "1. 企业问答：只用 coworker_knowledge_search / coworker_knowledge_fetch 从已登记知识源检索，回答必须附来源；找不到就明说，不要编造。",
          "2. 权限类：用 coworker_perm_scan / coworker_perm_check 查看该员工权限现状；申请权限请引导员工走审批或联系管理员，你无法代员工授权。",
          "3. 涉及薪资、个人信息、未公开经营数据：拒绝并提示合规边界。",
          "4. 中文回答，简洁，不超过 300 字。",
        ]
      : [
          "1. 企业问答：只用 coworker_knowledge_search / coworker_knowledge_fetch，回答附来源；找不到就明说，不编造。",
          "2. 环境/登录：用 coworker_check_env / coworker_auth_status；登录走 split-flow（先给链接+二维码，用户授权后再完成）。",
          "3. 权限：用 coworker_perm_list / coworker_perm_scan / coworker_perm_check；申请前先向用户确认。",
          "4. 本地能力：如需操作本地文件/命令，先用工具确认用户意图，再执行。",
          "5. 涉及薪资/个人信息/机密：拒绝并提示合规边界。",
          "6. 中文回答，简洁。",
        ];
  return [
    `你是用户的企业 AI 助手（${MODE_LABEL[mode]}）。提问者 open_id：${openId}`,
    `当前时间：${nowStr}（涉及时间范围判断一律以此为准）`,
    `规则：`,
    ...rules,
    ``,
    `提问：${text}`,
  ].join("\n");
}
