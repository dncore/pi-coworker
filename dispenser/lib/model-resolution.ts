// 模型解析链:推断 + 合并 + resolveModel。
// 元数据来源(优先级):override(用户覆盖文件, ~/.coworker/pi-agent/magene-model-overrides.json)
//   > known(内置表 KNOWN_MODELS —— 构建期由 scripts/sync-model-meta.mjs 从 canonical gist 生成)
//   > inferred(按 id 推断)。
// 注:上游的「配置服务器下发」层(remote)在本仓已废弃,相关代码不再保留。
import type { CompatConfig, InputType, ModelMeta, ThinkingLevel, ThinkingValue } from "./known-models.ts";
import { DEFAULT_COMPAT, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, KNOWN_MODELS } from "./known-models.ts";

export type ModelOverride = {
  name?: string;
  reasoning?: boolean;
  input?: InputType[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, ThinkingValue>>;
  compat?: CompatConfig;
};

export type ResolvedModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: InputType[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, ThinkingValue>>;
  compat: CompatConfig;
};

export type ModelSource = "override" | "known" | "inferred";

interface InferredMeta {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, ThinkingValue>>;
  compat: CompatConfig;
  input: InputType[];
  contextWindow: number;
  maxTokens: number;
}

function inferFromId(id: string): InferredMeta {
  const lower = id.toLowerCase();

  // -- Vision-capable --
  const isVision =
    /vl|vision|glm-4v|glm-4\.\d+v|qvq/i.test(lower) ||
    /claude|gemini|gpt-4o|o\d/i.test(lower);

  // -- Reasoning & thinking format --
  if (/deepseek.*r1|deepseek-reasoner/i.test(lower)) {
    return {
      reasoning: true,
      compat: {
        supportsReasoningEffort: true,
        thinkingFormat: "deepseek",
        requiresReasoningContentOnAssistantMessages: true,
        reasoningEffortMap: {
          minimal: "high",
          low: "high",
          medium: "high",
          high: "high",
          xhigh: "max",
        },
      },
      input: isVision ? ["text", "image"] : ["text"],
      contextWindow: 131072,
      maxTokens: 32768,
    };
  }

  if (/deepseek/i.test(lower)) {
    return {
      reasoning: false,
      compat: { requiresReasoningContentOnAssistantMessages: true },
      input: isVision ? ["text", "image"] : ["text"],
      contextWindow: 128000,
      maxTokens: 8192,
    };
  }

  if (/qwen/i.test(lower)) {
    return {
      reasoning: true,
      compat: { thinkingFormat: "qwen" },
      input: isVision ? ["text", "image"] : ["text"],
      // qwen3+ 全部为 1M ctx / 65k max；qwen3.7-flash / qwen3.8-flash / qwen3.8-max 例外为 131k max（已知条目覆盖）
      contextWindow: 1000000,
      maxTokens: 65536,
    };
  }

  // Moonshot Kimi 系列：K2.5 起均支持 reasoning；maxTokens 按官方 / 经验估为 96k 量级
  if (/kimi/i.test(lower)) {
    return {
      reasoning: true,
      compat: {},
      input: isVision ? ["text", "image"] : ["text"],
      contextWindow: 256000,
      maxTokens: 96000,
    };
  }

  // GLM 家族按版本号推断（KNOWN_MODELS 未覆盖的新版本兜底）：
  // - 视觉模型（glm-4v / glm-4.xv）：32k ctx / 8k max，仅文本+图像
  // - glm-4.7+：200k ctx / 131k max，推理开启
  // - glm-5.0/5.1：200k ctx / 131k max，推理开启
  // - glm-5.2 起（含未来 5.4/5.5、6.x）：1M ctx / 131k max，推理开启 + reasoning_effort
  //   （ctx 取「不低于前一个已发布版本」的 1M 锚点，避免新版本回落到旧规格）
  // - 其余 glm-4.x：200k ctx / 8k max，非推理
  if (/glm/i.test(lower)) {
    if (isVision) {
      return {
        reasoning: false,
        compat: {},
        input: ["text", "image"],
        contextWindow: 32768,
        maxTokens: 8192,
      };
    }
    const ver = lower.match(/^glm-(\d+)(?:\.(\d+))?/);
    const major = ver ? Number(ver[1]) : 4;
    const minor = ver && ver[2] !== undefined ? Number(ver[2]) : 0;
    // 1M ctx 锚点：glm-5.2 起；版本高于或等于锚点的一律按最新规格兜底
    if (major > 5 || (major === 5 && minor >= 2)) {
      return {
        reasoning: true,
        compat: { supportsReasoningEffort: true },
        input: ["text"],
        contextWindow: 1048576,
        maxTokens: 131072,
      };
    }
    if (major === 5 || (major === 4 && minor >= 7)) {
      return {
        reasoning: true,
        compat: {},
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 131072,
      };
    }
    return {
      reasoning: false,
      compat: {},
      input: ["text"],
      contextWindow: 200000,
      maxTokens: 8192,
    };
  }

  if (/doubao/i.test(lower)) {
    return {
      reasoning: /1\.5/i.test(lower),
      compat: {},
      input: isVision ? ["text", "image"] : ["text"],
      contextWindow: 256000,
      maxTokens: 16384,
    };
  }

  if (/claude|gpt|gemini|o\d/i.test(lower)) {
    return {
      reasoning: /sonnet-4|o\d|o4/i.test(lower),
      compat: {},
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 16384,
    };
  }

  // -- Generic fallback --
  return {
    reasoning: false,
    compat: {},
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

// ---------------------------------------------------------------------------
// 网关兼容层:canonical 表(lib/known-models.ts 的 @model-meta 段)只记模型官方规格,
// 这里放「某模型经某网关渠道实测后的请求形状修正」。不入 canonical、不受 sync:models
// 覆盖;渠道或网关修好后删掉对应条目即回到原生形状。
// 同一份修正还要存在于:axon-llm-dispenser/src/core/models.ts、pi-agent-dispenser、
// 本仓 extensions/core/magene.ts、magene-ai-dispenser/internal/modelmeta/meta.go
// —— 改一处必须改四处。
// ---------------------------------------------------------------------------

export type GatewayOverlay = {
  /** 修正理由 + 实测证据 + 失效条件。改这条必须连证据一起更新,否则后人无法判断能否删。 */
  reason: string;
  compat?: CompatConfig;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, ThinkingValue>>;
};

/** 只按精确 id 匹配:正则误伤一个模型的思考档位,比漏配一条更难排查。 */
const GATEWAY_OVERLAYS: Record<string, GatewayOverlay> = {
  "gpt-6-luna": {
    reason:
      "迈金网关 gpt-6-luna(owned_by 七牛)的 /chat/completions 路由上 function tools 与 reasoning_effort 互斥," +
      "且请求**省略**该参数时按非 none 默认处理 → 任何带工具的 agent 客户端必 400(实测 2026-09-24:省略/low/medium/high" +
      " 均 400,流式还被降级成 200 + 无信息量的「Provider returned 400」;显式 none 正常出 finish_reason=tool_calls)。" +
      "报错建议的 /v1/responses 在同一网关也被卡:它把 Responses 请求转成 chat 并注入 thinking 参数 → 400" +
      "「Unknown parameter: 'thinking'」,无法改走 Responses 保思考。故 off 也必须显式发 none。" +
      "失效条件:网关在同模型的 chat 路由上允许 tools×非 none reasoning_effort(或 /responses 不再注入 thinking)后删本条。",
    compat: { supportsReasoningEffort: true },
    thinkingLevelMap: { off: "none", minimal: "none", low: "none", medium: "none", high: "none", xhigh: "none", max: "none" },
  },
};

/** 某模型是否命中网关兼容层(供日志/摘要说明「思考档被强制改写」及其原因)。 */
export function gatewayOverlayFor(id: string): GatewayOverlay | undefined {
  return GATEWAY_OVERLAYS[id];
}

// ---------------------------------------------------------------------------

export function mergeCompat(...parts: Array<CompatConfig | undefined>): CompatConfig {
  return Object.assign({}, DEFAULT_COMPAT, ...parts);
}

/** 是否为 DeepSeek 系模型(pi/omp 走 DeepSeek 官方特配)。 */
export function isDeepseekModel(id: string): boolean {
  return /deepseek/i.test(id);
}

export function countBySource(resolved: Array<{ source: ModelSource; model: ResolvedModel }>) {
  return {
    known: resolved.filter((e) => e.source === "known").length,
    inferred: resolved.filter((e) => e.source === "inferred").length,
    override: resolved.filter((e) => e.source === "override").length,
  };
}

export function resolveModel(
  id: string,
  options: { override?: ModelOverride },
): { model: ResolvedModel; source: ModelSource } {
  const { override } = options;
  const known = KNOWN_MODELS[id];
  const inferred = inferFromId(id);

  const reasoning = override?.reasoning ?? known?.reasoning ?? inferred.reasoning ?? false;
  const thinkingLevelMap = override?.thinkingLevelMap ?? known?.thinkingLevelMap ?? inferred.thinkingLevelMap;
  const modelCompat = mergeCompat(inferred.compat, known?.compat, override?.compat);
  const input: InputType[] = override?.input ?? known?.input ?? inferred.input ?? ["text"];
  const contextWindow = override?.contextWindow ?? known?.contextWindow ?? inferred.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = override?.maxTokens ?? known?.maxTokens ?? inferred.maxTokens ?? DEFAULT_MAX_TOKENS;
  const name = override?.name ?? known?.name ?? id;
  const cost = known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const source: ModelSource = override ? "override" : known ? "known" : "inferred";

  const model: ResolvedModel = {
    id,
    name,
    reasoning,
    input,
    cost,
    contextWindow,
    maxTokens,
    thinkingLevelMap,
    compat: modelCompat,
  };
  applyGatewayOverlay(model, override);
  return { source, model };
}

/** 套用网关兼容修正:压过 known/inferred,但**逐字段让位于用户显式 override**
 * (magene-model-overrides.json 是最后一道逃生口 —— 网关修好后想反向覆盖仍然可行)。 */
function applyGatewayOverlay(model: ResolvedModel, override?: ModelOverride): void {
  const gw = GATEWAY_OVERLAYS[model.id];
  if (!gw) return;
  if (gw.thinkingLevelMap && !override?.thinkingLevelMap) {
    model.thinkingLevelMap = { ...model.thinkingLevelMap, ...gw.thinkingLevelMap };
  }
  if (gw.compat && override?.compat?.supportsReasoningEffort === undefined) {
    model.compat = mergeCompat(model.compat, gw.compat);
  }
}

export function buildResolvedModels(
  ids: string[],
  overrides: Record<string, ModelOverride>,
) {
  return ids.map((id) => resolveModel(id, { override: overrides[id] }));
}
