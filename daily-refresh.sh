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
