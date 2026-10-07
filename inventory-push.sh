#!/bin/bash
# 库存新增每日播报 cron 包装脚本（云服务器独立运行，不依赖本地电脑开机）
#   1. node 拉聚水潭变动 → diff → 机器人发飞书群
#   2. 正式跑（非 --dry-run/--baseline）后归档当日报告到 inventory-reports/ 并自动 git push 留痕
# 用法: inventory-push.sh [--dry-run|--baseline]
# cron: 0 13 * * * /opt/chunshan/deploy/inventory-push.sh >> /opt/chunshan/deploy/inventory-push.cron.log 2>&1
set -u
export PATH=/usr/local/bin:/usr/bin:/bin:$PATH
export TZ=Asia/Shanghai

ROOT="/opt/chunshan"
DEPLOY="$ROOT/deploy"
CRONLOG="$DEPLOY/inventory-push.cron.log"
cd "$DEPLOY" || exit 1

TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo "[$TS] inventory-push start ($*)"

node "$DEPLOY/inventory-daily-push.js" "$@"
RC=$?

# ---------- 自动留痕：归档当日报告并推送 GitHub ----------
SKIP_GIT=0
case " $* " in
    *"--baseline"*|*"--dry-run"*) SKIP_GIT=1 ;;
esac

if [ $RC -eq 0 ] && [ $SKIP_GIT -eq 0 ]; then
    TODAY="$(date '+%F')"
    LATEST="$(ls -1t "$ROOT"/inventory-snap/report-*.txt 2>/dev/null | head -1)"
    if [ -n "$LATEST" ]; then
        mkdir -p "$DEPLOY/inventory-reports"
        cp "$LATEST" "$DEPLOY/inventory-reports/$TODAY.txt"
        cd "$DEPLOY"
        git add inventory-reports/ 2>/dev/null
        if ! git diff --cached --quiet 2>/dev/null; then
            if git commit -m "库存播报 $TODAY" >>"$CRONLOG" 2>&1; then
                # 先 rebase 拉远端（--autostash 容忍工作区脏文件，避免每日8:30看板任务与本任务交叉时冲突），再推送
                git pull --rebase --autostash origin main >>"$CRONLOG" 2>&1
                if git push origin main >>"$CRONLOG" 2>&1; then
                    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [GIT] 报告已推送 GitHub ($TODAY)"
                else
                    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARN] git push 失败，报告已本地归档，详见 $CRONLOG"
                fi
            fi
        else
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] [GIT] 报告无变化，跳过提交"
        fi
    fi
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] inventory-push done (rc=$RC)"
exit $RC
