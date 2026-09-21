#!/usr/bin/env bash
# 发布后把 Windows 安装包（NSIS setup.exe）下载并 SCP 到 Win10 虚拟机 Downloads。
#
# 用法：
#   scripts/deploy-win.sh                # 用 GitHub 最新 release
#   scripts/deploy-win.sh v0.5.2         # 指定 tag
#
# 环境变量（可覆盖）：
#   WIN_HOST   SSH 主机别名（默认 win10，见 ~/.ssh/config：内网 IP:2222 dean，具体地址勿入库）
#   DL_DIR     本机缓存目录（默认 ~/.coworker/dl）
#
# 依赖：curl / scp / ssh（BatchMode，需已配置密钥登录）
set -euo pipefail

REPO="dncore/pi-coworker"
WIN_HOST="${WIN_HOST:-win10}"
DL_DIR="${DL_DIR:-$HOME/.coworker/dl}"
mkdir -p "$DL_DIR"

# 解析 tag
TAG="${1:-}"
if [ -z "$TAG" ]; then
  TAG=$(curl -fsSL --max-time 20 "https://api.github.com/repos/$REPO/releases/latest" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'])")
fi
VER="${TAG#v}"
# 资产名带 v 前缀：pi-coworker-gui-setup-v0.5.2.exe
FILE="pi-coworker-gui-setup-${TAG}.exe"
URL="https://github.com/$REPO/releases/download/${TAG}/${FILE}"
LOCAL="$DL_DIR/$FILE"

echo "== 下载 $FILE =="
curl -fL --retry 3 --max-time 600 -o "$LOCAL" "$URL"
echo "  本地: $LOCAL ($(du -h "$LOCAL" | cut -f1))"
echo "  SHA256: $(shasum -a 256 "$LOCAL" | awk '{print $1}')"

echo "== 传输到 $WIN_HOST:Downloads =="
scp -o ConnectTimeout=10 -o BatchMode=yes "$LOCAL" "$WIN_HOST:Downloads/${FILE}.download"
ssh -o ConnectTimeout=10 -o BatchMode=yes "$WIN_HOST" "move /y %USERPROFILE%\\Downloads\\${FILE}.download %USERPROFILE%\\Downloads\\${FILE} >nul && echo 移动完成" 2>/dev/null \
  || scp -o ConnectTimeout=10 -o BatchMode=yes "$LOCAL" "$WIN_HOST:Downloads/${FILE}" 2>/dev/null \
  || { echo "❌ SCP 失败"; exit 1; }

echo "== 远端确认 =="
ssh -o ConnectTimeout=10 -o BatchMode=yes "$WIN_HOST" "dir %USERPROFILE%\\Downloads\\${FILE}" 2>&1 | grep -i "${VER}" | head -2
echo "✅ ${TAG} 已推送到 ${WIN_HOST}:C:\\Users\\dean\\Downloads\\${FILE}"

# 部署配置（内网地址与公司资源标识，均不在仓库内）：本机存在则同步到测试机。
#   deploy.json   —— portal/网关地址（向导预填 + 门户取 Key）
#   catalog.json  —— 权限目录真实 spaceId（包内模板只有占位符，见 README/RELEASE）
#   knowledge.json—— 知识源真实 base/space/url
ssh -o ConnectTimeout=10 -o BatchMode=yes "$WIN_HOST" "mkdir %USERPROFILE%\\.coworker 2>NUL" 2>/dev/null || true
synced=0
for f in deploy.json catalog.json knowledge.json; do
  SRC="$HOME/.coworker/$f"
  if [ -f "$SRC" ]; then
    if scp -o ConnectTimeout=10 -o BatchMode=yes "$SRC" "$WIN_HOST:.coworker/$f"; then
      echo "✅ $f 已同步到测试机 ~/.coworker/"
      synced=$((synced + 1))
    else
      echo "⚠️ $f 同步失败（不影响安装包，可手动放置）"
    fi
  fi
done
[ "$synced" -gt 0 ] || echo "ℹ️ 本机无 ~/.coworker/{deploy,catalog,knowledge}.json，跳过部署配置同步"