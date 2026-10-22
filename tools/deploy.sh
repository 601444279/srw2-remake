#!/usr/bin/env bash
# 把某个提交（默认 HEAD）构建好传到 Cloudflare，给朋友测试。
#   tools/deploy.sh            部署 HEAD
#   tools/deploy.sh play-1023  部署某个标签/分支/提交
# 在单独的 git worktree 里构建，工作区里没提交的改动不会带上去，本地 5174 照常开发。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${1:-HEAD}"
COMMIT="$(git -C "$ROOT" rev-parse --short "$REF^{commit}")"
TREE="$(mktemp -d)/srw2-$COMMIT"

cleanup() { git -C "$ROOT" worktree remove --force "$TREE" 2>/dev/null || true; }
trap cleanup EXIT

git -C "$ROOT" worktree add --detach "$TREE" "$COMMIT" >/dev/null
ln -s "$ROOT/node_modules" "$TREE/node_modules"

(cd "$TREE" && npx vite build --outDir "$ROOT/dist" --emptyOutDir --logLevel warn)
# 模拟器对照页要自己的 ROM，测试版不需要
rm -f "$ROOT/dist/emu.html"
echo "$COMMIT $(git -C "$ROOT" log -1 --format='%ci %s' "$COMMIT")" > "$ROOT/dist/version.txt"

# wrangler 不认 socks5h，改走 v2rayN 的 HTTP 代理；stdin 接空，免得它部署完弹交互提问卡住
cd "$ROOT"
env -u ALL_PROXY -u all_proxy HTTPS_PROXY=http://127.0.0.1:10808 HTTP_PROXY=http://127.0.0.1:10808 \
  npx -y wrangler@4 deploy --message "$COMMIT" < /dev/null
echo "已部署 $COMMIT"
