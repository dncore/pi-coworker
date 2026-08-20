/**
 * 冒烟测试：用 jiti（pi 的加载器）加载扩展入口，用 mock pi 验证
 * 工具/命令/事件钩子全部注册成功、无运行时错误。
 */
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });

async function main() {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: Record<string, number> = {};
  const handlers: Record<string, any> = {};

  const pi: any = {
    registerTool(def: any) {
      tools.push(def.name);
      if (typeof def.execute !== "function") throw new Error(`tool ${def.name} missing execute`);
      handlers[`tool:${def.name}`] = def;
    },
    registerCommand(name: string, def: any) {
      commands.push(name);
      if (typeof def.handler !== "function") throw new Error(`command ${name} missing handler`);
      handlers[`cmd:${name}`] = def;
    },
    on(ev: string, h: any) {
      events[ev] = (events[ev] ?? 0) + 1;
      handlers[`ev:${ev}`] = h;
    },
    sendUserMessage() {},
  };

  const mod = await jiti.import(join(here, "../extensions/index.ts"), { default: true });
  const factory = (mod as any).default ?? mod;
  factory(pi);

  console.log(`✅ tools (${tools.length}): ${tools.sort().join(", ")}`);
  console.log(`✅ commands (${commands.length}): ${commands.sort().join(", ")}`);
  console.log(`✅ events: ${Object.entries(events).map(([k, v]) => `${k}(${v})`).join(", ")}`);

  const expect = [
    "coworker_check_env", "coworker_config_init", "coworker_auth_login", "coworker_auth_complete", "coworker_auth_status",
    "coworker_bot_setup",
    "coworker_perm_list", "coworker_perm_check", "coworker_perm_apply", "coworker_perm_status", "coworker_perm_my", "coworker_perm_scan",
    "coworker_knowledge_search", "coworker_knowledge_fetch",
    "coworker_skill_sync",
  ];
  for (const t of expect) {
    if (!tools.includes(t)) throw new Error(`missing tool ${t}`);
  }
  for (const c of ["coworker:setup", "coworker:status", "coworker:perm", "coworker:audit", "coworker:skills", "coworker:bot", "coworker"]) {
    if (!commands.includes(c)) throw new Error(`missing command ${c}`);
  }
  for (const e of ["tool_call", "tool_result", "before_agent_start", "resources_discover"]) {
    if (!events[e]) throw new Error(`missing event hook ${e}`);
  }

  // 校验每个工具都能解析参数 schema（typebox 会抛错如果 schema 非法）
  for (const t of expect) {
    const def = handlers[`tool:${t}`];
    if (def.parameters) {
      try {
        JSON.stringify(def.parameters);
      } catch (e: any) {
        throw new Error(`tool ${t} schema not serializable: ${e.message}`);
      }
    }
  }

  console.log("✅ 冒烟测试通过");
}

main().catch((e) => {
  console.error("❌ 冒烟测试失败:", e);
  process.exit(1);
});
