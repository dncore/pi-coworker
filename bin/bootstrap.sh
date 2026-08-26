#!/usr/bin/env bash
# ============================================================
# coworker 企业引导脚本（一键安装）
# 用途：在新员工机器上一键准备 pi + lark-cli + pi-coworker，
#       并可选注册守护进程开机自启、启动守护进程。
# 用法：
#   bash <(curl -fsSL <公司内网脚本地址>/bootstrap.sh)
#   # 或本地：
#   bash bin/bootstrap.sh
#
# 环境变量：
#   NPM_REGISTRY          npm 镜像（公司内网）
#   COWORKER_GIT_URL      安装源（默认 git:github.com/dncore/pi-coworker）
#   COWORKER_REF          版本（默认 @v0.1.0）
#   COWORKER_INSTALL_LOCAL=1 + COWORKER_LOCAL_PATH=<路径>   本地源码安装
#   SKIP_AUTOSTART=1      跳过配置开机自启
#   SKIP_DAEMON=1         跳过启动守护进程
# ============================================================
set -euo pipefail

log()  { printf "\033[1;32m[coworker]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[coworker]\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m[coworker]\033[0m %s\n" "$*" >&2; exit 1; }

NPM_REGISTRY="${NPM_REGISTRY:-}"
COWORKER_GIT_URL="${COWORKER_GIT_URL:-git:github.com/dncore/pi-coworker}"
COWORKER_REF="${COWORKER_REF:-@v0.1.0}"

# ---------- 1. pi ----------
if command -v pi >/dev/null 2>&1; then
  log "pi 已安装：$(pi --version 2>/dev/null || echo ok)"
else
  warn "未检测到 pi，请先安装 pi（见 https://github.com/badlogic/pi 或公司内网指引）。"
  warn "安装 pi 后重新运行本脚本。"
  fail "缺少 pi"
fi

# ---------- 2. lark-cli ----------
if command -v lark-cli >/dev/null 2>&1; then
  log "lark-cli 已安装：$(lark-cli --version 2>/dev/null | head -1 || echo ok)"
else
  log "正在安装 lark-cli（@larksuite/cli）..."
  if command -v npm >/dev/null 2>&1; then
    if [ -n "$NPM_REGISTRY" ]; then
      npm install -g @larksuite/cli --registry "$NPM_REGISTRY"
    else
      npm install -g @larksuite/cli
    fi
    log "lark-cli 安装完成"
  else
    warn "未检测到 npm，请安装 Node.js ≥ 18 后重试，或用其他方式安装 lark-cli。"
    fail "缺少 npm"
  fi
fi

# ---------- 3. pi-coworker ----------
log "安装 pi-coworker（${COWORKER_GIT_URL}${COWORKER_REF}）..."
if [ -n "$NPM_REGISTRY" ]; then
  export npm_config_registry="$NPM_REGISTRY"
fi
if [ "${COWORKER_INSTALL_LOCAL:-0}" = "1" ] && [ -n "${COWORKER_LOCAL_PATH:-}" ]; then
  pi install "$COWORKER_LOCAL_PATH"
  PKG_DIR="$(cd "$COWORKER_LOCAL_PATH" && pwd)"
else
  pi install "${COWORKER_GIT_URL}${COWORKER_REF}"
  # 定位安装后的包目录（pi 包的常见落点，逐个探测）
  PKG_DIR=""
  for cand in \
    "${HOME}/.pi/agent/git/github.com/dncore/pi-coworker" \
    "${HOME}/.pi/agent/npm/pi-coworker" \
    "${HOME}/.pi/agent/npm/node_modules/pi-coworker"; do
    if [ -f "$cand/agent/bin/coworker-daemon.ts" ]; then
      PKG_DIR="$cand"
      break
    fi
  done
fi
log "pi-coworker 安装完成"

# ---------- 4. 注册开机自启（可选） ----------
DAEMON_CLI=""
if [ -n "$PKG_DIR" ] && [ -f "$PKG_DIR/agent/bin/coworker-daemon.ts" ]; then
  DAEMON_CLI="$PKG_DIR/agent/bin/coworker-daemon.ts"
  log "定位到守护进程 CLI：$DAEMON_CLI"
fi

if [ "${SKIP_AUTOSTART:-0}" != "1" ] && [ -n "$DAEMON_CLI" ]; then
  log "注册开机自启（coworker-daemon install --autostart）..."
  node "$DAEMON_CLI" install --autostart || warn "开机自启配置失败（可稍后手动执行：node $DAEMON_CLI install --autostart）"
else
  warn "跳过开机自启配置（SKIP_AUTOSTART=1 或未定位到包目录）"
fi

# ---------- 5. 启动守护进程（可选） ----------
if [ "${SKIP_DAEMON:-0}" != "1" ] && [ -n "$DAEMON_CLI" ]; then
  log "启动 Bot Agent 守护进程..."
  node "$DAEMON_CLI" start || warn "守护进程启动失败（稍后可执行：node $DAEMON_CLI start）"
fi

# ---------- 6. 引导 ----------
log ""
log "=============================================="
log " 下一步（在任意目录运行 pi，然后输入）："
log "    /coworker:setup"
log "  按引导完成：飞书授权登录 → 个人 Bot → 模型网关(magene) → 权限申请。"
log ""
log "  常用命令："
log "    node ${DAEMON_CLI:-<包目录>/agent/bin/coworker-daemon.ts} status      # 守护进程状态"
log "    node ${DAEMON_CLI:-<包目录>/agent/bin/coworker-daemon.ts} logs       # 查看日志"
log "    node ${DAEMON_CLI:-<包目录>/agent/bin/coworker-daemon.ts} check-update --url <更新源>  # 检查更新"
log ""
log "  需要管理员维护 catalog / knowledge / policy："
log "    ${PKG_DIR:-~/.pi/agent/npm/pi-coworker}/config/"
log "=============================================="
