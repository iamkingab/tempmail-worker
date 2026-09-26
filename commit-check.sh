#!/bin/bash
# 提交作者信息 + 隐私终检
set -e
cd /home/ubuntu/tempmail-open-source

git add -A
git -c user.email="dev@example.com" -c user.name="dev" commit -q -m "docs: 补充作者与公众号信息" || echo "(无新改动)"

echo "=== 提交历史 ==="
git log --oneline | head -5
echo
echo "=== 隐私终检：应全部为 0 ==="
for kw in iamking101 48411046a cfut_ 19355e87 "mail.gxair" gxair.de5 "3b7fd5a8" "4232465" 3617579; do
  n=$(git grep -li "$kw" $(git rev-parse HEAD) 2>/dev/null | wc -l)
  printf "  %-14s -> %s\n" "$kw" "$n"
done
echo
echo "=== 允许出现的（公开信息） ==="
git grep -l "iamkingab" $(git rev-parse HEAD) | sed 's|^|  |'
echo
echo "=== 仓库文件数 / 大小 ==="
git ls-files | wc -l
du -sh --exclude=.git .
