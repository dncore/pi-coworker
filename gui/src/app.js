/* 企业 AI 助手 前端逻辑 */
"use strict";

const API = window.GUI_API || "http://127.0.0.1:17331";

let deviceCode = "";

// ---------- 工具 ----------
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 视图切换 ----------
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById("view-" + btn.dataset.view).classList.add("active");
    if (btn.dataset.view === "perm") loadPerm();
    if (btn.dataset.view === "status") loadEnv();
  });
});

// ---------- 状态 / 登录 ----------
async function loadEnv() {
  const el = document.getElementById("env");
  el.innerHTML = "检查中…";
  const e = await api("/env");
  if (!e.larkCli) {
    el.innerHTML = `<div class="bad">❌ lark-cli 未安装：请运行 <code>npm install -g @larksuite/cli</code> 后重试</div>`;
    return;
  }
  const authLine = e.auth?.loggedIn
    ? `<div class="ok">✅ 已登录：${esc(e.auth.name)}（${e.auth.scopes} 个 scope）</div>`
    : `<div class="bad">❌ 未登录：${esc(e.auth?.message || "")}</div>`;
  el.innerHTML =
    `<div>✅ lark-cli：${esc(e.larkCli.version)}</div>` +
    `<div>${e.config.initialized ? "✅" : "❌"} 配置：${e.config.initialized ? "已初始化" : "未初始化"}</div>` +
    authLine;
  document.getElementById("identity").textContent = e.auth?.loggedIn ? `已登录：${e.auth.name}` : "未登录";
  document.getElementById("login-box").classList.toggle("hidden", !!e.auth?.loggedIn);
}

async function startLogin() {
  document.getElementById("login-status").textContent = "发起中…";
  const r = await api("/login", { method: "POST", body: {} });
  if (!r.ok) {
    document.getElementById("login-status").textContent = "发起失败：" + r.message;
    return;
  }
  deviceCode = r.deviceCode;
  document.getElementById("login-url").innerHTML = `<a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a>`;
  document.getElementById("login-qr").src = API + r.qrUrl;
  document.getElementById("login-status").textContent = "请在浏览器完成授权，然后点「我已授权」";
}

async function completeLogin() {
  if (!deviceCode) {
    document.getElementById("login-status").textContent = "请先点击「打开链接」发起授权";
    return;
  }
  document.getElementById("login-status").textContent = "等待授权完成…";
  const r = await api("/login/complete", { method: "POST", body: { deviceCode } });
  if (!r.ok) {
    document.getElementById("login-status").textContent = "登录未完成：" + r.message;
    return;
  }
  document.getElementById("login-status").textContent = "✅ 登录成功：" + (r.identity?.name || "");
  loadEnv();
}

document.getElementById("env-refresh").addEventListener("click", loadEnv);
document.getElementById("login-open").addEventListener("click", startLogin);
document.getElementById("login-done").addEventListener("click", completeLogin);

// ---------- 权限 ----------
async function loadPerm() {
  const scanEl = document.getElementById("perm-scan");
  const listEl = document.getElementById("perm-list");
  scanEl.innerHTML = "盘点中…";
  listEl.innerHTML = "";

  const scan = await api("/perm/scan");
  if (scan.spaces) {
    scanEl.innerHTML =
      `<h3>我的知识空间（${scan.spaces.length}）</h3>` +
      `<table class="table"><tr><th>知识库</th><th>角色</th></tr>` +
      scan.spaces
        .map((s) => `<tr><td>${esc(s.name)}</td><td>${s.role === "admin" ? `<span class="ok">admin</span>` : esc(s.role)}</td></tr>`)
        .join("") +
      `</table>`;
  } else {
    scanEl.innerHTML = `<h3>我的知识空间</h3><div class="bad">盘点失败：${esc(scan.message || "未知")}</div>`;
  }

  const r = await api("/perm/list");
  const perms = r.permissions || [];
  listEl.innerHTML = perms
    .map(
      (p) =>
        `<div class="item">
          <div class="name">${esc(p.name)} <span class="meta">${esc(p.id)}</span></div>
          <div class="meta">${esc(p.type)} · ${esc(p.grant)}${p.description ? " · " + esc(p.description) : ""}</div>
          <div class="row"><button data-id="${esc(p.id)}" data-name="${esc(p.name)}">申请</button></div>
        </div>`,
    )
    .join("");
  document.querySelectorAll("#perm-list [data-id]").forEach((btn) =>
    btn.addEventListener("click", () => applyPerm(btn.dataset.id, btn.dataset.name)),
  );
}

