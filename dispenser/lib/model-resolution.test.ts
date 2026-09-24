// 模型解析链测试(node:test,零依赖)。重点:网关兼容层的生效与「让位于用户 override」。
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildResolvedModels, gatewayOverlayFor, resolveModel, type ModelOverride } from "./model-resolution.ts";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

describe("网关兼容层 gpt-6-luna", () => {
  it("省略 reasoning_effort 即 400 → 一律显式 none,且不漏档", () => {
    const { model } = resolveModel("gpt-6-luna", {});
    // 该网关 chat 路由:tools×reasoning 互斥,且省略按非 none 默认处理。
    // 所以 supportsReasoningEffort 必须为 true(pi 才会真的发这个参数),且 7 档全覆盖。
    assert.equal(model.compat.supportsReasoningEffort, true);
    assert.equal(model.compat.maxTokensField, "max_completion_tokens"); // canonical 的键不被冲掉
    assert.equal(model.reasoning, true); // 仍是推理模型(能力不变,只是不发 effort)
    for (const lv of LEVELS) assert.equal(model.thinkingLevelMap?.[lv], "none", `档位 ${lv} 未映射`);
    assert.equal(Object.keys(model.thinkingLevelMap ?? {}).length, LEVELS.length);
  });

  it("buildResolvedModels(实际调用入口)同样生效", () => {
    // 注意:buildResolvedModels 返回 { model, source } 包装(axon 返回裸 model)。
    const [{ model: m }] = buildResolvedModels(["gpt-6-luna"], {});
    assert.equal(m.compat.supportsReasoningEffort, true);
    assert.equal(m.thinkingLevelMap?.max, "none");
  });

  it("用户 override 逐字段压过兼容层", () => {
    // 场景:网关修好了,但用户不想等本仓库发版 → 用 magene-model-overrides.json 反向覆盖。
    const override: ModelOverride = {
      thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
      compat: { supportsReasoningEffort: true },
    };
    const { model } = resolveModel("gpt-6-luna", { override });
    assert.equal(model.thinkingLevelMap?.medium, "medium");
    assert.equal(model.thinkingLevelMap?.off, null);
  });

  it("override 未涉及的字段仍由兼容层补齐", () => {
    const { model } = resolveModel("gpt-6-luna", { override: { name: "显示名" } });
    assert.equal(model.name, "显示名");
    assert.equal(model.compat.supportsReasoningEffort, true);
    assert.equal(model.thinkingLevelMap?.high, "none");
  });

  it("未命中的模型不被改写(gpt-5.6-luna / 未知模型)", () => {
    assert.equal(gatewayOverlayFor("gpt-5.6-luna"), undefined);
    const { model: five } = resolveModel("gpt-5.6-luna", {});
    assert.notEqual(five.compat.supportsReasoningEffort, true);
    assert.equal(five.thinkingLevelMap, undefined);

    const { model: unknown } = resolveModel("some-gateway-model", {});
    assert.equal(unknown.compat.supportsReasoningEffort, false); // DEFAULT_COMPAT 兜底
    assert.equal(unknown.thinkingLevelMap, undefined);
  });

  it("每条 overlay 都带 reason(证据与失效条件可追溯)", () => {
    const o = gatewayOverlayFor("gpt-6-luna");
    assert.ok(o?.reason.includes("reasoning_effort"));
    assert.ok(o?.reason.includes("失效条件"));
  });
});
