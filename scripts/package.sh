#!/usr/bin/env bash
# ============================================================
# package.sh —— 打包可离线分发的 pi-coworker tarball
# 用途：无 Gitee/GitHub 仓库访问权限的环境（内网/离线）安装。
# 产出：dist/pi-coworker-<version>.tar.gz
# 用法：
#   ./scripts/package.sh [输出目录]        # 默认 dist/
# ============================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-dist}"
VERSION="$(node -p "require('${ROOT}/package.json').version")"

mkdir -p "${OUT_DIR}"
OUT="${OUT_DIR}/pi-coworker-${VERSION}.tar.gz"

# 排除：依赖、构建产物、git、本机运行痕迹
tar -czf "${OUT}" \
  --exclude=node_modules \
  --exclude=.git \
  --exclude='*.tsbuildinfo' \
  --exclude='.coworker*' \
  --exclude='gui/src-tauri/target' \
  --exclude='gui/src-tauri/gen' \
  --exclude='gui/src-tauri/Cargo.lock' \
  --exclude='.gui-sessions' \
  -C "${ROOT}" \
  .gitignore LICENSE README.md DESIGN.md package.json tsconfig.json \
  bin scripts docs extensions skills config agent \
  gui/README.md gui/DISTRIBUTION.md gui/package.json gui/backend gui/src

echo "✅ 已生成：${OUT}"
echo "   大小：$(du -h "${OUT}" | cut -f1)"
echo ""
echo "安装方式："
echo "  1. 解压：tar -xzf ${OUT}"
echo "  2. 安装扩展：cd pi-coworker-${VERSION} && pi install ."
echo "  3. 或在解压目录运行：pi -e extensions/index.ts 直接试运行"
echo "  4. 一键安装（含 lark-cli/守护进程自启）：bash bin/bootstrap.sh"
