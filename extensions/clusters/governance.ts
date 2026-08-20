/**
 * governance 工作集群（DESIGN.md §5）：安全钩子 + 规则注入 + 命令族。
 *
 * - tool_call：拦截破坏性 shell；拦截会阻塞 agent 的 auth login（无 --no-wait）。
 * - tool_result：lark-cli 输出密钥脱敏。
 * - before_agent_start：把企业操作规则注入系统提示（配合 skills/coworker）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "../core/lark.ts";
import { detectDestructiveShell, detectBlockingAuthLogin, policyRules } from "../core/safety.ts";

export const ENTERPRISE_RULES = `[企业就绪规则 pi-coworker —— 必须遵守]
1. 飞书操作一律通过 coworker_* 工具编排 lark-cli；不要手写 lark-cli 命令绕过工具（除非工具无法覆盖且已获用户同意）。
2. 权限申请只允许 catalog.json 登记过的权限 id；知识检索/抓取只允许 knowledge.json 登记过的知识源。未登记资源一律拒绝。
3. 写操作前必须先向用户确认。lark-cli 高风险写操作（退出码 10）绝不自动补 --yes，必须由用户确认。
4. 登录授权走 split-flow：展示授权链接（+二维码）后结束本轮，等用户完成授权后，再用 coworker_auth_complete 传 device_code 收尾。
5. 授权遵循最小权限：用 --scope 精确申请，不要默认申请 all。
6. 遇到权限错误不要切换身份（--as）绕过；如实报告，按 lark-cli 提示处理。
7. 企业问答只用已登记知识源的内容作答并附来源；不知道就明说，禁止编造公司政策/制度。
8. 涉及薪资、个人信息、机密数据等敏感内容，拒绝回答并提示合规边界。
9. 不输出任何密钥（appSecret、token、device_code 缓存等）；不修改 ~/.coworker 及包内 config 文件。`;

export function registerGovernance(pi: ExtensionAPI): void {
  // ---- 危险操作拦截 ----
  pi.on("tool_call", async (event, ctx) => {
    // 破坏性 shell
    if (event.toolName === "bash") {
      const input = event.input as { command?: string };
      const command = input.command ?? "";
      const why = detectDestructiveShell(command);
      if (why) {
        const ok = ctx.hasUI && ctx.ui?.confirm
          ? await ctx.ui.confirm("危险命令", `检测到破坏性操作（${why}）：\n\n${command}\n\n确认执行？`)
          : false;
        if (!ok) {
          return { block: true, reason: `已拦截破坏性 shell 操作（${why}）`, terminate: false };
        }
      }
      // lark-cli auth login 必须 split-flow
      if (policyRules().authLoginRequiresNoWait) {
        const argv = parseShellArgs(command);
        if (argv.includes("lark-cli") && detectBlockingAuthLogin(argv)) {
          return {
            block: true,
            reason:
              "lark-cli auth login 会阻塞 agent，禁止直接运行。请改用 coworker_auth_login（--no-wait 发起）→ 展示链接/二维码 → coworker_auth_complete（--device-code 完成）。",
            terminate: false,
          };
        }
      }
    }
  });

  // ---- 输出脱敏 ----
  pi.on("tool_result", (event) => {
    if (!policyRules().redactSecrets) return;
    let changed = false;
    const content = (event.content ?? []).map((c: any) => {
      if (c.type === "text" && typeof c.text === "string") {
        const redacted = redactSecrets(c.text);
        if (redacted !== c.text) {
          changed = true;
          return { ...c, text: redacted };
        }
      }
      return c;
    });
    if (changed) return { content };
  });

  // ---- 规则注入 ----
  pi.on("before_agent_start", (event) => {
    return { systemPrompt: event.systemPrompt + "\n\n" + ENTERPRISE_RULES };
  });
}

/** 简易 shell 词法切分（空格分隔，去引号），用于识别 lark-cli 参数 */
function parseShellArgs(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}
