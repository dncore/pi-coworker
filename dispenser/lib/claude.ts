// Claude Code 配置:写入 ~/.claude/settings.json 的 env 块(cc-switch 同款方式)。
// 官方标准:各角色模型用 ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS_MODEL 等变量,
// ANTHROPIC_SMALL_FAST_MODEL 已弃用(由 HAIKU 取代),不再写入。
// 模型名按真实上下文窗口加官方后缀 [1m] / [200k]。
// 纯函数,不做文件 I/O。移植自 axon-llm-dispenser src/core/claude.ts。

export type ClaudeRoleModel = {
  haiku: string; // ANTHROPIC_DEFAULT_HAIKU_MODEL
  sonnet: string; // ANTHROPIC_DEFAULT_SONNET_MODEL
  opus: string; // ANTHROPIC_DEFAULT_OPUS_MODEL
  fable: string; // ANTHROPIC_DEFAULT_FABLE_MODEL
  subagent: string; // CLAUDE_CODE_SUBAGENT_MODEL
};

export type ClaudeConfigInput = {
  /** Anthropic 兼容端点(如 http://host/api/anthropic)。 */
  anthropicBaseUrl: string;
  apiKey: string;
  /** 主模型(ANTHROPIC_MODEL),已带上下文后缀。 */
  mainModel: string;
  roles: ClaudeRoleModel;
  /** 全局兜底窗口:仅当主模型 <200k 无后缀时设置;有后缀时不设以免冲突。 */
  maxContextTokens?: number;
};

/** 从 OpenAI 兼容 base_url 推导 Anthropic 端点:/api/v1 → /api/anthropic。 */
export function deriveAnthropicUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/api/v1")) return trimmed.replace(/\/api\/v1$/, "") + "/api/anthropic";
  if (trimmed.endsWith("/v1")) return trimmed.replace(/\/v1$/, "") + "/api/anthropic";
  return trimmed + "/api/anthropic";
}

/** Claude Code 官方上下文后缀:>=900k → [1m];>=200k → [200k];其余无后缀。 */
export function claudeModelSuffix(contextWindow: number): string {
  if (contextWindow >= 900_000) return "1m";
  if (contextWindow >= 200_000) return "200k";
  return "";
}

/** 按真实上下文窗口生成 Claude 模型名(如 deepseek-v4-flash[1m])。 */
export function formatClaudeModel(id: string, contextWindow: number): string {
  const suffix = claudeModelSuffix(contextWindow);
  return suffix ? `${id}[${suffix}]` : id;
}

/** 合并写 ~/.claude/settings.json 的 env 块(保留 permissions 等其它键,移除弃用变量)。 */
export function patchClaudeSettings(text: string, input: ClaudeConfigInput): { text: string; changes: string[] } {
  let doc: Record<string, unknown>;
  try {
    doc = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error("~/.claude/settings.json 不是合法 JSON,请手动检查后重试");
  }
  if (typeof doc !== "object" || Array.isArray(doc)) throw new Error("settings.json 顶层必须是对象");

  const env = (doc.env ?? {}) as Record<string, unknown>;
  const changes: string[] = [];
  const set = (k: string, v: string): void => {
    if (env[k] !== v) {
      env[k] = v;
      changes.push(`${k} = ${v}`);
    }
  };
  set("ANTHROPIC_BASE_URL", input.anthropicBaseUrl);
  set("ANTHROPIC_AUTH_TOKEN", input.apiKey);
  set("ANTHROPIC_MODEL", input.mainModel);
  set("ANTHROPIC_DEFAULT_HAIKU_MODEL", input.roles.haiku);
  set("ANTHROPIC_DEFAULT_SONNET_MODEL", input.roles.sonnet);
  set("ANTHROPIC_DEFAULT_OPUS_MODEL", input.roles.opus);
  set("ANTHROPIC_DEFAULT_FABLE_MODEL", input.roles.fable);
  set("CLAUDE_CODE_SUBAGENT_MODEL", input.roles.subagent);

  // ANTHROPIC_SMALL_FAST_MODEL 已弃用(被 DEFAULT_HAIKU_MODEL 取代),删除
  if ("ANTHROPIC_SMALL_FAST_MODEL" in env) {
    delete env["ANTHROPIC_SMALL_FAST_MODEL"];
    changes.push("ANTHROPIC_SMALL_FAST_MODEL(已弃用) 已移除");
  }

  // 模型名后缀已表达窗口时移除全局 MAX_CONTEXT_TOKENS(避免冲突);仅主模型 <200k 时设置兜底
  if (input.maxContextTokens && input.maxContextTokens > 0) {
    set("CLAUDE_CODE_MAX_CONTEXT_TOKENS", String(input.maxContextTokens));
  } else if ("CLAUDE_CODE_MAX_CONTEXT_TOKENS" in env) {
    delete env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"];
    changes.push("CLAUDE_CODE_MAX_CONTEXT_TOKENS 已移除(模型名后缀已表达窗口)");
  }

  doc.env = env;
  return { text: JSON.stringify(doc, null, 2) + "\n", changes };
}

export type ClaudeStatus = {
  settingsExists: boolean;
  baseUrl: string | null;
  authTokenSet: boolean;
  model: string | null;
  haikuModel: string | null;
  sonnetModel: string | null;
  opusModel: string | null;
  fableModel: string | null;
  subagentModel: string | null;
  smallFastSet: boolean;
};

/** 从 settings.json 文本解析 Claude 状态(纯)。 */
export function parseClaudeStatus(text: string): ClaudeStatus {
  let env: Record<string, unknown> = {};
  try {
    const doc = JSON.parse(text) as { env?: Record<string, unknown> };
    env = doc.env ?? {};
  } catch {
    // 非法/缺失
  }
  const get = (k: string): string | null => {
    const v = env[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return {
    settingsExists: text.trim().length > 0,
    baseUrl: get("ANTHROPIC_BASE_URL"),
    authTokenSet: Boolean(get("ANTHROPIC_AUTH_TOKEN")),
    model: get("ANTHROPIC_MODEL"),
    haikuModel: get("ANTHROPIC_DEFAULT_HAIKU_MODEL"),
    sonnetModel: get("ANTHROPIC_DEFAULT_SONNET_MODEL"),
    opusModel: get("ANTHROPIC_DEFAULT_OPUS_MODEL"),
    fableModel: get("ANTHROPIC_DEFAULT_FABLE_MODEL"),
    subagentModel: get("CLAUDE_CODE_SUBAGENT_MODEL"),
    smallFastSet: "ANTHROPIC_SMALL_FAST_MODEL" in env,
  };
}
