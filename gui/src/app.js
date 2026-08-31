/* 企业 AI 助手 前端逻辑（Light 设计系统，无 emoji） */
"use strict";

const API = window.GUI_API || "http://127.0.0.1:17331";

let deviceCode = "";
let currentSessionId = "me";

// ---------- 工具 ----------
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  return res.json();
}

function toast(msg, kind = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (kind ? " toast--" + kind : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 清洗展示文本：去掉 emoji 与符号类字符（界面禁止出现 emoji） */
function clean(s) {
  return String(s ?? "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2B05}-\u{2B07}\u{FE0F}\u{200D}\u{20E3}\u{25A0}-\u{25FF}\u{2700}-\u{27BF}]/gu, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 安全 HTML 清洗：移除危险标签与事件属性（markdown 解析后调用） */
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, 1 /* SHOW_ELEMENT */);
  const els = [];
  while (walker.nextNode()) els.push(walker.currentNode);
  const badTags = ["script", "style", "iframe", "object", "embed", "link", "meta", "base"];
  for (const el of els) {
    const tag = el.tagName.toLowerCase();
    if (badTags.includes(tag)) { el.remove(); continue; }
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      const v = attr.value;
      if (n.startsWith("on")) el.removeAttribute(attr.name);
      else if ((n === "href" || n === "src") && /^(javascript|vbscript|data):/i.test(v)) el.removeAttribute(attr.name);
    }
  }
  return doc.body.innerHTML;
}

/** 富文本渲染：markdown 解析（gfm）+ 安全清洗；链接加 target=_blank 走系统浏览器 */
function renderRich(text) {
  const html = typeof window.marked?.parse === "function"
    ? window.marked.parse(text || "", { gfm: true, breaks: true })
    : esc(text || "");
  const safe = sanitizeHtml(html);
  // 给所有链接加 target=_blank，全局点击拦截会走 /open-url（系统浏览器）
  const doc = new DOMParser().parseFromString(safe, "text/html");
  doc.querySelectorAll("a").forEach((a) => { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer"); });
  return doc.body.innerHTML;
}

/** 状态点 HTML：ok / err / warn / muted / accent */
function dot(kind, text) {
  return `<span class="sand-dot sand-dot--${kind}"></span>${esc(text)}`;
}

/** 按钮加载态：busy=true 显示 spinner 并禁用；false 还原 */
function busy(btn, on = true) {
  if (!btn) return;
  if (on) {
    if (btn.dataset._label === undefined) btn.dataset._label = btn.textContent;
    btn.classList.add("is-loading");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span><span>${btn.dataset._label}</span>`;
  } else {
    btn.classList.remove("is-loading");
    btn.disabled = false;
    btn.textContent = btn.dataset._label ?? btn.textContent;
  }
}

/** 确认弹窗（替代原生 confirm）。返回 Promise<boolean> */
function confirmDialog({ title, message, confirmText = "确认", danger = false }) {
  const modal = document.getElementById("modal");
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").textContent = message;
  const ok = document.getElementById("modal-ok");
  ok.textContent = confirmText;
  ok.className = "sand-kit-button " + (danger ? "sand-kit-button--danger" : "sand-kit-button--accent");
  modal.classList.remove("hidden");
  ok.focus();
  return new Promise((resolve) => {
    const done = (v) => {
      modal.classList.add("hidden");
      ok.onclick = cancel.onclick = overlay.onclick = null;
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const cancel = document.getElementById("modal-cancel");
    const overlay = modal.querySelector("[data-close]");
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    overlay.onclick = () => done(false);
    const onKey = (e) => {
      if (e.key === "Escape") done(false);
      if (e.key === "Enter" && !e.shiftKey) done(true);
    };
    document.addEventListener("keydown", onKey);
  });
}

// ---------- 视图切换 ----------
document.querySelectorAll(".sand-nav__item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".sand-nav__item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById("view-" + btn.dataset.view).classList.add("active");
    if (btn.dataset.view === "perm") loadPerm();
    if (btn.dataset.view === "status") loadEnv();
    if (btn.dataset.view === "today") loadToday();
  });
});

// ---------- 今日概览 ----------
async function loadToday() {
  const body = document.getElementById("today-body");
  const refreshBtn = document.getElementById("today-refresh");
  busy(refreshBtn, true);
  try {
    const d = await api("/today");
    const date = new Date();
    const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
    document.getElementById("today-date").innerHTML =
      `${date.getMonth() + 1} 月 ${date.getDate()} 日 <small>${wd}</small>`;

    const schEl = document.getElementById("today-schedule");
    document.getElementById("today-schedule-count").textContent = d.schedule.length ? `(${d.schedule.length})` : "";
    schEl.innerHTML = d.schedule.length
      ? d.schedule
          .map((e) =>
            `<div class="today-item today-item--schedule">` +
              `<div class="ti-line"><span class="ti-title">${esc(clean(e.summary))}</span></div>` +
              `<div class="ti-meta">${esc(e.start || "全天")}${e.end ? " ~ " + esc(e.end) : ""}${e.location ? " · " + esc(clean(e.location)) : ""}</div>` +
              `</div>`)
          .join("")
      : `<div class="today-empty">今日暂无日程</div>`;

    const todoEl = document.getElementById("today-todos");
    document.getElementById("today-todo-count").textContent = d.todos.length ? `(${d.todos.length})` : "";
    todoEl.innerHTML = d.todos.length
      ? d.todos
          .map(
            (t) =>
              `<div class="today-item today-item--todo">` +
              `<div class="ti-line"><span class="ti-title">${esc(clean(t.summary))}</span>` +
              `<button class="sand-kit-button sand-kit-button--sm todo-done" data-id="${esc(t.id)}">完成</button></div>` +
              (t.due ? `<div class="ti-meta">截止 ${esc(t.due)}</div>` : "") +
              `</div>`,
          )
          .join("")
      : `<div class="today-empty">没有未完成的待办</div>`;
    todoEl.querySelectorAll(".todo-done").forEach((b) =>
      b.addEventListener("click", () => completeTodayTask(b)),
    );

  } catch (e) {
    body.innerHTML = `<div class="hint">今日概览加载失败：${esc(e.message)}</div>`;
  } finally {
    busy(refreshBtn, false);
  }
}

async function completeTodayTask(btn) {
  const ok = await confirmDialog({
    title: "完成任务",
    message: `将待办「${btn.closest(".today-item").querySelector(".ti-title").textContent}」标记为完成，确认？`,
    confirmText: "确认完成",
  });
  if (!ok) return;
  busy(btn, true);
  const r = await api("/today/task-complete", { method: "POST", body: { taskId: btn.dataset.id } });
  busy(btn, false);
  if (r.ok) {
    toast(clean(r.message) || "已完成", "ok");
    loadToday();
  } else {
    toast(clean(r.message) || "操作失败", "err");
  }
}

document.getElementById("today-refresh").addEventListener("click", loadToday);

// ---------- 状态 / 登录 ----------
async function loadEnv() {
  const el = document.getElementById("env");
  const refreshBtn = document.getElementById("env-refresh");
  busy(refreshBtn, true);
  el.innerHTML = '<span class="meta">检查中…</span>';
  const e = await api("/env");
  busy(refreshBtn, false);
  if (!e.larkCli) {
    el.innerHTML = `<div>${dot("err", "lark-cli 未安装")}：请运行 <code>npm install -g @larksuite/cli</code> 后重试</div>`;
    return;
  }
  const authLine = e.auth?.loggedIn
    ? `${dot("ok", "已登录")}：${esc(clean(e.auth.name))}（${e.auth.scopes} 个 scope）`
    : `${dot("err", "未登录")}：${esc(clean(e.auth?.message || ""))}`;
  el.innerHTML =
    `<dl class="env-list">` +
    `<dt>${dot("ok", "lark-cli")}</dt><dd>${esc(e.larkCli.version)}</dd>` +
    `<dt>${dot(e.config.initialized ? "ok" : "err", "配置")}</dt><dd>${e.config.initialized ? "已初始化" : "未初始化"}</dd>` +
    `<dt>${dot(e.auth?.loggedIn ? "ok" : "err", "登录")}</dt><dd>${authLine}</dd>` +
    `</dl>`;

  const name = e.auth?.loggedIn ? clean(e.auth.name) : "";
  document.getElementById("identity").textContent = e.auth?.loggedIn ? name : "未登录";
  document.getElementById("identity-sub").textContent = e.auth?.loggedIn
    ? `${e.auth.scopes} 个授权 scope`
    : "飞书授权后可用";
  loadMe();
  document.getElementById("account-avatar").textContent = e.auth?.loggedIn ? (name.slice(0, 1) || "?") : "?";
  document.getElementById("login-box").classList.toggle("hidden", !!e.auth?.loggedIn);
  if (!e.auth?.loggedIn) resetLoginBox();
  refreshAuthGate(e.auth?.loggedIn === true);
}

// ---------- 登录守卫（未登录全屏，状态驱动自动推进） ----------
let _guardDeviceCode = "";
let _guardPortalTimer = null;
let _guardLoginAbort = null;

function refreshAuthGate(authed) {
  const guard = document.getElementById("login-guard");
  guard.classList.toggle("hidden", !!authed);
  if (authed) {
    afterLoginSetup();
  } else {
    resetGuard();
  }
}

function resetGuard() {
  _guardDeviceCode = "";
  if (_guardLoginAbort) { _guardLoginAbort.abort(); _guardLoginAbort = null; }
  if (_guardPortalTimer) { clearInterval(_guardPortalTimer); _guardPortalTimer = null; }
  document.getElementById("guard-step").classList.remove("hidden");
  setGuardLoginStep("idle");
  document.getElementById("guard-config").classList.add("hidden");
  document.getElementById("guard-config-line").textContent = "";
  document.getElementById("guard-portal-status").textContent = "";
  document.getElementById("guard-status").textContent = "";
  document.getElementById("guard-status").className = "hint";
}

function setGuardLoginStep(step) {
  const wrap = document.getElementById("guard-step");
  const btn = document.getElementById("guard-login");
  const poll = document.getElementById("guard-polling");
  if (step === "idle") {
    wrap.dataset.step = "login";
    btn.classList.remove("hidden");
    btn.textContent = "飞书扫码登录";
    btn.disabled = false;
    poll.classList.add("hidden");
  } else if (step === "polling") {
    btn.classList.add("hidden");
    poll.classList.remove("hidden");
  } else if (step === "retry") {
    btn.classList.remove("hidden");
    btn.textContent = "重新扫码登录";
    btn.disabled = false;
    poll.classList.add("hidden");
  }
}

// 用户点主按钮 → 发起登录，拿到二维码后立即自动轮询，无需「我已授权」
async function guardStartLogin() {
  const st = document.getElementById("guard-status");
  const btn = document.getElementById("guard-login");
  busy(btn, true);
  st.textContent = "";
  const r = await api("/login", { method: "POST", body: {} });
  busy(btn, false);
  if (!r.ok) {
    setGuardLoginStep("idle");
    st.textContent = "发起失败：" + clean(r.message);
    return;
  }
  _guardDeviceCode = r.deviceCode;
  // 展示二维码 + 链接，进入轮询态
  const qr = document.getElementById("guard-login-qr");
  qr.src = API + r.qrUrl;
  const link = document.getElementById("guard-login-link");
  link.href = r.url;
  setGuardLoginStep("polling");
  // 自动轮询：后端 --device-code 阻塞等待用户授权（最长 4 分钟），授权后自动返回成功
  guardPollLogin();
}

async function guardPollLogin() {
  const st = document.getElementById("guard-status");
  st.textContent = "";
  _guardLoginAbort = new AbortController();
  try {
    const r = await api("/login/complete", { method: "POST", body: { deviceCode: _guardDeviceCode }, signal: _guardLoginAbort.signal });
    if (_guardLoginAbort?.signal.aborted) return;
    if (!r.ok) {
      setGuardLoginStep("retry");
      st.textContent = "未完成：" + clean(r.message);
      return;
    }
    toast("飞书登录成功", "ok");
    loadEnv(); // → refreshAuthGate(true) → afterLoginSetup
  } catch (e) {
    if (e?.name === "AbortError") return;
    setGuardLoginStep("retry");
    st.textContent = "登录超时或失败，请重试";
  }
}

// 登录成功后：检查模型网关是否已配置；未配置则切到 config 步骤
async function afterLoginSetup() {
  const cfgWrap = document.getElementById("guard-config");
  const line = document.getElementById("guard-config-line");
  const st = document.getElementById("guard-status");
  try {
    const s = await api("/magene/status");
    const configured = s.apiKeyConfigured && s.baseUrlSource !== "default";
    if (configured) {
      line.textContent = "模型网关已就绪 ✅";
      return; // 守卫即将隐藏
    }
    line.textContent = "最后一步：配置模型网关";
    cfgWrap.classList.remove("hidden");
    document.getElementById("guard-step").classList.add("hidden");
  } catch {
    line.textContent = "可在「安装向导 → 模型网关」手动配置";
    cfgWrap.classList.remove("hidden");
    document.getElementById("guard-step").classList.add("hidden");
  }
}

// 配置态：打开公司门户获取 API Key（自动轮询剪贴板）
async function guardPortalGet() {
  const st = document.getElementById("guard-portal-status");
  const btn = document.getElementById("guard-portal-get");
  busy(btn, true);
  const openR = await api("/portal/open", { method: "POST", body: {} });
  await api("/portal/watch-start", { method: "POST", body: {} });
  busy(btn, false);
  if (!openR.ok) { st.textContent = "打开门户失败：" + clean(openR.message || ""); return; }
  btn.classList.add("hidden");
  st.textContent = "已在浏览器打开公司门户：① 飞书扫码登录 ② 控制台点「API key」复制。正在自动捕获…";
  if (_guardPortalTimer) clearInterval(_guardPortalTimer);
  _guardPortalTimer = setInterval(async () => {
    const s = await api("/portal/watch-status");
    if (s.found) {
      clearInterval(_guardPortalTimer); _guardPortalTimer = null;
      st.textContent = "已捕获 Key，正在验证网关…";
      const r = await api("/magene/setup", { method: "POST", body: { baseUrl: s.mageneBaseUrl || "", apiKey: s.key } });
      st.textContent = clean(r.message) || (r.ok ? "已配置" : "配置失败");
      if (r.ok) { toast("模型网关已自动配置", "ok"); loadEnv(); }
    } else if (!s.active) {
      clearInterval(_guardPortalTimer); _guardPortalTimer = null;
      st.textContent = "监听超时。可稍后在「安装向导 → 模型网关」手动配置。";
      document.getElementById("guard-portal-get").classList.remove("hidden");
    }
  }, 2000);
}

document.getElementById("guard-login").addEventListener("click", guardStartLogin);
document.getElementById("guard-portal-get").addEventListener("click", guardPortalGet);

function resetLoginBox() {
  deviceCode = "";
  document.getElementById("login-url").innerHTML = "";
  document.getElementById("login-qr").classList.add("hidden");
  document.getElementById("login-status").textContent = "";
  document.getElementById("login-done").disabled = true;
}

async function startLogin() {
  const openBtn = document.getElementById("login-open");
  const st = document.getElementById("login-status");
  busy(openBtn, true);
  st.textContent = "发起中…";
  const r = await api("/login", { method: "POST", body: {} });
  busy(openBtn, false);
  if (!r.ok) {
    st.textContent = "发起失败：" + clean(r.message);
    return;
  }
  deviceCode = r.deviceCode;
  document.getElementById("login-url").innerHTML = `<a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a>`;
  const qr = document.getElementById("login-qr");
  qr.src = API + r.qrUrl;
  qr.classList.remove("hidden");
  document.getElementById("login-done").disabled = false;
  st.textContent = "请在浏览器完成授权，然后点「我已授权」";
}

async function completeLogin() {
  if (!deviceCode) {
    document.getElementById("login-status").textContent = "请先点「打开链接」发起授权";
    return;
  }
  const doneBtn = document.getElementById("login-done");
  const st = document.getElementById("login-status");
  busy(doneBtn, true);
  st.textContent = "等待授权完成…";
  const r = await api("/login/complete", { method: "POST", body: { deviceCode } });
  busy(doneBtn, false);
  if (!r.ok) {
    st.textContent = "登录未完成：" + clean(r.message);
    return;
  }
  st.textContent = "登录成功：" + clean(r.identity?.name || "");
  toast("登录成功", "ok");
  loadEnv();
}

document.getElementById("env-refresh").addEventListener("click", loadEnv);
document.getElementById("login-open").addEventListener("click", startLogin);
document.getElementById("login-done").addEventListener("click", completeLogin);

// ---------- 权限 ----------
const appliedPerms = new Set();

async function loadPerm() {
  const cfgEl = document.getElementById("perm-config");
  const listEl = document.getElementById("perm-list");
  const refreshBtn = document.getElementById("perm-refresh");
  busy(refreshBtn, true);
  cfgEl.innerHTML = '<span class="meta">检查配置中…</span>';
  listEl.innerHTML = "";
  await loadPermConfig(cfgEl);
  await renderPermList(listEl);
  busy(refreshBtn, false);
}

/** 配置里程碑：lark-cli / 登录 / Bot / 模型网关 / 守护进程，全部就绪显示完成卡 */
async function loadPermConfig(el) {
  let env, bot, magene, daemon;
  try {
    [env, bot, magene, daemon] = await Promise.all([
      api("/env"), api("/bot/setup-info"), api("/magene/status"), api("/daemon/status"),
    ]);
  } catch (e) {
    el.innerHTML = `<div class="hint">配置检查失败：${esc(e.message)}</div>`;
    return;
  }
  const items = [
    { id: "cli", name: "lark-cli", ok: !!env?.larkCli?.installed, detail: env?.larkCli?.version || "未安装" },
    { id: "login", name: "飞书登录", ok: !!env?.auth?.loggedIn, detail: env?.auth?.loggedIn ? clean(env.auth.name) : "未登录" },
    { id: "bot", name: "个人 Bot", ok: !!bot?.appConfigured, detail: bot?.appConfigured ? String(bot.appId || "").slice(0, 18) : "未配置" },
    { id: "magene", name: "模型网关", ok: !!(magene?.apiKeyConfigured && magene?.baseUrlSource !== "default"), detail: magene?.apiKeyConfigured ? "已配置" : "未配置" },
    { id: "daemon", name: "守护进程", ok: !!daemon?.running, detail: daemon?.running ? "运行中" : "未运行" },
  ];
  const allOk = items.every((i) => i.ok);
  if (allOk) {
    // 全部就绪：显示完成卡 + 守护进程项（可停止），避免完成后无法操作守护进程
    el.innerHTML =
      `<h3 class="cfg-title">已完成配置</h3>` + readyCard("全部就绪 🎉", "环境 · 登录 · Bot · 模型网关 · 守护进程均已就绪，可直接使用。") +
      `<div class="cfg-list" style="margin-top: var(--sand-sp-2)">` +
      `<div class="cfg-item cfg-item--ok"><div class="cfg-item__dot">✓</div><div class="cfg-item__body"><div class="cfg-item__name">守护进程</div><div class="cfg-item__detail">运行中</div></div><button class="sand-kit-button sand-kit-button--sm cfg-item__act" data-daemon="stop">停止</button></div>` +
      `</div>`;
    el.querySelector("[data-daemon]").addEventListener("click", () => toggleDaemon("stop"));
    return;
  }
  el.innerHTML =
    `<h3 class="cfg-title">配置状态</h3>` +
    `<div class="cfg-list">` +
    items.map((i) =>
      `<div class="cfg-item ${i.ok ? "cfg-item--ok" : "cfg-item--todo"}">` +
        `<div class="cfg-item__dot">${i.ok ? "✓" : "!"}</div>` +
        `<div class="cfg-item__body"><div class="cfg-item__name">${esc(i.name)}</div><div class="cfg-item__detail">${esc(i.detail)}</div></div>` +
        (i.id === "daemon" ? `<button class="sand-kit-button sand-kit-button--sm cfg-item__act" data-daemon="${i.ok ? "stop" : "start"}">${i.ok ? "停止" : "启动"}</button>` : "") +
      `</div>`).join("") +
    `</div>`;
  el.querySelectorAll("[data-daemon]").forEach((btn) =>
    btn.addEventListener("click", () => toggleDaemon(btn.dataset.daemon)),
  );
}

/** 守护进程：启动 / 停止（停止前弹窗确认） */
async function toggleDaemon(action) {
  if (action === "stop") {
    const ok = await confirmDialog({ title: "停止守护进程", message: "停止后 App 将不再接收飞书消息与 Bot 事件，确认停止？", confirmText: "停止", danger: true });
    if (!ok) return;
  }
  const r = await api("/daemon/" + action, { method: "POST", body: {} });
  toast(clean(r.message || (r.ok ? "完成" : "失败")), r.ok ? "ok" : "err");
  await loadPermConfig(document.getElementById("perm-config"));
}

/** bot 的 API 权限 scope 清单（lark-cli auth scopes 规范） */
async function renderPermList(listEl) {
  const r = await api("/perm/scopes");
  if (!r.ok) {
    listEl.innerHTML = `<div class="hint" style="padding: var(--sand-sp-3)">权限清单获取失败：${esc(clean(r.message || "未知"))}</div>`;
    return;
  }
  const groups = r.byService || [];
  const other = r.other && r.other.length ? [{ key: "other", label: "其他", count: r.other.length, scopes: r.other }] : [];
  const all = [...groups, ...other];
  if (!all.length) {
    listEl.innerHTML = `<div class="hint" style="padding: var(--sand-sp-3)">未查询到 bot 权限 scope。</div>`;
    return;
  }
  listEl.innerHTML =
    `<h3 class="cfg-title">可用 API 权限（${r.total || 0} 个 scope · ${esc(clean(r.identity))}）</h3>` +
    `<div class="hint" style="margin-bottom: var(--sand-sp-2)">这些是当前 bot 已启用的飞书开放平台 API 权限（scope），决定了助手能访问哪些能力。</div>` +
    `<details class="scope-group" open>` +
    all.map((g) =>
      `<summary><span class="scope-group__label">${esc(g.label)}</span><span class="scope-group__count">${g.count}</span></summary>` +
        `<div class="scope-group__items">` +
        g.scopes.map((s) => `<code class="scope-chip">${esc(s)}</code>`).join("") +
        `</div>`
    ).join("") +
    `</details>`;
}


async function applyPerm(id, name, btn) {
  busy(btn, true);
  // 第一步：不带 confirm 询问（后端会返回 needConfirm 与说明）
  const r = await api("/perm/apply", { method: "POST", body: { id } });
  if (r.needConfirm) {
    const ok = await confirmDialog({
      title: "申请权限",
      message: `${clean(r.message)}（自服务类将直接为你开通）`,
      confirmText: "确认申请",
    });
    if (!ok) {
      busy(btn, false);
      return;
    }
    const r2 = await api("/perm/apply", { method: "POST", body: { id, confirm: true } });
    busy(btn, false);
    finishApply(btn, r2);
    return;
  }
  busy(btn, false);
  finishApply(btn, r);
}

function finishApply(btn, r) {
  if (r.ok) {
    appliedPerms.add(btn.dataset.id);
    btn.disabled = true;
    btn.classList.add("sand-kit-button--ghost");
    btn.textContent = "已开通";
    toast(clean(r.message) || "已开通", "ok");
  } else if (r.needOther) {
    toast(clean(r.message) || "需走其他流程", "warn");
  } else {
    toast(clean(r.message) || "申请失败", "err");
  }
}

document.getElementById("perm-refresh").addEventListener("click", loadPerm);

// ---------- 对话 ----------
const messages = document.getElementById("messages");
const emptyEl = document.getElementById("messages-empty");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");

function syncEmpty() {
  emptyEl.classList.toggle("hidden", messages.querySelectorAll(".msg-row").length > 0);
}

/** 添加消息；role: user | bot | err。bot 走富文本渲染。 */
function addMsg(role, text, { rich = true, tool = false } = {}) {
  const row = document.createElement("div");
  row.className = "msg-row " + role + (tool ? " tool" : "");

  const content = document.createElement("div");
  content.style.minWidth = "0";
  const textClean = clean(text);
  if (role === "bot") {
    if (!tool) {
      const head = document.createElement("div");
      head.className = "msg-head";
      const label = document.createElement("span");
      label.textContent = "企业 AI 助手";
      const copy = document.createElement("button");
      copy.className = "msg-copy";
      copy.textContent = "复制";
      copy.addEventListener("click", () => {
        navigator.clipboard?.writeText(textClean).then(() => toast("已复制", "ok")).catch(() => toast("复制失败", "err"));
      });
      head.append(label, copy);
      content.appendChild(head);
    }

    const avatar = document.createElement("span");
    avatar.className = "sand-avatar sand-avatar--brand bot-avatar";
    avatar.innerHTML = `<img src="${BOT_AVATAR}" alt="AI" />`;
    row.appendChild(avatar);

    const bubble = document.createElement("div");
    bubble.className = rich ? "msg rich" : "msg";
    bubble.innerHTML = rich ? renderRich(textClean) : esc(textClean);
    content.appendChild(bubble);
    row.appendChild(content);
  } else {
    const bubble = document.createElement("div");
    bubble.className = "msg";
    bubble.textContent = textClean;
    content.appendChild(bubble);
    row.appendChild(content);
    if (window.__userAvatar) {
      const avatar = document.createElement("span");
      avatar.className = "sand-avatar";
      avatar.innerHTML = `<img src="${esc(window.__userAvatar)}" alt="我" />`;
      row.appendChild(avatar);
    }
  }
  messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
  syncEmpty();
  return row;
}

/** 打字指示气泡 */
function addTyping() {
  const row = document.createElement("div");
  row.className = "msg-row bot typing-row";
  const avatar = document.createElement("span");
  avatar.className = "sand-avatar sand-avatar--brand bot-avatar";
  avatar.innerHTML = `<img src="${BOT_AVATAR}" alt="AI" />`;
  row.appendChild(avatar);
  const bubble = document.createElement("div");
  bubble.className = "msg";
  bubble.innerHTML = `<span class="typing-dots"><i></i><i></i><i></i></span>`;
  row.appendChild(bubble);
  messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
  return row;
}

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

function canSend() {
  return input.value.trim().length > 0;
}

function syncSend() {
  sendBtn.disabled = !canSend();
}

async function ask() {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  autosize();
  syncSend();
  addMsg("user", text, { rich: false });
  const typing = addTyping();
  // 超时门禁：150s 未回应则中断，避免长上下文/大检索导致无限等待
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), 150_000);
  try {
    const r = await api("/ask", { method: "POST", body: { text }, signal: ctrl.signal });
    if (r.sessionId) currentSessionId = r.sessionId;
    typing.remove();
    syncEmpty();
    addMsg(r.ok ? "bot" : "err", r.answer || r.message || "无返回");
  } catch (e) {
    typing.remove();
    syncEmpty();
    const aborted = e?.name === "AbortError" || e?.message === "timeout" || e?.message?.includes?.("timeout");
    addMsg("err", aborted
      ? "处理超时：可能上下文过长或检索范围过大，建议新开对话后重试"
      : "请求失败：" + (e?.message || "网络中断，请重试"));
  } finally {
    clearTimeout(timer);
  }
}

sendBtn.addEventListener("click", ask);
input.addEventListener("input", () => {
  syncSend();
  autosize();
});
input.addEventListener("keydown", (e) => {
  // 中文输入法组合态的回车是确认候选词，不是提交
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key !== "Enter") return;
  // Enter 发送；Shift+Enter 换行；Ctrl/Cmd+Enter 强制发送
  const shouldSend = !e.shiftKey || e.metaKey || e.ctrlKey;
  if (!shouldSend) return;
  e.preventDefault();
  ask();
});

// 快捷提问
document.querySelectorAll(".empty__chips .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    input.value = chip.dataset.q || "";
    autosize();
    syncSend();
    input.focus();
  });
});

// ============ 会话管理 / 模型切换 / 账户菜单 ============

function clearMessages() {
  messages.querySelectorAll(".msg-row").forEach((el) => el.remove());
  syncEmpty();
}

async function loadMe() {
  try {
    const me = await api("/me");
    window.__userAvatar = me.loggedIn && me.avatarUrl ? (API + "/proxy-img?url=" + encodeURIComponent(me.avatarUrl)) : "";
    const av = document.getElementById("account-avatar");
    if (me.loggedIn && me.avatarUrl) {
      av.innerHTML = `<img src="${esc(API + "/proxy-img?url=" + encodeURIComponent(me.avatarUrl))}" alt="头像" />`;
      av.classList.add("sand-avatar--account");
    } else {
      av.innerHTML = me.loggedIn ? esc(me.name.slice(0, 1) || "?") : "?";
    }
  } catch { /* 忽略 */ }
}

async function openSession(id, { render = true } = {}) {
  const r = await api("/session/open", { method: "POST", body: { sessionId: id } });
  if (!r.ok) return;
  currentSessionId = r.sessionId || id;
  if (render) {
    clearMessages();
    for (const m of r.messages || []) {
      if (m.role === "user") addMsg("user", m.text);
      else addMsg("bot", m.text, { rich: m.role === "assistant", tool: m.role !== "assistant" });
    }
  }
  loadHistory();
}

async function loadHistory() {
  const list = document.getElementById("sidebar-history");
  const r = await api("/sessions");
  const sessions = r.sessions || [];
  if (!sessions.length) {
    list.innerHTML = `<div class="si-empty">暂无历史会话<br>点「新对话」开始</div>`;
    return;
  }
  list.innerHTML = sessions
    .map(
      (s) =>
        `<div class="sidebar-item${s.id === currentSessionId ? " active" : ""}" data-id="${esc(s.id)}">` +
        `<div class="si-main"><div class="si-title">${esc(clean(s.title))}</div>` +
        `<div class="si-meta">${esc(s.count)} 条消息 · ${esc((s.updatedAt || "").slice(0, 10))}</div></div>` +
        `<button class="si-del" data-id="${esc(s.id)}" aria-label="删除"><svg class="ic" width="12" height="12"><use href="#i-close"/></svg></button></div>`,
    )
    .join("");
  list.querySelectorAll(".sidebar-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (e.target.closest(".si-del")) return;
      openSession(item.dataset.id);
    });
  });
  list.querySelectorAll(".si-del").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog({ title: "删除会话", message: "删除后不可恢复，确认？", confirmText: "删除", danger: true });
      if (!ok) return;
      await api("/session/delete", { method: "POST", body: { sessionId: btn.dataset.id } });
      loadHistory();
      if (currentSessionId === btn.dataset.id) {
        clearMessages();
        const n = await api("/session/new", { method: "POST", body: {} });
        currentSessionId = n.sessionId || "me";
      }
    }),
  );
}

const BOT_AVATAR = "./assets/app-icon.png";
const DEFAULT_MODEL = "deepseek-v4-flash";
let _currentModel = DEFAULT_MODEL;
async function loadModels() {
  const r = await api("/models");
  const available = r.available || [];
  const menu = document.getElementById("model-menu");
  if (!available.length) { menu.innerHTML = `<div class="model-menu__empty">无可用模型</div>`; return; }
  // 默认选中具体模型（优先 deepseek-v4-flash）
  const cur = r.current || (available.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : available[0]);
  _currentModel = cur;
  menu.innerHTML = available.map((m) => `<button class="model-menu__item${m === cur ? " active" : ""}" data-model="${esc(m)}">${m === cur ? "✓ " : ""}${esc(m)}</button>`).join("");
  // 首次未指定模型时，把默认模型写回后端使其生效
  if (!r.current) api("/model", { method: "POST", body: { model: cur } });
}

function toggleModelMenu(show) {
  const menu = document.getElementById("model-menu");
  menu.classList.toggle("hidden", !show);
}

document.getElementById("model-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleModelMenu(document.getElementById("model-menu").classList.contains("hidden"));
});
document.getElementById("model-menu").addEventListener("click", async (e) => {
  const item = e.target.closest(".model-menu__item");
  if (!item) return;
  const model = item.dataset.model;
  _currentModel = model;
  const r = await api("/model", { method: "POST", body: { model } });
  if (r.ok) { toast("已切换模型：" + (r.model || model), "ok"); loadModels(); }
  else toast(clean(r.message || "切换失败"), "err");
  toggleModelMenu(false);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".model-wrap")) toggleModelMenu(false);
});

document.getElementById("sidebar-new").addEventListener("click", async () => {
  const r = await api("/session/new", { method: "POST", body: {} });
  currentSessionId = r.sessionId || "s-" + Date.now();
  clearMessages();
  loadHistory();
});

// 侧栏收起/展开
document.getElementById("sidebar-collapse").addEventListener("click", () => {
  document.getElementById("chat-sidebar").classList.add("collapsed");
  document.getElementById("sidebar-expand").classList.remove("hidden");
});
document.getElementById("sidebar-expand").addEventListener("click", () => {
  document.getElementById("chat-sidebar").classList.remove("collapsed");
  document.getElementById("sidebar-expand").classList.add("hidden");
  loadHistory();
});



// ---------- 账户菜单 ----------
const accountTrigger = document.getElementById("account-trigger");
const accountMenu = document.getElementById("account-menu");
accountTrigger.addEventListener("click", (e) => {
  e.stopPropagation();
  accountMenu.classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!accountMenu.classList.contains("hidden") && !e.target.closest("#account-menu") && !e.target.closest("#account-trigger")) {
    accountMenu.classList.add("hidden");
  }
});
// 所有 target=_blank 链接：走系统浏览器（WebView 内 window.open 会被拦截）
document.addEventListener("click", (e) => {
  const a = e.target.closest?.('a[target="_blank"]');
  if (a) {
    e.preventDefault();
    api("/open-url", { method: "POST", body: { url: a.href } });
  }
});
accountMenu.querySelector('[data-act="status"]').addEventListener("click", () => {
  accountMenu.classList.add("hidden");
  const btn = document.querySelector('.sand-nav__item[data-view="status"]');
  btn.click();
  loadEnv();
});
accountMenu.querySelector('[data-act="logout"]').addEventListener("click", async () => {
  accountMenu.classList.add("hidden");
  const ok = await confirmDialog({ title: "登出", message: "将清除本机飞书授权凭证，确认登出？", confirmText: "登出", danger: true });
  if (!ok) return;
  const r = await api("/auth/logout", { method: "POST", body: {} });
  toast(r.ok ? "已登出" : clean(r.message || "登出失败"), r.ok ? "ok" : "err");
  loadEnv();
});

// 初始化：恢复最新会话 + 加载模型
// 启动加载：先 loadEnv（设置当前 openId → 会话目录隔离），再初始化会话列表
(async () => {
  await loadEnv();
  loadModels();
  const r = await api("/sessions");
  const sessions = r.sessions || [];
  if (sessions.length) {
    await openSession(sessions[0].id);
  } else {
    const n = await api("/session/new", { method: "POST", body: {} });
    currentSessionId = n.sessionId || "me";
  }
  loadHistory();
})();

// ============ 安装向导 ============
const wizard = document.getElementById("wizard-body");
const wizardSteps = document.getElementById("wizard-steps");
let wz = 0;
const WIZ = [
  { id: "env", title: "环境检查" },
  { id: "login", title: "飞书登录" },
  { id: "bot", title: "开通个人 Bot" },
  { id: "magene", title: "模型网关" },
  { id: "daemon", title: "启动守护进程" },
  { id: "done", title: "完成" },
];

function renderWizardBar() {
  wizardSteps.innerHTML = WIZ.map((s, i) =>
    `<span class="wz-step ${i < wz ? "done" : i === wz ? "active" : ""}"><span class="wz-step__num">${i < wz ? "✓" : i + 1}</span>${s.title}</span>`,
  ).join("");
}

/** 就绪卡片：步骤已配置完成时醒目展示 */
function readyCard(title, desc) {
  return `<div class="wz-ready"><div class="wz-ready__icon">✓</div><div><div class="wz-ready__title">${esc(title)}</div><div class="wz-ready__desc">${desc}</div></div></div>`;
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
  else if (step.id === "magene") await wzMagene();
  else if (step.id === "daemon") await wzDaemon();
  else await wzDone();
}

async function wzEnv() {
  wizard.innerHTML = '<span class="meta">检查中…</span>';
  const e = await api("/env");
  const okCli = e.larkCli?.installed;
  const okCfg = e.config?.initialized;
  const okAuth = !!e.auth?.loggedIn;
  wizard.innerHTML =
    `<h3>环境检查</h3>` +
    `<div>${dot(okCli ? "ok" : "err", "lark-cli")}：${okCli ? e.larkCli.version : "未安装"}</div>` +
    `<div>${dot(okCfg ? "ok" : "err", "配置")}：${okCfg ? "已初始化" : "未初始化"}</div>` +
    `<div>${dot(okAuth ? "ok" : "err", "登录")}：${okAuth ? clean(e.auth.name) : "未登录"}</div>` +
    (okCli && okCfg ? "" : `<div class="hint">请先安装并初始化：<code>npm install -g @larksuite/cli</code>；<code>lark-cli config init --new</code></div>`);
  wizard.appendChild(
    wzActions(
      `<button class="sand-kit-button" data-act="refresh">重新检查</button>` +
        `<button class="sand-kit-button sand-kit-button--accent" data-act="next" ${okCli && okCfg ? "" : "disabled"}>下一步</button>`,
    ),
  );
  wizard.querySelector('[data-act="refresh"]').addEventListener("click", () => runWizardStep());
  wizard.querySelector('[data-act="next"]').addEventListener("click", () => wzGo(1));
}

async function wzLogin() {
  wizard.innerHTML =
    `<h3>飞书登录</h3>` +
    `<p class="hint">点「发起登录」，在浏览器打开链接或扫码，完成后点「我已授权」</p>` +
    `<div id="wz-login-url" class="login-url"></div><img id="wz-login-qr" class="qr hidden" alt="登录二维码" />` +
    `<div class="row"><button id="wz-login-open" class="sand-kit-button">发起登录</button><button id="wz-login-done" class="sand-kit-button sand-kit-button--accent" disabled>我已授权</button></div>` +
    `<div id="wz-login-status" class="hint"></div>`;
  const e = await api("/env");
  if (e.auth?.loggedIn) {
    wizard.innerHTML = `<h3>飞书登录</h3>` + readyCard("已登录", `身份：<code>${esc(clean(e.auth.name))}</code>（${e.auth.scopes} 个授权 scope）`);
    wizard.appendChild(wzActions(`<button class="sand-kit-button sand-kit-button--accent" data-act="next">下一步</button>`));
    wizard.querySelector('[data-act="next"]').addEventListener("click", () => wzGo(2));
    return;
  }
  document.getElementById("wz-login-open").addEventListener("click", wzLoginStart);
  document.getElementById("wz-login-done").addEventListener("click", wzLoginDone);
}

async function wzLoginStart() {
  const st = document.getElementById("wz-login-status");
  const openBtn = document.getElementById("wz-login-open");
  busy(openBtn, true);
  const r = await api("/login", { method: "POST", body: {} });
  busy(openBtn, false);
  if (!r.ok) return (st.textContent = "失败：" + clean(r.message));
  window._wzCode = r.deviceCode;
  document.getElementById("wz-login-url").innerHTML = `<a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a>`;
  const qr = document.getElementById("wz-login-qr");
  qr.src = API + r.qrUrl;
  qr.classList.remove("hidden");
  document.getElementById("wz-login-done").disabled = false;
  st.textContent = "请在浏览器完成授权，然后点「我已授权」";
}

async function wzLoginDone() {
  if (!window._wzCode) {
    document.getElementById("wz-login-status").textContent = "请先发起登录";
    return;
  }
  const st = document.getElementById("wz-login-status");
  const doneBtn = document.getElementById("wz-login-done");
  busy(doneBtn, true);
  st.textContent = "等待授权…";
  const r = await api("/login/complete", { method: "POST", body: { deviceCode: window._wzCode } });
  busy(doneBtn, false);
  st.textContent = r.ok ? `登录成功：${clean(r.identity?.name)}` : "登录未完成：" + clean(r.message);
  if (r.ok) {
    toast("登录成功", "ok");
    const next = document.querySelector(".wizard-actions");
    if (next) next.remove();
    wizard.appendChild(wzActions(`<button class="sand-kit-button sand-kit-button--accent" data-act="next">下一步</button>`));
    wizard.querySelector('[data-act="next"]').addEventListener("click", () => wzGo(2));
  }
}

async function wzBot() {
  wizard.innerHTML = '<span class="meta">检查中…</span>';
  const b = await api("/bot/setup-info");
  if (!b.appConfigured) {
    wizard.innerHTML =
      `<h3>开通个人 Bot</h3>` +
      `<div>${dot("err", "尚未配置个人应用")}。两种方式任选：</div>` +
      `<div class="hint">方式一 自助创建：在终端运行 <code>lark-cli config init --new</code>（浏览器完成）；</div>` +
      `<div class="hint">方式二 IT 代建：粘贴 IT 发放的应用物料激活：</div>` +
      `<div class="row"><input id="wz-bot-appid" class="sand-input" placeholder="app_id（cli_xxx）" /></div>` +
      `<div class="row"><input id="wz-bot-secret" class="sand-input" type="password" placeholder="app_secret" /></div>` +
      `<div id="wz-bot-out" class="hint"></div>`;
    wizard.appendChild(
      wzActions(
        `<button class="sand-kit-button" data-act="prev">上一步</button>` +
          `<button class="sand-kit-button sand-kit-button--accent" data-act="activate">激活 IT 代建应用</button>`,
      ),
    );
    wizard.querySelector('[data-act="prev"]').addEventListener("click", () => wzGo(1));
    wizard.querySelector('[data-act="activate"]').addEventListener("click", wzBotActivate);
    return;
  }
  wizard.innerHTML =
    `<h3>开通个人 Bot</h3>` +
    `<div>个人应用：<code>${esc(b.appId)}</code> · 事件总线：${dot(b.busRunning ? "ok" : "err", b.busRunning ? "在线" : "离线")}</div>` +
    `<div class="console-list">` +
    `1. 控制台「事件与回调」启用：im.message.receive_v1、card.action.trigger\n` +
    `2. 「应用能力」添加「机器人」\n` +
    `3. 「版本管理」创建并发布版本\n` +
    `链接：${b.consoleUrl}\n` +
    `</div>` +
    `<p class="hint"><a href="${esc(b.consoleUrl)}" target="_blank">打开开发者后台</a></p>`;
  wizard.appendChild(
    wzActions(
      `<button class="sand-kit-button" data-act="prev">上一步</button>` +
        `<button class="sand-kit-button sand-kit-button--accent" data-act="next">已按指引完成，下一步</button>`,
    ),
  );
  wizard.querySelector('[data-act="prev"]').addEventListener("click", () => wzGo(1));
  wizard.querySelector('[data-act="next"]').addEventListener("click", () => wzGo(3));
}

async function wzBotActivate() {
  const out = document.getElementById("wz-bot-out");
  const appId = document.getElementById("wz-bot-appid").value.trim();
  const appSecret = document.getElementById("wz-bot-secret").value.trim();
  if (!appId || !appSecret) return (out.textContent = "请填写 app_id 和 app_secret");
  const btn = document.querySelector('.wizard-actions [data-act="activate"]');
  busy(btn, true);
  out.textContent = "绑定中…";
  const r = await api("/bot/activate", { method: "POST", body: { appId, appSecret } });
  busy(btn, false);
  out.textContent = clean(r.message) || (r.ok ? "已绑定" : "失败");
  if (r.ok) {
    toast("应用已绑定", "ok");
    wizard.querySelector(".wizard-actions")?.remove();
    wizard.appendChild(wzActions(`<button class="sand-kit-button sand-kit-button--accent" data-act="next">下一步</button>`));
    wizard.querySelector('[data-act="next"]').addEventListener("click", () => wzGo(3));
  }
}

async function wzMagene() {
  wizard.innerHTML = '<span class="meta">检查中…</span>';
  const st = await api("/magene/status");
  const configured = st.apiKeyConfigured && st.baseUrlSource !== "default";
  const portalInfo = await api("/portal/watch-status");
  if (configured) {
    wizard.innerHTML =
      `<h3>模型网关（magene）</h3>` +
      readyCard("模型网关已就绪", `地址：<code>${esc(st.baseUrl || "")}</code>（来源：${esc(st.baseUrlSource || "")}）。已可正常对话。`);
    wizard.appendChild(
      wzActions(
        `<button class="sand-kit-button" data-act="prev">上一步</button>` +
          `<button class="sand-kit-button sand-kit-button--ghost" data-act="edit">修改配置</button>` +
          `<button class="sand-kit-button sand-kit-button--accent" data-act="next">下一步</button>`,
      ),
    );
    wizard.querySelector('[data-act="next"]').addEventListener("click", () => wzGo(4));
    wizard.querySelector('[data-act="edit"]').addEventListener("click", () => renderWzMageneForm(st, portalInfo, false));
    return;
  }
  renderWzMageneForm(st, portalInfo, true);
  wizard.querySelector('[data-act="prev"]').addEventListener("click", () => wzGo(2));
  wizard.querySelector('[data-act="save"]').addEventListener("click", wzMageneSave);
  wizard.querySelector('[data-act="skip"]').addEventListener("click", () => wzGo(4));
  document.getElementById("wz-portal-get").addEventListener("click", wzPortalGet);
}

function renderWzMageneForm(st, portalInfo, showForm) {
  const configured = st.apiKeyConfigured && st.baseUrlSource !== "default";
  wizard.innerHTML =
    `<h3>模型网关（magene）</h3>` +
    (configured ? readyCard("模型网关已就绪", `地址：<code>${esc(st.baseUrl || "")}</code>。可保存新值或直接下一步。`) : `<div class="hint">粘贴公司发放的网关 Base URL 与 API Key；或飞书扫码登录公司门户自动获取。凭证只存本机（0600），不上传。</div>`) +
    `<div class="wz-config-form${showForm ? "" : " collapsed"}">` +
      `<div class="portal-row">` +
        `<button id="wz-portal-get" class="sand-kit-button sand-kit-button--accent">飞书登录获取 API Key</button>` +
      `</div>` +
      `<div id="wz-portal-status" class="hint"></div>` +
      `<div class="row"><input id="wz-magene-url" class="sand-input" placeholder="Base URL" value="${esc((configured ? st.baseUrl : "") || portalInfo.mageneBaseUrl || "")}" /></div>` +
      `<div class="row"><input id="wz-magene-key" class="sand-input" type="password" placeholder="API Key" /></div>` +
      `<div id="wz-magene-out" class="hint"></div>` +
    `</div>`;
  wizard.appendChild(
    wzActions(
      `<button class="sand-kit-button" data-act="prev">上一步</button>` +
        `<button class="sand-kit-button sand-kit-button--accent" data-act="save">保存并验证</button>` +
        `<button class="sand-kit-button sand-kit-button--ghost" data-act="skip">跳过（用自己的模型）</button>`,
    ),
  );
  wizard.querySelector('[data-act="prev"]').addEventListener("click", () => wzGo(2));
  wizard.querySelector('[data-act="save"]').addEventListener("click", wzMageneSave);
  wizard.querySelector('[data-act="skip"]').addEventListener("click", () => wzGo(4));
  document.getElementById("wz-portal-get").addEventListener("click", wzPortalGet);
}

/** portal 自动获取：打开登录页 + 监听剪贴板 → 捕获 Key 后自动保存 */
let _portalTimer = null;
async function wzPortalGet() {
  const btn = document.getElementById("wz-portal-get");
  const st = document.getElementById("wz-portal-status");
  busy(btn, true);
  const openR = await api("/portal/open", { method: "POST", body: {} });
  await api("/portal/watch-start", { method: "POST", body: {} });
  busy(btn, false);
  if (!openR.ok) {
    st.textContent = "打开登录页失败：" + clean(openR.message || "");
    return;
  }
  st.textContent = "已在浏览器打开公司门户。请：1）飞书扫码登录；2）进入控制台点「API key」复制。正在监听剪贴板（120 秒）…";
  if (_portalTimer) clearInterval(_portalTimer);
  let waited = 0;
  _portalTimer = setInterval(async () => {
    waited += 2;
    const s = await api("/portal/watch-status");
    if (s.found && s.keyPreview) {
      clearInterval(_portalTimer);
      _portalTimer = null;
      st.textContent = `已捕获 Key（${s.keyPreview}），正在验证网关…`;
      const keyEl = document.getElementById("wz-magene-key");
      if (keyEl) keyEl.value = ""; // 由随后的 watch-status 提供完整 key？走 setup 内部
      // 从服务端取完整 key 再配置
      const full = await api("/portal/watch-status");
      const out = document.getElementById("wz-magene-out");
      const url = (document.getElementById("wz-magene-url")?.value || s.mageneBaseUrl || "").trim();
      out.textContent = "写入配置…";
      const r = await api("/magene/setup", { method: "POST", body: { baseUrl: url, apiKey: full.found } });
      out.textContent = clean(r.message) || (r.ok ? "已配置" : "失败");
      if (r.ok) {
        toast("模型网关已自动配置", "ok");
        const actions = wizard.querySelector(".wizard-actions");
        actions?.remove();
        wizard.appendChild(wzActions(`<button class="sand-kit-button sand-kit-button--accent" data-act="next">下一步</button>`));
        wizard.querySelector('[data-act="next"]').addEventListener("click", () => wzGo(4));
      }
      return;
    }
    if (!s.active && !s.found) {
      clearInterval(_portalTimer);
      _portalTimer = null;
      st.textContent = "监听超时未捕获到 Key。可手动复制粘贴到上方输入框后点「保存并验证」。";
      return;
    }
    if (waited % 20 === 0) st.textContent = `正在监听剪贴板…（${waited}/120 秒）`;
  }, 2000);
}

async function wzMageneSave() {
  const out = document.getElementById("wz-magene-out");
  const baseUrl = document.getElementById("wz-magene-url").value.trim();
  const apiKey = document.getElementById("wz-magene-key").value.trim();
  if (!apiKey) return (out.textContent = "请填写 API Key");
  const btn = document.querySelector('.wizard-actions [data-act="save"]');
  busy(btn, true);
  out.textContent = "验证中…";
  const r = await api("/magene/setup", { method: "POST", body: { baseUrl, apiKey } });
  busy(btn, false);
  out.textContent = clean(r.message) || (r.ok ? "已保存" : "失败");
  if (r.ok) {
    toast("模型网关已配置", "ok");
    wizard.querySelector(".wizard-actions")?.remove();
    wizard.appendChild(wzActions(`<button class="sand-kit-button sand-kit-button--accent" data-act="next">下一步</button>`));
    wizard.querySelector('[data-act="next"]').addEventListener("click", () => wzGo(4));
  }
}

async function wzDaemon() {
  wizard.innerHTML = '<span class="meta">检查中…</span>';
  const st = await api("/daemon/status");
  wizard.innerHTML =
    `<h3>启动守护进程</h3>` +
    `<div>守护进程：${dot(st.running ? "ok" : "err", st.running ? "运行中" : "未运行")} · 事件总线：${dot(st.busOnline ? "ok" : "err", st.busOnline ? "在线" : "离线")}</div>` +
    `<div class="hint">守护进程常驻后台接收飞书消息；建议配置开机自启，重启电脑后助手自动恢复。</div>` +
    `<div id="wz-daemon-out" class="console-list"></div>`;
  wizard.appendChild(
    wzActions(
      `<button class="sand-kit-button" data-act="prev">上一步</button>` +
        `<button class="sand-kit-button ${st.running ? "" : "sand-kit-button--accent"}" data-act="start">${st.running ? "重启" : "启动"}</button>` +
        `<button class="sand-kit-button" data-act="stop" ${st.running ? "" : "disabled"}>停止</button>` +
        `<button class="sand-kit-button sand-kit-button--ghost" data-act="autostart">配置开机自启</button>` +
        `<button class="sand-kit-button sand-kit-button--accent" data-act="next">完成</button>`,
    ),
  );
  wizard.querySelector('[data-act="prev"]').addEventListener("click", () => wzGo(3));
  wizard.querySelector('[data-act="start"]').addEventListener("click", () => wzDaemonControl("start"));
  wizard.querySelector('[data-act="stop"]').addEventListener("click", () => wzDaemonControl("stop"));
  wizard.querySelector('[data-act="autostart"]').addEventListener("click", wzDaemonAutostart);
  wizard.querySelector('[data-act="next"]').addEventListener("click", () => wzGo(5));
}

async function wzDaemonControl(action) {
  const out = document.getElementById("wz-daemon-out");
  const btn = document.querySelector(`.wizard-actions [data-act="${action === "start" ? "start" : "stop"}"]`);
  busy(btn, true);
  const r = await api("/daemon/" + action, { method: "POST", body: {} });
  busy(btn, false);
  out.textContent = clean(r.output || r.message || (r.ok ? "完成" : "失败"));
  await runWizardStep();
}

async function wzDaemonAutostart() {
  const out = document.getElementById("wz-daemon-out");
  const btn = document.querySelector('.wizard-actions [data-act="autostart"]');
  busy(btn, true);
  const r = await api("/daemon/install", { method: "POST", body: {} });
  busy(btn, false);
  out.textContent = clean(r.output || r.message || (r.ok ? "已配置" : "失败"));
  toast(r.ok ? "已配置开机自启" : clean(r.message) || "配置失败", r.ok ? "ok" : "err");
}

async function wzDone() {
  wizard.innerHTML =
    `<h3>安装完成</h3>` +
    `<p class="hint">现在打开飞书，私聊你的 Bot（应用名），开始使用个人 AI 助手：问答、申请权限、入职引导。</p>` +
    `<div class="console-list">常用入口：/coworker:setup（CLI 引导）· coworker-daemon status（守护状态）</div>`;
  wizard.appendChild(wzActions(`<button class="sand-kit-button" data-act="prev">上一步</button>`));
  wizard.querySelector('[data-act="prev"]').addEventListener("click", () => wzGo(4));
}

function wzGo(n) {
  wz = Math.max(0, Math.min(WIZ.length - 1, n));
  runWizardStep();
}

// 导航到向导时进入
const _wzBtn = document.querySelector(".sand-nav__item[data-view=wizard]");
if (_wzBtn) _wzBtn.addEventListener("click", () => runWizardStep());

// ============ 扩展 UI 交互卡片（confirm / select / input / notify） ============
// 后端把 pi 的 extension_ui_request 排队，前端轮询并渲染成卡片，用户操作后回传响应。

let _uiBusy = false;
let _uiQueue = [];
let _uiResolve = null;

function showUiRequest(req) {
  const method = req.method;
  if (method === "notify") {
    toast(req.message || req.title || "", "ok");
    return;
  }
  if (method === "confirm") {
    confirmDialog({
      title: req.title || "请确认",
      message: req.message || req.title || "",
      confirmText: req.confirmText || "确认",
      danger: !!req.danger,
    }).then((yes) => respondUi(req.id, yes ? { confirmed: true } : { cancelled: true }));
    return;
  }
  if (method === "select") {
    showSelectCard(req);
    return;
  }
  if (method === "input") {
    showInputCard(req);
    return;
  }
  respondUi(req.id, { cancelled: true });
}

async function drainUiQueue() {
  if (_uiBusy) return;
  _uiBusy = true;
  try {
    while (_uiQueue.length) {
      const req = _uiQueue.shift();
      if (req.method === "notify") {
        showUiRequest(req);
        continue;
      }
      // dialog：展示卡片，等待用户响应（respondUi 会唤醒继续下一条）
      await new Promise((resolve) => {
        _uiResolve = resolve;
        showUiRequest(req);
      });
    }
  } finally {
    _uiBusy = false;
  }
}

async function respondUi(id, payload) {
  try {
    await api("/interaction/respond", { method: "POST", body: Object.assign({ id }, payload) });
  } catch {
    /* 响应失败不阻塞 */
  }
  const wake = _uiResolve;
  _uiResolve = null;
  if (wake) wake();
  drainUiQueue();
}

function showSelectCard(req) {
  const modal = document.getElementById("modal");
  document.getElementById("modal-title").textContent = req.title || "请选择";
  const body = document.getElementById("modal-body");
  body.innerHTML = (req.options || [])
    .map((o, i) => `<button class="ui-option" data-i="${i}">${esc(String(o))}</button>`)
    .join("");
  const ok = document.getElementById("modal-ok");
  ok.classList.add("hidden");
  document.getElementById("modal-cancel").textContent = "取消";
  modal.classList.remove("hidden");
  const cleanup = () => {
    modal.classList.add("hidden");
    ok.classList.remove("hidden");
    body.querySelectorAll(".ui-option").forEach((b) => (b.onclick = null));
    document.getElementById("modal-cancel").onclick = null;
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      cleanup();
      respondUi(req.id, { cancelled: true });
    }
  };
  document.addEventListener("keydown", onKey);
  document.getElementById("modal-cancel").onclick = () => {
    cleanup();
    respondUi(req.id, { cancelled: true });
  };
  body.querySelectorAll(".ui-option").forEach((b) => {
    b.onclick = () => {
      const v = req.options[Number(b.dataset.i)];
      cleanup();
      respondUi(req.id, { value: v });
    };
  });
}

function showInputCard(req) {
  const modal = document.getElementById("modal");
  document.getElementById("modal-title").textContent = req.title || "请输入";
  const body = document.getElementById("modal-body");
  body.innerHTML = `<textarea id="ui-input" class="sand-input sand-textarea" rows="3" placeholder="${esc(req.placeholder || "")}"></textarea>`;
  const ok = document.getElementById("modal-ok");
  ok.textContent = "提交";
  ok.classList.remove("hidden");
  document.getElementById("modal-cancel").textContent = "取消";
  modal.classList.remove("hidden");
  const input = document.getElementById("ui-input");
  input.focus();
  const cleanup = () => {
    modal.classList.add("hidden");
    document.getElementById("modal-cancel").onclick = null;
    ok.onclick = null;
    document.removeEventListener("keydown", onKey);
  };
  const submit = () => {
    const v = input.value;
    cleanup();
    respondUi(req.id, v ? { value: v } : { cancelled: true });
  };
  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") {
      cleanup();
      respondUi(req.id, { cancelled: true });
    }
  };
  document.addEventListener("keydown", onKey);
  ok.onclick = submit;
  document.getElementById("modal-cancel").onclick = () => {
    cleanup();
    respondUi(req.id, { cancelled: true });
  };
}

async function pollUi() {
  try {
    const r = await api("/interaction/poll");
    if (r.items && r.items.length) {
      for (const it of r.items) {
        if (it.method === "notify") {
          showUiRequest(it); // notify 一次性消费
          continue;
        }
        if (_uiQueue.some((q) => q.id === it.id)) continue; // dialog 按 id 去重
        _uiQueue.push(it);
      }
      drainUiQueue();
    }
  } catch {
    /* 轮询失败重试 */
  }
}
setInterval(pollUi, 1500);

// ============ 托盘事件（Tauri 菜单） ============
const Tauri = window.__TAURI__;
if (Tauri?.event) {
  Tauri.event.listen("daemon-start", () => { api("/daemon/start", { method: "POST", body: {} }).then(() => toast("守护进程已启动", "ok")); });
  Tauri.event.listen("daemon-stop", () => { api("/daemon/stop", { method: "POST", body: {} }).then(() => toast("守护进程已停止")); });
}
