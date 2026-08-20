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
