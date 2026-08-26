/**
 * onboarding 工作集群：引导安装 lark-cli、初始化配置、split-flow 登录、状态校验。
 *
 * 登录走 split-flow（lark-shared 规则）：
 *   coworker_auth_login（--no-wait --json）→ 展示 URL + 二维码 → 结束本轮
 *   → 用户完成授权后，coworker_auth_complete（--device-code）收尾。
 */
import { spawn } from "node:child_process";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runLark, describeLarkError, LARK_ENV, userIdentityOf, countScopes, dataOf } from "../core/lark.ts";
import { loadKnowledge, listSources } from "../core/knowledge.ts";
import { loadCatalog } from "../core/catalog.ts";
import { patchUserConfig, packageRoot, appendAudit } from "../core/config.ts";
import { policyRules, confirmWrite } from "../core/safety.ts";
import { okResult, errResult, refreshIdentity } from "../core/tools.ts";
import {
  DEFAULT_MAGENE_BASE_URL,
  MAGENE_ENV_PATH,
  resolveMageneConfig,
  readMageneEnv,
  writeMageneEnv,
  fetchMageneModels,
  buildResolvedModels,
  registerMageneProvider,
  mageneStatus,
} from "../core/magene.ts";

const execFile = promisify(execFileCb);

/** 运行 agent 守护进程管理 CLI（coworker-daemon） */
async function runDaemonCli(args: string[]): Promise<string> {
  const cli = join(packageRoot(), "agent", "bin", "coworker-daemon.ts");
  try {
    const { stdout, stderr } = await execFile(process.execPath, [cli, ...args], { timeout: 30_000 });
    return ((stdout || "") + (stderr || "")).trim();
  } catch (e: any) {
    return String(e?.stdout ?? e?.stderr ?? e?.message ?? e).trim();
  }
}

const QR_DIR = ".coworker";

/** 工具执行上下文的最小结构（pi 实际传入更完整，结构类型够用） */
interface ToolCtx {
  hasUI?: boolean;
  ui?: { confirm(title: string, message: string): Promise<boolean> };
}

/** 脱敏展示 API Key（保留首尾便于辨认） */
function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function toLines(arr: string[]): string {
  return arr.filter((l) => l !== "" && l != null).join("\n");
}

/** 知识源是否已由公司侧配置（非占位符） */
function listKnowledgeStatus(): { configured: boolean; count: number; unconfigured: string[] } {
  const sources = listSources();
  const unconfigured = sources
    .filter((s) => [s.baseToken, s.spaceId, s.url].some((v) => v && v.includes("REPLACE")))
    .map((s) => s.id);
  return { configured: sources.length > 0 && unconfigured.length === 0, count: sources.length, unconfigured };
}

/** 权限目录是否已由公司侧配置（非占位符） */
function listCatalogStatus(): { configured: boolean; count: number; unconfigured: string[] } {
  const perms = loadCatalog().permissions;
  const unconfigured = perms
    .filter((p) => [p.spaceId, p.url, p.token].some((v) => v && v.includes("REPLACE")))
    .map((p) => p.id);
  return { configured: perms.length > 0 && unconfigured.length === 0, count: perms.length, unconfigured };
}

function qrRelPath(prefix: string): string {
  return join(QR_DIR, `${prefix}-${Date.now()}.png`);
}