async function applyPerm(id, name) {
  if (!confirm(`确定申请「${name}」？自服务类将直接为你开通，审批类走审批流程。`)) return;
  const r = await api("/perm/apply", { method: "POST", body: { id, confirm: true } });
  if (r.needConfirm) {
    if (confirm(r.message)) {
      const r2 = await api("/perm/apply", { method: "POST", body: { id, confirm: true } });
      toast(r2.message || (r2.ok ? "已开通" : "失败"));
    }
    return;
  }
  toast(r.message || (r.ok ? "✅ 已开通" : "失败"));
}

document.getElementById("perm-refresh").addEventListener("click", loadPerm);

// ---------- 对话 ----------
const messages = document.getElementById("messages");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

async function ask() {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addMsg("user", text);
  const typing = addMsg("bot typing", "思考中…");
  try {
    const r = await api("/ask", { method: "POST", body: { text } });
    typing.remove();
    addMsg(r.ok ? "bot" : "err", r.answer || r.message || "无返回");
  } catch (e) {
    typing.remove();
    addMsg("err", "请求失败：" + e.message);
  }
}

sendBtn.addEventListener("click", ask);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    ask();
  }
});

// 启动加载
loadEnv();

// ============ 安装向导 ============
const wizard = document.getElementById("wizard-body");
const wizardSteps = document.getElementById("wizard-steps");
let wz = 0;
const WIZ = [
  { id: "env", title: "环境检查" },
  { id: "login", title: "飞书登录" },
  { id: "bot", title: "开通个人 Bot" },
  { id: "daemon", title: "启动守护进程" },
  { id: "done", title: "完成" },
];

function renderWizardBar() {
  wizardSteps.innerHTML = WIZ.map((s, i) => `<div class="wz-step ${i < wz ? "done" : i === wz ? "active" : ""}">${s.title}</div>`).join("");
}

function wzActions(html) {
  const bar = document.createElement("div");
  bar.className = "wizard-actions";
  bar.innerHTML = html;
  return bar;
}

async function runWizardStep() {
  renderWizardBar();
  const step = WIZ[wz];
  if (step.id === "env") await wzEnv();
  else if (step.id === "login") await wzLogin();
  else if (step.id === "bot") await wzBot();
  else if (step.id === "daemon") await wzDaemon();
  else await wzDone();
}

async function wzEnv() {
  wizard.innerHTML = "检查中…";
  const e = await api("/env");
  const okCli = e.larkCli?.installed;
  const okCfg = e.config?.initialized;
  const okAuth = !!e.auth?.loggedIn;
  wizard.innerHTML =
    `<div>${okCli ? "✅" : "❌"} lark-cli：${okCli ? e.larkCli.version : "未安装"}</div>` +
    `<div>${okCfg ? "✅" : "❌"} 配置：${okCfg ? "已初始化" : "未初始化"}</div>` +
    `<div>${okAuth ? "✅" : "❌"} 登录：${okAuth ? e.auth.name : "未登录"}</div>`;
  wizard.appendChild(
    wzActions(
      `<button ${okCli && okCfg ? "" : "disabled"} onclick="wzGo(1)">下一步</button>` +
        (okCli && okCfg ? "" : `<span class="hint">请先在终端安装/初始化（npm install -g @larksuite/cli；lark-cli config init --new）</span>`),
    ),
  );
}

async function wzLogin() {
  wizard.innerHTML =
    `<h3>飞书登录</h3><p class="hint">点击「发起登录」→ 浏览器打开链接或扫码 → 完成后点「我已授权」</p>` +
    `<div id="wz-login-url" class="login-url"></div><img id="wz-login-qr" class="qr hidden" alt="" />` +
    `<div class="row"><button onclick="wzLoginStart()">发起登录</button><button class="primary" onclick="wzLoginDone()">我已授权</button></div>` +
    `<div id="wz-login-status" class="hint"></div>`;
  const e = await api("/env");
  if (e.auth?.loggedIn) {
    document.getElementById("wz-login-status").textContent = `✅ 已登录：${e.auth.name}`;
  }
}

async function wzLoginStart() {
  const st = document.getElementById("wz-login-status");
  const r = await api("/login", { method: "POST", body: {} });
  if (!r.ok) return (st.textContent = "失败：" + r.message);
  window._wzCode = r.deviceCode;
  document.getElementById("wz-login-url").innerHTML = `<a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a>`;
  const qr = document.getElementById("wz-login-qr");
  qr.src = API + r.qrUrl;
  qr.classList.remove("hidden");
  st.textContent = "请在浏览器完成授权，然后点「我已授权」";
}

