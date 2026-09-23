// 模型解析链:推断 + 合并 + resolveModel(从 index.ts 迁出;remote 层由 Task 4 追加)
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

export type ModelSource = "override" | "remote" | "known" | "inferred";

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
    remote: resolved.filter((e) => e.source === "remote").length,
    inferred: resolved.filter((e) => e.source === "inferred").length,
    override: resolved.filter((e) => e.source === "override").length,
  };
}

export function resolveModel(
  id: string,
  options: { override?: ModelOverride; remote?: ModelMeta },
): { model: ResolvedModel; source: ModelSource } {
  const { override, remote } = options;
  const known = KNOWN_MODELS[id];
  const inferred = inferFromId(id);

  const reasoning = override?.reasoning ?? remote?.reasoning ?? known?.reasoning ?? inferred.reasoning ?? false;
  const thinkingLevelMap = override?.thinkingLevelMap ?? remote?.thinkingLevelMap ?? known?.thinkingLevelMap ?? inferred.thinkingLevelMap;
  const modelCompat = mergeCompat(inferred.compat, known?.compat, remote?.compat, override?.compat);
  const input: InputType[] = override?.input ?? remote?.input ?? known?.input ?? inferred.input ?? ["text"];
  const contextWindow = override?.contextWindow ?? remote?.contextWindow ?? known?.contextWindow ?? inferred.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = override?.maxTokens ?? remote?.maxTokens ?? known?.maxTokens ?? inferred.maxTokens ?? DEFAULT_MAX_TOKENS;
  const name = override?.name ?? remote?.name ?? known?.name ?? id;
  const cost = remote?.cost ?? known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const source: ModelSource = override ? "override" : remote ? "remote" : known ? "known" : "inferred";

  return {
    source,
    model: {
      id,
      name,
      reasoning,
      input,
      cost,
      contextWindow,
      maxTokens,
      thinkingLevelMap,
      compat: modelCompat,
    },
  };
}

export function buildResolvedModels(
  ids: string[],
  overrides: Record<string, ModelOverride>,
  remoteModels?: Record<string, ModelMeta>,
) {
  return ids.map((id) => resolveModel(id, { override: overrides[id], remote: remoteModels?.[id] }));
}
