/**
 * skills 集群：从公司知识库同步技能到本地并加载。
 *
 * 安全（DESIGN.md §5）：只允许 knowledge.json 中带 skillSync 配置的源（管理员白名单）；
 * 写本地磁盘前必须 confirmWrite；skill 名按 pi 命名规则校验。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requireCluster, confirmWrite } from "../core/safety.ts";
import {
  skillSyncSources,
  getSkillSyncSource,
  fetchSkillsFromBase,
  planSkillSync,
  writeSkills,
  companySkillsDir,
} from "../core/skillsync.ts";
import { appendAudit } from "../core/config.ts";
import { okResult, errResult } from "../core/tools.ts";

interface ToolCtx {
  hasUI?: boolean;
  ui?: { confirm(title: string, message: string): Promise<boolean> };
}

export function registerSkillsCluster(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "coworker_skill_sync",
    label: "Coworker 公司技能同步",
    description:
      "从管理员配置的公司知识库（带 skillSync 的知识源，白名单）拉取技能到本地并加载。默认 dry-run 先看差异；实际写入需用户确认。同步的技能将影响 agent 行为，只信任管理员维护的源。",
    parameters: Type.Object({
      sourceId: Type.Optional(Type.String({ description: "带 skillSync 的知识源 id；不传则用第一个" })),
      dryRun: Type.Optional(Type.Boolean({ description: "仅预览差异不写入（默认 true）" })),
      confirm: Type.Optional(Type.Boolean({ description: "显式确认写入（headless 场景；交互模式自动弹确认）" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx: ToolCtx) {
      const gate = requireCluster("knowledge");
      if (gate) return errResult(gate);

      const sources = skillSyncSources();
      if (sources.length === 0) {
        return errResult(
          "未配置可同步的知识源。请管理员在 knowledge.json 的某个源上配置 skillSync（nameField/contentField 等），只有这类源才能同步技能。",
          { whitelist: false },
        );
      }
      const source = params.sourceId ? getSkillSyncSource(params.sourceId) : sources[0];
      if (!source) {
        return errResult(
          `知识源「${params.sourceId}」未配置 skillSync 或不存在。可用源：${sources.map((s) => s.id).join(", ")}`,
          { whitelist: false },
        );
      }

      const dryRun = params.dryRun !== false;
      const targetDir = companySkillsDir();

      let fetched;
      try {
        fetched = await fetchSkillsFromBase(source);
      } catch (e: any) {
        return errResult(`读取技能源失败：${e?.message ?? e}`, {});
      }
      const plan = planSkillSync(fetched.specs, targetDir);
      const lines = [
        `源：${source.name}（${source.id}）→ ${targetDir}`,
        `待新建：${plan.toCreate.length}  ${plan.toCreate.map((s) => s.name).join(", ") || "—"}`,
        `待更新：${plan.toUpdate.length}  ${plan.toUpdate.map((s) => `${s.name}(${s.reason})`).join(", ") || "—"}`,
        `无变化：${plan.unchanged.length}  ${plan.unchanged.join(", ") || "—"}`,
        ...(plan.skipped.length ? [`跳过：${plan.skipped.length}`] : []),
        ...plan.skipped.slice(0, 8).map((s) => `  ⚠ ${s}`),
      ];

      const total = plan.toCreate.length + plan.toUpdate.length;
      if (dryRun || total === 0) {
        appendAudit({
          cluster: "skills",
          action: "skill_sync",
          resource: source.id,
          result: total === 0 ? "ok" : "pending",
          detail: { dryRun, create: plan.toCreate.length, update: plan.toUpdate.length },
        });
        lines.push(
          "",
          total > 0
            ? "以上为差异预览。确认后调用 coworker_skill_sync（dryRun=false）执行写入。"
            : "本地技能已是最新，无需写入。",
        );
        return okResult(lines.join("\n"), { dryRun, plan: { create: plan.toCreate.length, update: plan.toUpdate.length, unchanged: plan.unchanged.length } });
      }

      const confirm = await confirmWrite(ctx, {
        title: "确认同步公司技能",
        message: `将从「${source.name}」写入 ${total} 个技能到 ${targetDir}。\n技能会作为 agent 指令加载，请确认来源可信。\n\n${lines.join("\n")}`,
        explicitConfirm: params.confirm,
      });
      if (!confirm.ok) {
        return errResult(`已取消：${confirm.reason ?? "用户未确认"}`, { blocked: true });
      }

      const written = writeSkills([...plan.toCreate, ...plan.toUpdate.map((s) => ({ name: s.name, description: s.description, body: s.body }))], targetDir);
      appendAudit({
        cluster: "skills",
        action: "skill_sync",
        resource: source.id,
        result: "ok",
        detail: { written },
      });
      return okResult(
        `✅ 已写入 ${written.length} 个技能到 ${targetDir}：${written.join(", ")}。\n重新加载后生效（可用 /reload 或重启 pi 使新技能可见）。`,
        { written },
      );
    },
  });
}
