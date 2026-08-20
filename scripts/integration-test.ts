/**
 * 集成测试（开发用）：加载扩展（jiti），直接调用各工具 execute 验证真实 lark-cli 交互。
 * ⚠️ 需要本机已配置 lark-cli（真实飞书登录）才能跑通；默认 npm test 不含本测试。
 * 只调用只读工具（check_env / auth_status / knowledge_search / knowledge_fetch / perm_list / perm_check）。
 */
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });

interface ToolDef {
  name: string;
  execute: (id: string, params: any, signal?: any, onUpdate?: any, ctx?: any) => Promise<any>;
}

async function main() {
  const tools = new Map<string, ToolDef>();
  const pi: any = {
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    registerCommand() {},
    on() {},
    sendUserMessage() {},
  };
  const mod = await jiti.import(join(here, "../extensions/index.ts"), { default: true });
  ((mod as any).default ?? mod)(pi);

  const ctx = { hasUI: false }; // 非交互：写操作会被 fail-closed（这里只用只读工具）
  const noop = () => {};
  const summary: string[] = [];

  async function run(name: string, params: any) {
    const def = tools.get(name);
    if (!def) throw new Error(`工具不存在: ${name}`);
    const r = await def.execute("test", params, undefined, noop, ctx);
    const text = r?.content?.[0]?.text ?? "(无输出)";
    summary.push(`\n========== ${name} ==========\n${text}`);
    return r;
  }

  await run("coworker_check_env", {});
  await run("coworker_auth_status", { verify: true });

  // 知识检索/抓取（公司全员知识库）
  const search = await run("coworker_knowledge_search", { query: "入职", sourceId: "policies", limit: 3 });
  await run("coworker_knowledge_fetch", { sourceId: "policies", locator: "REPLACE_WIKI_NODE_TOKEN" });
  void search;

  // 权限目录/检查（catalog 为占位值，应返回“未具备/目录列出”而非崩溃）
  await run("coworker_perm_list", {});
  await run("coworker_perm_check", { id: "wiki_engineering" });

  // 新增：知识权限盘点（真实用户角色）
  await run("coworker_perm_scan", { includeDocs: true });

  // 新增：公司技能相关（无 skillSync 源，应提示未配置；本地目录读取）
  await run("coworker_skill_sync", { dryRun: true });

  // 新增：个人 Bot 开通检查（只读）
  await run("coworker_bot_setup", {});

  console.log(summary.join("\n"));
  console.log("\n✅ 集成测试完成");
}

main().catch((e) => {
  console.error("❌ 集成测试失败:", e);
  process.exit(1);
});