async function wzLoginDone() {
  if (!window._wzCode) return alert("请先发起登录");
  const st = document.getElementById("wz-login-status");
  st.textContent = "等待授权…";
  const r = await api("/login/complete", { method: "POST", body: { deviceCode: window._wzCode } });
  st.textContent = r.ok ? `✅ 登录成功：${r.identity?.name}` : "登录未完成：" + r.message;
  if (r.ok) wizard.appendChild(wzActions(`<button class="primary" onclick="wzGo(2)">下一步</button>`));
}

async function wzBot() {
  wizard.innerHTML = "检查中…";
  const b = await api("/bot/setup-info");
  if (!b.appConfigured) {
    wizard.innerHTML = `<h3>开通个人 Bot</h3><div class="bad">❌ 尚未配置个人应用，请先在终端运行：<code>lark-cli config init --new</code></div>`;
    return;
  }
  wizard.innerHTML =
    `<h3>开通个人 Bot</h3>` +
    `<div>个人应用：<code>${esc(b.appId)}</code>（${b.busRunning ? "事件总线✅在线" : "事件总线❌离线"}）</div>` +
    `<div class="console-list">` +
    `  1. 控制台「事件与回调」启用：<code>im.message.receive_v1</code>、<code>card.action.trigger</code><br/>` +
    `  2. 「应用能力」添加「机器人」<br/>` +
    `  3. 「版本管理」创建并发布版本<br/>` +
    `  🔗 <a href="${esc(b.consoleUrl)}" target="_blank">打开开发者后台</a>` +
    `</div>`;
  wizard.appendChild(
    wzActions(`<button onclick="wzGo(0)">上一步</button><button class="primary" onclick="wzGo(3)">已按指引完成，下一步</button>`),
  );
}

async function wzDaemon() {
  wizard.innerHTML = "检查中…";
  const st = await api("/daemon/status");
  wizard.innerHTML =
    `<h3>启动守护进程</h3>` +
    `<div>守护进程：${st.running ? "✅ 运行中" : "❌ 未运行"}（事件总线：${st.busOnline ? "✅ 在线" : "❌ 离线"}）</div>` +
    `<div class="hint">守护进程常驻后台接收飞书消息；可配置开机自启（终端执行 coworker-daemon install --autostart）。</div>` +
    `<div id="wz-daemon-out" class="console-list"></div>`;
  wizard.appendChild(
    wzActions(
      `<button onclick="wzGo(2)">上一步</button>` +
        `<span>` +
        `<button ${st.running ? "" : "class=\"primary\""} onclick="wzDaemonControl('start')">${st.running ? "重启" : "启动"}</button>` +
        `<button ${st.running ? "class=\"primary\"" : "disabled"} onclick="wzDaemonControl('stop')">停止</button>` +
        `<button class="primary" onclick="wzGo(4)">完成</button>` +
        `</span>`,
    ),
  );
}

async function wzDaemonControl(action) {
  const out = document.getElementById("wz-daemon-out");
  const r = await api("/daemon/" + action, { method: "POST", body: {} });
  out.textContent = r.output || r.message || (r.ok ? "完成" : "失败");
  await runWizardStep();
}

async function wzDone() {
  wizard.innerHTML =
    `<h3>🎉 安装完成</h3>` +
    `<p class="hint">现在打开飞书，私聊你的 Bot（应用名），开始使用个人 AI 助手：问答、申请权限、入职引导。</p>` +
    `<div class="console-list">常用入口：<code>/coworker:setup</code>（CLI 引导）· <code>coworker-daemon status</code>（守护状态）</div>`;
  wizard.appendChild(wzActions(`<button onclick="wzGo(3)">上一步</button>`));
}

function wzGo(n) {
  wz = Math.max(0, Math.min(WIZ.length - 1, n));
  runWizardStep();
}

// 导航到向导时进入
const _wzBtn = document.querySelector(".nav-btn[data-view=wizard]");
if (_wzBtn) _wzBtn.addEventListener("click", () => runWizardStep());

// ============ 托盘事件（Tauri 菜单） ============
const Tauri = window.__TAURI__;
if (Tauri?.event) {
  Tauri.event.listen("daemon-start", () => { api("/daemon/start", { method: "POST", body: {} }).then(() => toast("守护进程已启动")); });
  Tauri.event.listen("daemon-stop", () => { api("/daemon/stop", { method: "POST", body: {} }).then(() => toast("守护进程已停止")); });
}