export function registerOnboarding(pi: ExtensionAPI): void {
  // ---------------------------------------------------------------
  // coworker_daemon —— 守护进程管理（pi 内直接操作）
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_daemon",
    label: "Coworker 守护进程管理",
    description:
      "管理本地 Bot Agent 守护进程：start（后台启动）/ stop / restart / status / logs / install（--autostart 配置开机自启）/ uninstall。setup 第 4 步可直接用它启动守护进程。",
    parameters: Type.Object({
      action: Type.String({ description: "start | stop | restart | status | logs | install | uninstall" }),
      autostart: Type.Optional(Type.Boolean({ description: "install 时配置开机自启" })),
      tail: Type.Optional(Type.Integer({ description: "logs 查看行数（默认 50）" })),
    }),
    async execute(_id, params) {
      const args = [params.action];
      if (params.action === "logs" && params.tail) args.push("--tail", String(params.tail));
      if (params.action === "install" && params.autostart) args.push("--autostart");
      const out = await runDaemonCli(args);
      appendAudit({ cluster: "daemon", action: `daemon_${params.action}`, resource: "daemon", result: "ok" });
      return okResult(out || "（无输出）", { action: params.action });
    },
  });

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
  // coworker_setup_status —— 入职状态机（每步真实校验，判定下一步）
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_setup_status",
    label: "Coworker 入职进度",
    description:
      "入职引导状态机：逐一校验每步是否真正完成（lark-cli/配置/登录/个人Bot/守护进程/知识源/权限目录），返回当前进度、未完成步骤及精确操作提示。setup 向导每一步前后都应调用它确认。",
    parameters: Type.Object({}),
    async execute() {
      const steps: Array<{ id: number; name: string; done: boolean; manual: boolean; skippable?: boolean; hint?: string }> = [];
      const issues: string[] = [];

      // s0 lark-cli
      const ver = await runLark(["--version"], { timeoutMs: 15_000 });
      const cliInstalled = ver.exitCode !== -1;
      steps.push({
        id: 0,
        name: "安装 lark-cli",
        done: cliInstalled,
        manual: false,
        hint: cliInstalled ? undefined : "运行：npm install -g @larksuite/cli（或公司 bootstrap.sh），装完后再检查",
      });
      if (!cliInstalled) return finish(steps, issues);

      // s1 配置初始化（个人应用）
      const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
      const appId: string | undefined = dataOf(cfg.envelope)?.appId;
      steps.push({
        id: 1,
        name: "初始化配置（创建个人应用）",
        done: cfg.ok && !!appId,
        manual: false,
        hint: cfg.ok && appId ? undefined : "调用 coworker_config_init（浏览器完成创建），或用 lark-cli config init --new",
      });
      if (!cfg.ok || !appId) return finish(steps, issues);

      // s2 用户登录
      const auth = await runLark(["auth", "status", "--json"], { as: "user", timeoutMs: 60_000 });
      const u = userIdentityOf(auth.envelope);
      const loggedIn = auth.ok && !!u?.openId;
      steps.push({
        id: 2,
        name: "用户登录授权",
        done: loggedIn,
        manual: false,
        hint: loggedIn ? undefined : "调用 coworker_auth_login（给链接+二维码）→ 用户授权 → coworker_auth_complete 完成",
      });
      if (!loggedIn) return finish(steps, issues);

      // s3 个人 Bot 控制台（手动步骤，无法 API 校验）
      steps.push({
        id: 3,
        name: "个人 Bot：控制台启用事件 + 机器人能力",
        done: false,
        manual: true,
        hint: "调用 coworker_bot_setup：按控制台三件事操作；完成后用 verify=true 发测试消息验证（这是关键手动步骤）",
      });

      // s4 守护进程（事件总线）
      const es = await runLark(["event", "status", "--json"], { timeoutMs: 30_000 });
      const busRunning = (dataOf(es.envelope)?.apps ?? []).some((a: any) => a.running === true);
      steps.push({
        id: 4,
        name: "启动 Bot Agent 守护进程",
        done: busRunning,
        manual: false,
        hint: busRunning ? undefined : "让 agent 调用 coworker_daemon start 直接启动（或手动运行 cd agent && RUN_MODE=local node src/index.ts）",
      });

      // s5 知识源（公司侧配置）
      const ks = listKnowledgeStatus();
      steps.push({
        id: 5,
        name: "知识源可访问",
        done: ks.configured,
        skippable: !ks.configured,
        manual: false,
        hint: ks.configured ? undefined : `公司侧未配置知识源（${ks.unconfigured.join(",") || "为空"}），联系管理员填 knowledge.json；可跳过`,
      });
      if (ks.configured && ks.count > 0) {
        issues.push("知识源已配置，可用 coworker_knowledge_search 验证检索");
      }

      // s6 权限目录
      const cat = listCatalogStatus();
      steps.push({
        id: 6,
        name: "权限目录可申请",
        done: cat.configured,
        skippable: !cat.configured,
        manual: false,
        hint: cat.configured ? undefined : `公司侧未配置权限目录（${cat.unconfigured.join(",") || "为空"}），联系管理员填 catalog.json；可跳过`,
      });

      // s7 模型接入（magene provider）：本机 agent 的 LLM 网关鉴权
      const mg = await mageneStatus();
      const mageneOk = mg.apiKeyConfigured && mg.baseUrlSource !== "default";
      steps.push({
        id: 7,
        name: "模型接入（magene provider）",
        done: mageneOk,
        skippable: !mageneOk,
        manual: false,
        hint: mageneOk
          ? undefined
          : "调用 coworker_magene_setup：输入公司模型网关 Base URL + API Key（或配置环境变量 MAGENE_BASE_URL / MAGENE_API_KEY）",
      });

      const firstUndone = steps.find((s) => !s.done && !s.skippable);
      return finish(steps, issues, firstUndone);

      function finish(stepList: typeof steps, issueList: string[], first?: (typeof steps)[number]) {
        const lines = [
          `【入职进度】${stepList.filter((s) => s.done).length}/${stepList.length}`,
          ...stepList.map((s) =>
            `  ${s.done ? "✅" : s.skippable ? "⏭" : s.manual ? "🖐" : "⬜"} ${s.id}. ${s.name}${s.skippable ? "（公司侧未配置，可跳过）" : ""}${s.done || s.skippable ? "" : s.hint ? `\n      → ${s.hint}` : ""}`,
          ),
        ];
        if (first) {
          lines.push("", `【下一步】步骤 ${first.id}：${first.name}`, first.hint ? `  操作：${first.hint}` : "");
        } else {
          lines.push("", "🎉 全部完成！可私聊你的 Bot 开始使用；若手动步骤未真正生效，用 coworker_bot_setup verify 复查。");
        }
        if (issueList.length) lines.push("", issueList.join("\n"));
        return okResult(lines.join("\n"), {
          steps: stepList.map((s) => ({ id: s.id, name: s.name, done: s.done, manual: s.manual })),
          allDone: !first,
          nextStep: first?.id,
        });
      }
    },
  });

  // ---------------------------------------------------------------
  // coworker_bot_setup —— 个人 Bot 开通向导（应用 + 事件订阅 + 能力 + 验证）
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_bot_setup",
    label: "Coworker 个人 Bot 开通",
    description:
      "开通你的个人飞书 Bot：确认个人应用已配置、给出控制台需启用的两个事件与机器人能力、检查事件总线状态。verify=true 时真实监听 45 秒验证事件是否已通（发测试消息）。",
    parameters: Type.Object({
      withQr: Type.Optional(Type.Boolean({ description: "是否生成登录二维码（默认 true）" })),
      verify: Type.Optional(Type.Boolean({ description: "验证模式：监听 45 秒等你在飞书给 Bot 发消息，确认事件已通（需先完成控制台三件事）" })),
    }),
    async execute(_id, params) {
      const lines: string[] = [];
      const detail: Record<string, unknown> = {};

      // 1) 应用配置
      const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
      const data = dataOf(cfg.envelope) ?? {};
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

      // 2) 事件总线状态
      const es = await runLark(["event", "status", "--json"], { timeoutMs: 30_000 });
      const apps: any[] = dataOf(es.envelope)?.apps ?? [];
      const bus = apps.find((a: any) => String(a.app_id) === appId);
      const running = bus?.running === true;
      detail.busRunning = running;

      // verify 模式：真实监听测试消息
      if (params.verify === true) {
        if (running) {
          lines.push(
            "",
            "守护进程已在运行（事件总线在线）。直接私聊你的 Bot 发一条消息验证即可；收到回复即全部打通。",
          );
          return okResult(lines.join("\n"), detail);
        }
        lines.push(
          "",
          `【验证模式】我将在 45 秒内监听 im.message.receive_v1。`,
          `请现在在飞书里给「你的应用名」Bot 发一条消息（例如：你好）。`,
          "（前提：已按控制台三件事启用事件/机器人能力/发布）",
          "",
        );
        const r = await runLark(
          ["event", "consume", "im.message.receive_v1", "--as", "bot", "--max-events", "1", "--timeout", "45s"],
          { timeoutMs: 55_000 },
        );
        const gotEvent = r.ok && r.stdout.trim().length > 0;
        detail.verifyReceived = gotEvent;
        if (gotEvent) {
          lines.push(
            "✅ 已收到你的消息！事件链路已通，Bot 可用。",
            "下一步：启动守护进程（cd agent && RUN_MODE=local node src/index.ts），之后它就会自动回复了。",
          );
        } else {
          lines.push(
            "❌ 45 秒内未收到消息。请按顺序检查：",
            "   1) 控制台「事件与回调」是否已启用 im.message.receive_v1（和 card.action.trigger）",
            "   2) 「应用能力」是否已添加「机器人」",
            "   3) 「版本管理与发布」是否已创建版本（个人自用通常即时生效）",
            `   4) 你发消息的对象是否是应用「${appId}」对应的 Bot`,
            "   5) 若报错：" + describeLarkError(r),
            "修正后再次调用 coworker_bot_setup 且 verify=true 重试。",
          );
        }
        return okResult(lines.join("\n"), detail);
      }

      // 3) 控制台需启用的事项（引导 + 精确步骤）
      const consoleHost = brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
      const consoleUrl = `${consoleHost}/app/${appId}/event`;
      lines.push(
        toLines([
          ``,
          `【控制台三件事】（开发者后台 → 应用 ${appId}）`,
          `1. 事件与回调 → 事件订阅 → 添加事件 → 勾选：`,
          `   im.message.receive_v1、card.action.trigger → 保存`,
          `   链接：${consoleUrl}`,
          `2. 应用能力 → 添加「机器人」（否则飞书里搜不到它）`,
          `3. 版本管理与发布 → 创建版本并发布（个人自用：创建版本即可）`,
        ]),
      );
      detail.consoleUrl = consoleUrl;

      lines.push(
        ``,
        running
          ? "✅ 事件总线运行中（守护进程已连接）"
          : "⚠️ 事件总线未运行：完成控制台三件事后，可先用 coworker_bot_setup（verify=true）发测试消息验证，再启动守护进程。",
        ``,
        toLines([
          `【下一步】`,
          `1. 完成上面控制台三件事。`,
          `2. 验证：调用 coworker_bot_setup 且 verify=true，在飞书给 Bot 发一条消息。`,
          `3. 启动守护进程：cd agent && RUN_MODE=local node src/index.ts`,
          `4. 之后在飞书私聊你的 Bot 即可使用。`,
        ]),
      );

      return okResult(lines.join("\n"), detail);
    },
  });

  // ---------------------------------------------------------------
  // coworker_bot_activate —— 个人 Bot 激活（IT 代建后发放物料，员工粘贴绑定）
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_bot_activate",
    label: "个人 Bot 激活（IT 代建）",
    description:
      "激活 IT 代建的个人 Bot：粘贴 app_id + app_secret（IT 发放的物料）完成绑定（lark-cli config init --app-id --app-secret-stdin）。适用于没有权限自行创建应用的员工。写操作需用户确认。",
    parameters: Type.Object({
      appId: Type.String({ description: "IT 发放的应用 app_id（形如 cli_xxx）" }),
      appSecret: Type.String({ description: "IT 发放的应用 app_secret" }),
      brand: Type.Optional(Type.String({ description: "平台：feishu（默认）/ lark" })),
      confirm: Type.Optional(Type.Boolean({ description: "显式确认写操作（headless/RPC 场景）" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx: ToolCtx) {
      const appId = (params.appId ?? "").trim();
      const appSecret = (params.appSecret ?? "").trim();
      if (!/^cli_[a-zA-Z0-9_-]{6,}$/.test(appId)) {
        return errResult(`app_id 格式不正确（应为 cli_ 开头）：${maskKey(appId)}`, { invalid: true });
      }
      if (!appSecret) {
        return errResult("缺少 app_secret（IT 发放物料中的密钥）。", { needSecret: true });
      }

      // 写前确认：config init 可能覆盖现有配置
      const confirm = await confirmWrite(ctx, {
        title: "确认激活个人 Bot 应用",
        message: `将绑定 IT 代建应用：\n  app_id=${maskKey(appId)}\n  brand=${params.brand ?? "feishu"}\n\n将覆盖当前 lark-cli 应用配置，确认执行？`,
        explicitConfirm: params.confirm,
      });
      if (!confirm.ok) return errResult(`已取消：${confirm.reason ?? "用户未确认"}`, { blocked: true });

      const args = ["config", "init", "--app-id", appId, "--brand", params.brand ?? "feishu", "--app-secret-stdin"];
      if (process.env.OPENCLAW_HOME || process.env.HERMES_HOME) args.push("--force-init");
      const r = await runLark(args, { timeoutMs: 120_000, input: `${appSecret}\n` });

      // 校验绑定结果
      const cfg = await runLark(["config", "show"], { timeoutMs: 30_000 });
      const data = dataOf(cfg.envelope) ?? {};
      const boundAppId: string | undefined = data.appId ?? data.app_id;
      const bound = cfg.ok && boundAppId === appId;

      appendAudit({
        cluster: "onboarding",
        action: "bot_activate",
        resource: appId,
        result: bound ? "ok" : "error",
        detail: { brand: params.brand ?? "feishu" },
      });

      if (!bound) {
        return errResult(
          `绑定未确认：${describeLarkError(r)}\n请检查 app_id / app_secret 是否正确（物料来自 IT 代建）。`,
          { bound: false },
        );
      }
      return okResult(
        [
          `✅ 个人 Bot 应用已绑定：${appId}`,
          `IT 代建的应用已启用机器人能力与事件（im.message.receive_v1 / card.action.trigger）。`,
          `下一步：`,
          `  1. 调用 coworker_bot_setup（verify=true）确认事件链路已通；`,
          `  2. 启动守护进程（coworker_daemon start 或 install --autostart）。`,
        ].join("\n"),
        { bound: true, appId },
      );
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

  // ---------------------------------------------------------------
  // coworker_magene_setup —— 配置本机模型网关（magene provider）鉴权
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_magene_setup",
    label: "Magene 模型网关配置",
    description:
      "配置本机 LLM 模型网关（magene provider）鉴权：写入凭证到 ~/.pi/agent/extensions/magene-provider/.env（0600），拉取模型列表并注册 provider，验证连通性。写操作需用户确认。",
    parameters: Type.Object({
      baseUrl: Type.Optional(Type.String({ description: "网关地址（默认沿用已有配置或占位符；含 < 的占位符需替换为真实地址）" })),
      apiKey: Type.Optional(Type.String({ description: "API Key（留空则沿用已保存的 Key；两者都无则报错）" })),
      confirm: Type.Optional(Type.Boolean({ description: "显式确认写操作（headless/RPC 场景）" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx: ToolCtx) {
      const existing = readMageneEnv();
      const cfg = resolveMageneConfig();
      const baseUrl = (params.baseUrl ?? existing?.baseUrl ?? cfg.baseUrl ?? "").trim();
      const apiKey = (params.apiKey ?? existing?.apiKey ?? cfg.apiKey ?? "").trim();

      if (!apiKey) {
        return errResult(
          "未提供 API Key 且本机没有已保存的 Key。请让用户向公司申请模型网关 API Key 后传入（apiKey 参数）。",
          { needApiKey: true },
        );
      }
      if (!baseUrl || baseUrl.includes("<") || baseUrl === DEFAULT_MAGENE_BASE_URL) {
        return errResult(
          "Base URL 是占位符，需要真实网关地址。请传入 baseUrl 参数，或配置环境变量 MAGENE_BASE_URL。",
          { needBaseUrl: true },
        );
      }

      // 写前确认（企业规则：写操作必须先确认）
      const confirm = await confirmWrite(ctx, {
        title: "确认写入模型网关凭证",
        message: `将写入 ${MAGENE_ENV_PATH}\n  MAGENE_BASE_URL=${baseUrl}\n  MAGENE_API_KEY=${maskKey(apiKey)}\n\n凭证文件权限 0600，确认写入？`,
        explicitConfirm: params.confirm,
      });
      if (!confirm.ok) return errResult(`已取消：${confirm.reason ?? "用户未确认"}`, { blocked: true });

      // 先验证网关连通与 Key 有效，再落盘
      let modelIds: string[];
      try {
        modelIds = await fetchMageneModels(baseUrl, apiKey);
      } catch (e: any) {
        return errResult(`网关验证失败（未写入凭证）：${e?.message ?? String(e)}`, { verified: false });
      }
      if (modelIds.length === 0) {
        return errResult("网关可达但未返回任何模型，请检查网关配置。", { verified: false });
      }

      writeMageneEnv(baseUrl, apiKey);
      registerMageneProvider(baseUrl, apiKey, modelIds);
      const resolved = buildResolvedModels(modelIds);
      const reasoning = resolved.filter((m) => m.reasoning).length;
      appendAudit({
        cluster: "onboarding",
        action: "magene_setup",
        resource: "magene-provider",
        result: "ok",
        detail: { modelCount: modelIds.length, baseUrl },
      });

      return okResult(
        [
          `✅ magene provider 已配置并注册（${modelIds.length} 个模型，推理模型 ${reasoning} 个）`,
          `   Base URL：${baseUrl}`,
          `   已写入：${MAGENE_ENV_PATH}（0600）`,
          `   模型示例：${modelIds.slice(0, 6).join(", ")}${modelIds.length > 6 ? ", …" : ""}`,
          `Bot Agent 守护进程加载同一扩展时也会自动注册该 provider；本会话 /reload 后可用 magene/ 前缀模型。`,
        ].join("\n"),
        { modelCount: modelIds.length, registered: true },
      );
    },
  });

  // ---------------------------------------------------------------
  // coworker_magene_status —— 模型网关诊断
  // ---------------------------------------------------------------
  pi.registerTool({
    name: "coworker_magene_status",
    label: "Magene 模型网关状态",
    description: "诊断本机 magene provider：网关地址与来源、API Key 是否配置、连通性、provider 注册状态。",
    parameters: Type.Object({}),
    async execute() {
      const s = await mageneStatus();
      const lines = [
        `Base URL：${s.baseUrl}（来源：${s.baseUrlSource}${s.baseUrlSource === "default" ? "，为占位符，需配置" : ""}）`,
        `API Key：${s.apiKeyConfigured ? `已配置（来源：${s.apiKeySource}）` : "未配置"}`,
        `凭证文件：${s.envFileExists ? `存在（${MAGENE_ENV_PATH}）` : "不存在"}`,
        `provider 注册：${s.providerRegistered ? "已注册" : "未注册"}`,
      ];
      if (s.apiKeyConfigured && s.baseUrlSource !== "default") {
        lines.push(s.lastError ? `连通性：❌ ${s.lastError}` : "连通性：✅ 网关可达");
      } else if (!s.apiKeyConfigured) {
        lines.push("提示：调用 coworker_magene_setup 配置凭证（API Key）");
      }
      return okResult(lines.join("\n"), {
        baseUrl: s.baseUrl,
        baseUrlSource: s.baseUrlSource,
        apiKeyConfigured: s.apiKeyConfigured,
        providerRegistered: s.providerRegistered,
        lastError: s.lastError ?? null,
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
