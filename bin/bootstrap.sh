#!/usr/bin/env bash
# ============================================================
# coworker-coworker 企业引导脚本
# 用途：在新员工机器上一键准备 pi + lark-cli + coworker-coworker
# 用法：
#   bash <(curl -fsSL <公司内网脚本地址>/bootstrap.sh)
#   # 或本地：
#   bash bin/bootstrap.sh
# ============================================================
set -euo pipefail

log()  { printf "\033[1;32m[coworker]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[coworker]\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m[coworker]\033[0m %s\n" "$*" >&2; exit 1; }

# 安装源：可被环境变量覆盖（公司内网 npm 镜像）
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

# ---------- 3. coworker-coworker ----------
log "安装 coworker-coworker（${COWORKER_GIT_URL}${COWORKER_REF}）..."
if [ -n "$NPM_REGISTRY" ]; then
  export npm_config_registry="$NPM_REGISTRY"
fi
if [ "${COWORKER_INSTALL_LOCAL:-0}" = "1" ] && [ -n "${COWORKER_LOCAL_PATH:-}" ]; then
  pi install "$COWORKER_LOCAL_PATH"
else
  pi install "${COWORKER_GIT_URL}${COWORKER_REF}"
fi
log "coworker-coworker 安装完成"

# ---------- 4. 引导 ----------
log ""
log "=============================================="
log " 下一步（在任意目录运行 pi，然后输入）："
log "    /coworker:setup"
log "  按引导完成飞书登录与权限申请。"
log "  需要管理员维护 catalog / knowledge / policy："
log "    ~/.pi/agent/npm/coworker-coworker/config/"
log "=============================================="
