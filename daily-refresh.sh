#!/bin/bash
# ============================================================
# 春山户外 · 每日 08:30（北京时间）定时刷新内盘+外盘（Linux 云服务器版）
# ------------------------------------------------------------
# 对应 Windows 版 daily-refresh.ps1，行为等价：
#   [1/3] 内盘: node deploy-domestic.js --rebuild（聚水潭→内嵌→git→飞书）
#   [2/3] 外盘拉数: node build-crossborder.js（领星MCP→operation_data.json）
#   [3/3] 外盘部署: node deploy-dashboard.js（内嵌→git→飞书）
# 任一步失败：聚合推送飞书群机器人（alert-webhook.json），exit 1
# cron: 30 8 * * * /opt/chunshan/deploy/daily-refresh.sh
# ============================================================
set -u
export PATH=/usr/local/bin:/usr/bin:/bin:$PATH
export CS_ROOT="${CS_ROOT:-/opt/chunshan}"
export TZ=Asia/Shanghai

DEPLOY_DIR="$CS_ROOT/deploy"
LOG_FILE="$DEPLOY_DIR/daily-refresh.log"
DATA_FILE="$CS_ROOT/operation_data.json"
ALERT_FILE="$DEPLOY_DIR/alert-webhook.json"
RUN_DATE="$(date +%F)"
HAD_ERROR=0
FAILURES=()

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG_FILE"; }

record_failure() { FAILURES+=("$1 -- $2"); HAD_ERROR=1; }

send_alert() {
  local webhook
  webhook="$(node -e "try{const c=require('$ALERT_FILE');process.stdout.write(c.webhookUrl||'')}catch(e){}" 2>/dev/null)"
  if [ -z "$webhook" ]; then log "  [WARN] 告警webhook未配置，跳过推送"; return; fi
  local text="[告警] 看板每日刷新失败
日期: $RUN_DATE
主机: $(hostname)
失败步骤数: ${#FAILURES[@]}"
  local i=0
  for f in "${FAILURES[@]}"; do
    i=$((i+1))
    f="${f:0:300}"
    text="$text
$i. $f"
  done
  local payload
  payload="$(node -e "process.stdout.write(JSON.stringify({msg_type:'text',text:{content:process.argv[1]}}))" "$text")"
  curl -sS -m 15 -X POST -H 'Content-Type: application/json; charset=utf-8' \
    --data-binary "$payload" "$webhook" >>"$LOG_FILE" 2>&1 \
    && log "失败告警已推送飞书群" \
    || log "  [WARN] 飞书告警webhook请求失败（不影响退出码）"
}

log "========================================"
log "每日定时刷新启动 · $RUN_DATE"
log "========================================"

cd "$DEPLOY_DIR" || { echo "deploy dir missing: $DEPLOY_DIR"; exit 1; }

# ---------- [1/3] 内盘 ----------
log "[1/3] 内盘 deploy-domestic.js --rebuild"
out1="$(node deploy-domestic.js --rebuild 2>&1)"
if [ $? -eq 0 ]; then
  log "  [OK] 内盘部署完成"
else
  log "$out1" | tail -20 | sed 's/^/  /' >> "$LOG_FILE"
  log "  [ERR] 内盘部署失败"
  record_failure "[1/3] 内盘 deploy-domestic.js --rebuild" "$(echo "$out1" | tail -5 | tr '\n' ' ')"
fi

# ---------- [2/3] 外盘拉数 ----------
# 先同步 GitHub Actions 在海外跑好的乐天数据（乐天真直连被墙，由Actions每日08:10聚合提交）
log "[2/3] git pull（同步Actions乐天数据）"
git pull --ff-only origin main >>"$LOG_FILE" 2>&1 \
  && log "  [OK] 仓库同步完成" \
  || log "  [WARN] git pull失败（沿用本地数据继续，详见日志）"
# 把仓库版（含Actions乐天数据）回灌为工作副本，再跑领星刷新（会保留乐天settlement）
[ -f "$DEPLOY_DIR/operation_data.json" ] && cp "$DEPLOY_DIR/operation_data.json" "$DATA_FILE"

log "[2/3] 外盘 build-crossborder.js（领星MCP拉数）"
out2="$(node build-crossborder.js 2>&1)"
if [ $? -ne 0 ]; then
  log "$out2" | tail -20 | sed 's/^/  /' >> "$LOG_FILE"
  log "  [ERR] 领星拉取失败，外盘部署跳过（数据未更新）"
  record_failure "[2/3] 外盘 build-crossborder.js（领星MCP拉数）" "$(echo "$out2" | tail -5 | tr '\n' ' ')"
  log "========================================"
  log "每日定时刷新结束（外盘跳过，存在失败步骤）"
  log "========================================"
  send_alert
  exit 1
fi
log "  [OK] 领星数据拉取完成"

# 注：日本乐天由 GitHub Actions（海外节点）每日 08:10 聚合并提交 operation_data.json，
#     本流程开头的 git pull 已将其同步进来；佣金按 10.5% 估算、成本参考日亚单位成本。

# ---------- [2.6] 韩国 Coupang（领星MCP，失败不阻断部署） ----------
# ---------- [2.55] 日亚 MSKU 成本主表（统一成本库，失败沿用旧表不阻断） ----------
log "[2.55] 日亚MSKU成本主表 pull-msku-cost"
outMC="$(node pull-msku-cost.js 2>&1)"
if [ $? -eq 0 ]; then
  log "  [OK] 成本主表已刷新"
else
  log "  [ERR] 成本主表刷新失败（沿用 jp-msku-cost.json 旧表）"
  record_failure "[2.55] pull-msku-cost" "$(echo "$outMC" | tail -3 | tr '\n' ' ')"
fi

log "[2.6] 韩国Coupang pull-coupang + build-coupang"
outC="$(node pull-coupang.js 2>&1 && node build-coupang.js 2>&1)"
if [ $? -eq 0 ]; then
  log "  [OK] Coupang聚合完成：$(echo "$outC" | grep -E 'today \|' | head -1)"
else
  log "$outC" | tail -20 | sed 's/^/  /' >> "$LOG_FILE"
  log "  [ERR] Coupang失败（沿用旧数据，不阻断部署）"
  record_failure "[2.6] 韩国Coupang pull/build" "$(echo "$outC" | tail -5 | tr '\n' ' ')"
fi

# ---------- [2.7] Shopee TH/MY（领星MCP回款口径，三周期，失败不阻断） ----------
log "[2.7] Shopee TH/MY pull+build（today/week/month）"
T1_D=$(date -d "yesterday" +%F)
WS_D=$(date -d "7 days ago" +%F)
MS_D=$(date +%Y-%m-01)
SH_OK=1
for P in today week month; do
  case "$P" in
    today) S_D="$T1_D";;
    week)  S_D="$WS_D";;
    month) S_D="$MS_D";;
  esac
  outSP="$(node pull-shopee.js --period="$P" --start="$S_D" --end="$T1_D" 2>&1 \
    && node build-shopee.js --period="$P" --start="$S_D" --end="$T1_D" \
       --rawDir="$DEPLOY_DIR/shopee-raw/$P" --dataPath="$DATA_FILE" 2>&1)"
  if [ $? -eq 0 ]; then
    log "  [OK] Shopee $P ($S_D~$T1_D)"
  else
    log "$outSP" | tail -15 | sed 's/^/  /' >> "$LOG_FILE"
    log "  [ERR] Shopee $P 失败（沿用旧数据）"
    record_failure "[2.7] Shopee $P pull/build" "$(echo "$outSP" | tail -5 | tr '\n' ' ')"
    SH_OK=0
  fi
