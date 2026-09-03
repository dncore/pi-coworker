#!/usr/bin/env bash
# 发布后把 Windows 安装包（NSIS setup.exe）下载并 SCP 到 Win10 虚拟机 Downloads。
#
# 用法：
#   scripts/deploy-win.sh                # 用 GitHub 最新 release
#   scripts/deploy-win.sh v0.5.2         # 指定 tag
#
# 环境变量（可覆盖）：
#   WIN_HOST   SSH 主机别名（默认 win10，见 ~/.ssh/config：192.168.32.12:2222 dean）
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