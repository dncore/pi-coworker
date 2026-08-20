/**
 * onboarding 工作集群：引导安装 lark-cli、初始化配置、split-flow 登录、状态校验。
 *
 * 登录走 split-flow（lark-shared 规则）：
 *   coworker_auth_login（--no-wait --json）→ 展示 URL + 二维码 → 结束本轮
 *   → 用户完成授权后，coworker_auth_complete（--device-code）收尾。
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runLark, describeLarkError, LARK_ENV, userIdentityOf, countScopes, dataOf } from "../core/lark.ts";
import { patchUserConfig } from "../core/config.ts";
import { policyRules } from "../core/safety.ts";
import { okResult, errResult, refreshIdentity } from "../core/tools.ts";

const QR_DIR = ".coworker";

function toLines(arr: string[]): string {
  return arr.filter((l) => l !== "" && l != null).join("\n");
}

function qrRelPath(prefix: string): string {
  return join(QR_DIR, `${prefix}-${Date.now()}.png`);
}

export function registerOnboarding(pi: ExtensionAPI): void {
  // ---------------------------------------------------------------
  // coworker_check_env —— 环境检查清单
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_check_env",
    label: "Coworker 环境检查",
    description:
      "检查企业就绪环境：lark-cli 是否安装、配置是否初始化、登录态与授权 scope。入职引导第一步。",
    parameters: Type.Object({}),
    async execute() {
      const lines: string[] = [];
      const summary: Record<string, string> = {};

      // 1) lark-cli 是否安装
      const ver = await runLark(["--version"], { timeoutMs: 15_000 });
      if (ver.exitCode === -1) {
        lines.push("❌ lark-cli 未安装");
        lines.push("   安装：npm install -g @larksuite/cli（或运行公司 bootstrap.sh）");
        summary.larkCli = "missing";
        return okResult(lines.join("\n"), summary);
      }
      const version = (ver.stdout || ver.stderr || "?").trim().split("\n")[0] ?? "?";
      lines.push(`✅ lark-cli 已安装（${version}）`);
      summary.larkCli = "installed";

      // 2) 配置是否初始化
      const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
      if (cfg.ok) {
        lines.push("✅ lark-cli 配置已初始化");
        summary.config = "initialized";
      } else {
        lines.push("❌ lark-cli 配置未初始化（需运行 coworker_config_init 或 lark-cli config init --new）");
        summary.config = "missing";
        return okResult(lines.join("\n"), summary);
      }

      // 3) 登录态
      const auth = await runLark(["auth", "status", "--json", "--verify"], { as: "user", timeoutMs: 60_000 });
      const u = userIdentityOf(auth.envelope);
      if (auth.ok && u) {
        const scopes = countScopes(u.scope);
        lines.push(`✅ 已登录：${u.userName ?? u.openId ?? "?"}（user 身份）`);
        lines.push(`   授权 scope 数：${scopes}；token 状态：${u.tokenStatus ?? "unknown"}`);
        // 回写身份到用户配置
        patchUserConfig({
          user: {
            openId: u.openId,
            name: u.userName,
            userId: u.userId,
            email: u.email,
          },
        });
        summary.auth = "logged-in";
        summary.openId = u.openId;
      } else {
        lines.push("❌ 未登录（需运行 coworker_auth_login 完成授权）");
        if (auth.envelope?.error) lines.push(`   ${describeLarkError(auth)}`);
        summary.auth = "not-logged-in";
      }

      return okResult(lines.join("\n"), summary);
    },
  });

  // ---------------------------------------------------------------
  // coworker_config_init —— 初始化 lark-cli 应用配置（后台发起 + 捕获授权链接）
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_config_init",
    label: "Coworker 配置初始化",
    description:
      "初始化 lark-cli 应用配置：后台发起 lark-cli config init --new，捕获授权 URL 并生成二维码。进程会在用户完成授权后于后台自动写入配置。",
    parameters: Type.Object({
      forceInit: Type.Optional(
        Type.Boolean({ description: "在 Agent 工作目录（OPENCLAW_HOME/HERMES_HOME）下强制初始化（默认 false，优先走 config bind）" }),
      ),
      withQr: Type.Optional(Type.Boolean({ description: "生成二维码 PNG（默认 true）" })),
    }),
    async execute(_id, params) {
      const forceInit = params.forceInit === true;
      const withQr = params.withQr !== false;

      const args = ["config", "init"];
      if (forceInit || (!process.env.OPENCLAW_HOME && !process.env.HERMES_HOME)) {
        args.push("--new");
        if (process.env.OPENCLAW_HOME || process.env.HERMES_HOME) args.push("--force-init");
      } else {
        args.push("bind");
      }

      const url = await captureVerificationUrl(args);
      if (!url.ok) {
        return errResult(
          `未能从 lark-cli 输出中捕获授权链接。\n${url.output}\n\n` +
            `请让用户手动运行：\n  lark-cli config init --new\n或由管理员统一配置 lark-cli 后跳过此步。`,
          { captured: false },
        );
      }

      let qr = "";
      if (withQr) qr = await writeQr(url.url, "qr-config");
      const lines = [
        `✅ 已发起配置初始化，授权链接：`,
        `   ${url.url}`,
        qr ? `   二维码已生成：${qr}` : "",
        ``,
        `【请把上面的链接（和二维码）发给用户，让用户打开并完成授权。】`,
        `授权完成后 lark-cli 会在后台自动写入配置；然后调用 coworker_check_env 确认。`,
      ].filter(Boolean);
      return okResult(lines.join("\n"), { url: url.url, qr, captured: true });
    },
  });

  // ---------------------------------------------------------------
  // coworker_auth_login —— split-flow 第一步：发起授权
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_auth_login",
    label: "Coworker 登录发起",
    description:
      "发起飞书登录授权（split-flow 第一步）：返回授权链接与 device_code，并生成二维码。必须把链接+二维码展示给用户、结束本轮，等用户完成授权后再调用 coworker_auth_complete。",
    parameters: Type.Object({
      scopes: Type.Optional(Type.String({ description: "要申请的 scope，空格或逗号分隔，如 'wiki:wiki:readonly drive:drive:readonly'" })),
      domains: Type.Optional(Type.String({ description: "要授权的业务域，逗号分隔，如 'wiki,drive,base,docs'；与 scopes 二选一或叠加" })),
      withQr: Type.Optional(Type.Boolean({ description: "生成二维码 PNG（默认 true）" })),
    }),
    async execute(_id, params) {
      const scopes = (params.scopes ?? "").trim();
      const domains = (params.domains ?? "").trim();

      // 最小权限：必须显式指定范围
      const rules = policyRules();
      if (rules.minimalScopeLogin && !scopes && !domains) {
        return errResult(
          "必须指定授权范围（最小权限原则）。请用 scopes 参数（如 'wiki:wiki:readonly drive:drive:readonly'）" +
            "或 domains 参数（如 'wiki,drive,base,docs'）发起授权。",
          { needScopes: true },
        );
      }

      const args = ["auth", "login", "--no-wait", "--json"];
      if (scopes) args.push("--scope", scopes);
      if (domains) args.push("--domain", domains);

      const r = await runLark(args, { timeoutMs: 60_000 });
      const data = r.envelope?.data ?? r.envelope;
      const url = data?.verification_url ?? data?.verification_uri_complete ?? data?.verificationUri;
      const deviceCode = data?.device_code ?? data?.deviceCode;
      if (!r.ok || !url) {
        return errResult(`发起授权失败：${describeLarkError(r)}`, {});
      }
      if (!deviceCode) {
        return errResult("授权已发起但未返回 device_code，无法在后续完成登录。请重试。", {});
      }

      let qr = "";
      if (params.withQr !== false) qr = await writeQr(url, "qr-login");

      const lines = [
        `🔗 请在浏览器打开授权链接：`,
        `   ${url}`,
        qr ? `   （二维码已生成：${qr}）` : "",
        ``,
        `【分两步完成登录】请把链接（和二维码）发给用户，让用户完成授权；`,
        `用户确认已授权后，再调用 coworker_auth_complete 并传 device_code=${deviceCode} 完成登录。`,
      ].filter(Boolean);
      return okResult(lines.join("\n"), { url, qr, deviceCode, pending: true });
    },
  });

  // ---------------------------------------------------------------
  // coworker_auth_complete —— split-flow 第二步：完成授权
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_auth_complete",
    label: "Coworker 登录完成",
    description:
      "用 coworker_auth_login 拿到的 device_code 完成登录（split-flow 第二步，在用户已授权后调用）。成功后写入用户身份信息。",
    parameters: Type.Object({
      deviceCode: Type.String({ description: "coworker_auth_login 返回的 device_code" }),
    }),
    async execute(_id, params) {
      const r = await runLark(["auth", "login", "--device-code", params.deviceCode, "--json"], {
        as: "user",
        timeoutMs: 240_000,
      });
      if (!r.ok) {
        return errResult(`完成登录失败：${describeLarkError(r)}`, {});
      }
      const id = await refreshIdentity();
      patchUserConfig({
        user: {
          openId: id.openId,
          name: id.name,
          email: id.email,
          userId: id.userId,
        },
      });
      return okResult(`✅ 登录完成。${id.message}\n身份信息已写入用户配置，可调用 coworker_check_env 复核。`, {
        openId: id.openId,
        name: id.name,
      });
    },
  });

  // ---------------------------------------------------------------
  // coworker_bot_setup —— 个人 Bot 开通向导（应用 + 事件订阅 + 能力）
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_bot_setup",
    label: "Coworker 个人 Bot 开通",
    description:
      "开通你的个人飞书 Bot：确认个人应用已配置、给出控制台需启用的两个事件与机器人能力、检查事件总线状态，并指引启动守护进程后在飞书私聊你的 Bot。",
    parameters: Type.Object({
      withQr: Type.Optional(Type.Boolean({ description: "是否生成登录二维码（默认 true）" })),
    }),
    async execute(_id, params) {
      void params;
      const lines: string[] = [];
      const detail: Record<string, unknown> = {};

      // 1) 应用配置
      const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
      const data = cfg.envelope?.data ?? cfg.envelope ?? {};
      const appId: string | undefined = data.appId ?? data.app_id;
      const brand: string | undefined = data.brand;
      if (!cfg.ok || !appId) {
        return errResult(
          toLines([
            "❌ 尚未配置个人应用（即个人 Bot）。请先运行：",
            "   lark-cli config init --new",
            "它会创建你的个人飞书应用并写入配置（按提示在浏览器完成）。",
            "完成后再调用 coworker_bot_setup。",
          ]),
          { appConfigured: false },
        );
      }
      detail.appId = appId;
      lines.push(`✅ 个人应用已配置：${appId}（brand=${brand ?? "feishu"}）`);

      // 2) 控制台需启用的事项
      const consoleHost = brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
      const consoleUrl = `${consoleHost}/app/${appId}/event`;
      lines.push(toLines([
        ``,
        `【控制台三件事】（开发者后台 → 应用 ${appId}）`,
        `1. 事件与回调 → 启用：im.message.receive_v1、card.action.trigger`,
        `   链接：${consoleUrl}`,
        `2. 应用能力 → 添加「机器人」（否则飞书里搜不到它）`,
        `3. 版本管理与发布 → 创建版本并发布（个人自用通常即时生效）`,
      ]));
      detail.consoleUrl = consoleUrl;

      // 3) 事件总线状态
      const es = await runLark(["event", "status", "--json"], { timeoutMs: 30_000 });
      const apps: any[] = dataOf(es.envelope)?.apps ?? [];
      const bus = apps.find((a: any) => String(a.app_id) === appId);
      const running = bus?.running === true;
      detail.busRunning = running;
      lines.push(
        ``,
        running
          ? "✅ 事件总线运行中（守护进程已连接，事件可送达）"
          : "⚠️ 事件总线未运行：需启动 Bot Agent 守护进程才能收消息（见下一步）",
      );

      // 4) 下一步
      lines.push(
        ``,
        toLines([
          `【下一步】`,
          `1. 完成上面控制台三件事。`,
          `2. 启动守护进程（个人本地 Bot）：`,
          `   cd <本项目>/agent && RUN_MODE=local node src/index.ts`,
          `3. 在飞书里搜索你的应用名并「私聊」它，开始提问。`,
          `4. 可用 coworker_check_env 复查；也可再次调用 coworker_bot_setup 查看状态。`,
        ]),
      );

      return okResult(lines.join("\n"), detail);
    },
  });

  // ---------------------------------------------------------------
  // coworker_auth_status —— 查看登录态
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_auth_status",
    label: "Coworker 登录状态",
    description: "查看当前登录态、身份、token 有效性、已授权 scope（可选 --verify 服务端校验）。",
    parameters: Type.Object({
      verify: Type.Optional(Type.Boolean({ description: "是否向服务端校验 token 有效性（默认 true）" })),
    }),
    async execute(_id, params) {
      const args = ["auth", "status", "--json"];
      if (params.verify !== false) args.push("--verify");
      const r = await runLark(args, { as: "user", timeoutMs: 60_000 });
      const u = userIdentityOf(r.envelope);
      if (!r.ok || !u) {
        return errResult(`未登录或查询失败：${describeLarkError(r)}`, {});
      }
      const scopes = typeof u.scope === "string" ? u.scope.trim().split(/\s+/).filter(Boolean) : Array.isArray(u.scope) ? u.scope : [];
      const shown = scopes.slice(0, 12).join(", ");
      const more = scopes.length > 12 ? `, …（共 ${scopes.length} 个）` : "";
      const lines = [
        `用户：${u.userName ?? u.name ?? "?"}`,
        `openId：${u.openId ?? "?"}`,
        `token 状态：${u.tokenStatus ?? (r.ok ? "valid" : "unknown")}`,
        `已授权 scope（${scopes.length}）：${shown}${more}`,
      ];
      return okResult(lines.join("\n"), {
        openId: u.openId,
        userName: u.userName,
        verified: r.ok,
        scopeCount: scopes.length,
      });
    },
  });
}

/** 后台发起 config init，从输出流捕获授权 URL（不杀进程，让其在用户授权后自动完成写入） */
async function captureVerificationUrl(
  args: string[],
  capMs = 180_000,
): Promise<{ ok: boolean; url: string; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn("lark-cli", args, { env: { ...process.env, ...LARK_ENV } });
    const urlRe = /"verification_uri_complete"\s*:\s*"([^"]+)"/;
    const urlRe2 = /"verification_url"\s*:\s*"([^"]+)"/;
    const urlRe3 = /https:\/\/[^\s"'）)]+/;

    let done = false;
    const finish = (res: { ok: boolean; url: string; output: string }) => {
      if (done) return;
      done = true;
      try {
        child.unref();
      } catch {
        /* ignore */
      }
      resolve(res);
    };

    const pump = (chunk: string) => {
      output += chunk;
      let m = output.match(urlRe) ?? output.match(urlRe2);
      let url = m?.[1];
      if (!url) {
        m = output.match(urlRe3);
        url = m?.[0];
      }
      if (url && url.length > 8) {
        finish({ ok: true, url, output });
      }
    };

    child.stdout?.on("data", (d) => pump(String(d)));
    child.stderr?.on("data", (d) => pump(String(d)));
    child.on("error", (e: any) => {
      finish({ ok: false, url: "", output: `启动失败：${e?.code ?? e?.message ?? e}` });
    });
    child.on("close", (code) => {
      if (!done) finish({ ok: false, url: "", output: `进程提前退出（code=${code}）：\n${output}` });
    });

    setTimeout(() => {
      if (!done) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        finish({ ok: false, url: "", output: `超过 ${capMs / 1000}s 未捕获授权链接。输出：\n${output}` });
      }
    }, capMs);
  });
}

/** 生成二维码 PNG（相对 cwd 路径，符合 lark-cli 相对路径限制） */
async function writeQr(url: string, prefix: string): Promise<string> {
  try {
    mkdirSync(QR_DIR, { recursive: true });
    const rel = qrRelPath(prefix);
    const r = await runLark(["auth", "qrcode", url, "--output", rel], { timeoutMs: 30_000 });
    if (r.ok) return rel;
    return "";
  } catch {
    return "";
  }
}