done
[ "$SH_OK" -eq 0 ] || log "  [OK] Shopee三周期聚合完成"

# ---------- [2.8] Shopee/独立站 下单口径（日亚同款，失败不阻断） ----------
log "[2.8] Shopee/独立站 下单口径 pull-platform-orders"
outP="$(node pull-platform-orders.js 2>&1)"
if [ $? -eq 0 ]; then
  log "  [OK] 多平台下单口径刷新完成（Shopee TH/MY + 独立站日本/国际）"
else
  log "$outP" | tail -20 | sed 's/^/  /' >> "$LOG_FILE"
  log "  [ERR] 多平台下单口径失败（沿用旧数据，不阻断部署）"
  record_failure "[2.8] pull-platform-orders" "$(echo "$outP" | tail -5 | tr '\n' ' ')"
fi

# ---------- [3/3] 外盘部署（仅当数据文件5分钟内被刷新） ----------
log "[3/3] 外盘 deploy-dashboard.js（内嵌+git+飞书）"
if [ ! -f "$DATA_FILE" ]; then
  log "  [SKIP] operation_data.json 不存在，外盘无法部署"
else
  age_sec=$(( $(date +%s) - $(stat -c %Y "$DATA_FILE") ))
  if [ "$age_sec" -lt 300 ]; then
    log "  operation_data.json 刚刚更新（${age_sec}s 前）"
    out3="$(node deploy-dashboard.js --Date="$RUN_DATE" 2>&1)"
    if [ $? -eq 0 ]; then
      log "  [OK] 外盘部署完成"
    else
      log "$out3" | tail -20 | sed 's/^/  /' >> "$LOG_FILE"
      log "  [ERR] 外盘部署失败"
      record_failure "[3/3] 外盘 deploy-dashboard.js（内嵌+git+飞书）" "$(echo "$out3" | tail -5 | tr '\n' ' ')"
    fi
  else
    log "  [SKIP] operation_data.json 未被本流程更新（${age_sec}s 前修改），跳过外盘部署防旧数据覆盖"
  fi
fi

if [ "$HAD_ERROR" -ne 0 ]; then
  log "========================================"
  log "每日定时刷新结束（存在失败步骤，exit 1）"
  log "========================================"
  send_alert
  exit 1
fi
log "========================================"
log "每日定时刷新结束（全部成功）"
log "========================================"
exit 0
