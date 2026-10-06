<#
.SYNOPSIS
  春山户外 · 每日8:30定时刷新内盘+外盘
.DESCRIPTION
  Step 1: 内盘 — node deploy-domestic.js --rebuild（聚水潭API自动拉数→内嵌→git→飞书）
  Step 2: 外盘 — node build-crossborder.js（领星MCP自动拉数→写operation_data.json）
          → .\deploy-dashboard.ps1（内嵌→git→飞书）
  日志写入 deploy\daily-refresh.log
  依赖：lx_api.js（领星MCP HTTP封装，X-Mcp-Key认证，无需IP白名单）
#>
[CmdletBinding()]
param(
  [string]$Date = (Get-Date -Format 'yyyy-MM-dd')
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'
$DeployDir = 'f:\ai agent\deploy'
$LogFile  = Join-Path $DeployDir 'daily-refresh.log'
$DomesticData = 'f:\ai agent\operation_data.json'
$hadError = $false   # 任一步失败即置位，脚本最终 exit 1，让任务计划程序 LastTaskResult≠0（防失败被吞）
$AlertConfigFile = Join-Path $DeployDir 'alert-webhook.json'  # 飞书群自定义机器人配置（独立文件，不入库真实URL）
$Failures = New-Object System.Collections.ArrayList           # 失败步骤清单：@{Step;Detail}，供告警聚合

function Log {
  param([string]$msg, [string]$color = 'White')
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
  Write-Host $line -ForegroundColor $color
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# 记录一个失败步骤（同时置位 hadError），供最终失败告警聚合
function Record-Failure {
  param([string]$Step, [string]$Detail)
  [void]$Failures.Add([pscustomobject]@{ Step = $Step; Detail = $Detail })
  $script:hadError = $true
}

# 任一步骤失败后推送飞书群自定义机器人。
# 安全策略：配置文件缺失/URL为空→跳过；webhook自身请求失败→只记日志，不影响主流程退出码。
function Send-FailureAlert {
  param(
    [System.Collections.IList]$FailureList,
    [string]$RunDate
  )
  $webhookUrl = ''
  if (Test-Path $AlertConfigFile) {
    try {
      $cfg = Get-Content -Path $AlertConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.webhookUrl) { $webhookUrl = [string]$cfg.webhookUrl }
    } catch {
      Log "  [WARN] alert-webhook.json 解析失败，按未配置处理: $($_.Exception.Message)" 'Yellow'
    }
  }
  if ([string]::IsNullOrWhiteSpace($webhookUrl)) {
    Log "告警webhook未配置，跳过推送" 'Yellow'
    return
  }

  # 构造飞书自定义机器人 text 消息（含失败步骤、日期、关键错误摘要）
  $lines = @()
  $lines += '[告警] 看板每日刷新失败'
  $lines += "日期: $RunDate"
  $lines += "主机: $env:COMPUTERNAME"
  $lines += "失败步骤数: $($FailureList.Count)"
  $idx = 0
  foreach ($f in $FailureList) {
    $idx++
    $detail = [string]$f.Detail
    if ($detail.Length -gt 300) { $detail = $detail.Substring(0, 300) + '...' }
    $lines += ("{0}. {1} -- {2}" -f $idx, $f.Step, $detail)
  }
  $text = ($lines -join "`n")
  $payload = @{ msg_type = 'text'; text = @{ content = $text } } | ConvertTo-Json -Depth 5 -Compress

  try {
    # PS5.1 必须显式 UTF8 字节发 body，否则中文按 Latin1 编码导致乱码
    $resp = Invoke-RestMethod -Uri $webhookUrl -Method Post `
      -ContentType 'application/json; charset=utf-8' `
      -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 15
    $code = $resp.code
    if ($null -ne $code -and "$code" -ne '0') {
      Log "  [WARN] 飞书告警webhook返回非0: $($resp | ConvertTo-Json -Compress)" 'Yellow'
    } else {
      Log "失败告警已推送飞书群" 'Green'
    }
  } catch {
    # webhook 自身故障不得改变主流程退出码
    Log "  [WARN] 飞书告警webhook请求失败（不影响退出码）: $($_.Exception.Message)" 'Yellow'
  }
}

Log "========================================" 'Yellow'
Log "每日定时刷新启动 · $Date" 'Yellow'
Log "========================================" 'Yellow'

# ============ Step 1: 内盘（聚水潭API） ============
Log "[1/3] 内盘 deploy-domestic.js --rebuild" 'Cyan'
try {
  Push-Location $DeployDir
  $out = & node deploy-domestic.js --rebuild 2>&1
  $out | ForEach-Object { Log "  $_" 'DarkGray' }
  if ($LASTEXITCODE -eq 0) {
    Log "  [OK] 内盘部署完成" 'Green'
  } else {
    $tail = ($out | Select-Object -Last 5) -join ' / '
    Log "  [ERR] 内盘部署失败 (exit $LASTEXITCODE)" 'Red'
    Record-Failure -Step '[1/3] 内盘 deploy-domestic.js --rebuild' -Detail "exit=$LASTEXITCODE; $tail"
  }
  Pop-Location
} catch {
  Log "  [ERR] 内盘异常: $($_.Exception.Message)" 'Red'
  Record-Failure -Step '[1/3] 内盘 deploy-domestic.js --rebuild' -Detail "异常: $($_.Exception.Message)"
  if (Test-Path 'f:\ai agent\deploy') { Pop-Location 2>$null }
}

# ============ Step 2: 外盘拉数（领星MCP HTTP） ============
Log "[2/3] 外盘 build-crossborder.js（领星MCP拉数）" 'Cyan'
try {
  Push-Location $DeployDir
  $out = & node build-crossborder.js 2>&1
  $out | ForEach-Object { Log "  $_" 'DarkGray' }
  if ($LASTEXITCODE -eq 0) {
    Log "  [OK] 领星数据拉取完成" 'Green'
  } else {
    $tail2 = ($out | Select-Object -Last 5) -join ' / '
    Log "  [ERR] 领星拉取失败 (exit $LASTEXITCODE)" 'Red'
    Log "  外盘部署将跳过（数据未更新）" 'Yellow'
    Record-Failure -Step '[2/3] 外盘 build-crossborder.js（领星MCP拉数）' -Detail "exit=$LASTEXITCODE; $tail2"
    Pop-Location
    Log "========================================" 'Yellow'
    Log "每日定时刷新结束（外盘跳过，存在失败步骤）" 'Yellow'
    Log "========================================" 'Yellow'
    Send-FailureAlert -FailureList $Failures -RunDate $Date
    exit 1
  }
  Pop-Location
} catch {
  Log "  [ERR] 领星拉取异常: $($_.Exception.Message)" 'Red'
  Record-Failure -Step '[2/3] 外盘 build-crossborder.js（领星MCP拉数）' -Detail "异常: $($_.Exception.Message)"
  if (Test-Path 'f:\ai agent\deploy') { Pop-Location 2>$null }
  Log "========================================" 'Yellow'
  Log "每日定时刷新结束（外盘跳过，存在失败步骤）" 'Yellow'
  Log "========================================" 'Yellow'
  Send-FailureAlert -FailureList $Failures -RunDate $Date
  exit 1
}

# ============ Step 3: 外盘部署（内嵌+git+飞书） ============
Log "[3/3] 外盘 deploy-dashboard.ps1（内嵌+git+飞书）" 'Cyan'
if (-not (Test-Path $DomesticData)) {
  Log "  [SKIP] operation_data.json 不存在，外盘无法部署" 'Yellow'
} else {
  $modTime = (Get-Item $DomesticData).LastWriteTime
  $now = Get-Date
  # 检查是否刚刚被build-crossborder.js更新过（5分钟内）
  $isFresh = ($now - $modTime).TotalMinutes -lt 5
  if ($isFresh) {
    Log "  operation_data.json 刚刚更新 ($($modTime.ToString('HH:mm')))" 'Green'
    try {
      Push-Location $DeployDir
      # 必须捕获子脚本全部输出到日志（原先未重定向，Step4真实报错只进控制台、日志只剩 exit 1）
      $dout = & .\deploy-dashboard.ps1 -Date $Date 2>&1
      $dout | ForEach-Object { Log "  $_" 'DarkGray' }
      if ($LASTEXITCODE -eq 0) {
        Log "  [OK] 外盘部署完成" 'Green'
      } else {
        $tail3 = ($dout | Select-Object -Last 5) -join ' / '
        Log "  [ERR] 外盘部署失败 (exit $LASTEXITCODE)" 'Red'
        Record-Failure -Step '[3/3] 外盘 deploy-dashboard.ps1（内嵌+git+飞书）' -Detail "exit=$LASTEXITCODE; $tail3"
      }
      Pop-Location
    } catch {
      Log "  [ERR] 外盘异常: $($_.Exception.Message)" 'Red'
      Record-Failure -Step '[3/3] 外盘 deploy-dashboard.ps1（内嵌+git+飞书）' -Detail "异常: $($_.Exception.Message)"
      if (Test-Path 'f:\ai agent\deploy') { Pop-Location 2>$null }
    }
  } else {
    Log "  [SKIP] operation_data.json 未被本流程更新 (最后修改: $($modTime.ToString('yyyy-MM-dd HH:mm')))" 'Yellow'
    Log "  跳过外盘部署（避免用旧数据覆盖看板）" 'Yellow'
  }
}

if ($hadError) {
  Log "========================================" 'Red'
  Log "每日定时刷新结束（存在失败步骤，exit 1）" 'Red'
  Log "========================================" 'Red'
  Send-FailureAlert -FailureList $Failures -RunDate $Date
  exit 1
}
Log "========================================" 'Yellow'
Log "每日定时刷新结束（全部成功）" 'Yellow'
Log "========================================" 'Yellow'
exit 0
