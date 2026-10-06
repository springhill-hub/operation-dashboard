<#
.SYNOPSIS
  春山户外经营看板 · 每日刷新部署脚本
.DESCRIPTION
  一键4步流程：
    1) 读取 operation_data.json（由财务Agent预先拉数写入）
    2) 内嵌JSON到经营看板.html的 DATA-JSON script块，生成 widget.html（含meta）和 index.html（GitHub Pages版，去meta）
    3) git add/commit/push 到 springhill-hub/operation-dashboard
    4) lark-cli 更新飞书文档 html5-block
  参数化日期；每步日志；任一步失败即停止。
.PARAMETER Date
  部署日期 YYYY-MM-DD，默认今天。仅用于commit message和日志，不修改JSON内容。
.PARAMETER SkipGit
  跳过git push步骤（调试用）。
.PARAMETER SkipLark
  跳过飞书文档更新步骤（调试用）。
.EXAMPLE
  .\deploy-dashboard.ps1
  .\deploy-dashboard.ps1 -Date 2026-09-30
  .\deploy-dashboard.ps1 -SkipLark
#>
[CmdletBinding()]
param(
  [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),
  [switch]$SkipGit,
  [switch]$SkipLark
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# ============ 路径常量 ============
$DeployDir   = 'f:\ai agent\deploy'
$SourceHtml  = 'f:\ai agent\经营看板.html'
$DataJson    = 'f:\ai agent\operation_data.json'
$WidgetHtml  = Join-Path $DeployDir 'widget.html'
$IndexHtml   = Join-Path $DeployDir 'index.html'
$LarkCli     = 'C:\Users\DCKJ\.trae-cn\plugins\trae-remote-official\lark\1.0.5\bin\lark-cli.exe'

# 飞书文档配置
$LarkDocId   = 'HLvidGwVroPZRxxjngdclO2SnQb'
$LarkBlockId = 'doxcntOPmD9rMKf3gumVz239yqe'

# 访问URL
$PagesUrl    = 'https://springhill-hub.github.io/operation-dashboard/'
$LarkDocUrl  = 'https://scnnkf4b8hxl.feishu.cn/docx/HLvidGwVroPZRxxjngdclO2SnQb'

# ============ 工具函数 ============
function Write-Step  { param([string]$msg) Write-Host "`n[STEP] $msg" -ForegroundColor Cyan }
function Write-OK    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Info  { param([string]$msg) Write-Host "  [..] $msg" -ForegroundColor DarkGray }
function Write-Err   { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

function Stop-OnError {
  param([string]$Step, [string]$Detail)
  Write-Err "$Step 失败：$Detail"
  Write-Host "`n========== 部署中止（$Step）==========" -ForegroundColor Red
  exit 1
}

# ============ 主流程 ============
$startTime = Get-Date
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  春山户外经营看板 · 每日刷新部署" -ForegroundColor Yellow
Write-Host "  日期：$Date" -ForegroundColor Yellow
Write-Host "  启动：$($startTime.ToString('yyyy-MM-dd HH:mm:ss'))" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow

# ---------- Step 1: 校验数据文件 ----------
Write-Step "1/4 校验数据源 operation_data.json"
if (-not (Test-Path $DataJson)) {
  Stop-OnError 'Step1-数据校验' "文件不存在：$DataJson（请先由财务Agent拉数写入）"
}
try {
  $rawJson = Get-Content $DataJson -Raw -Encoding UTF8
  $null = $rawJson | ConvertFrom-Json
} catch {
  Stop-OnError 'Step1-数据校验' "JSON解析失败：$($_.Exception.Message)"
}
$genAt = ($rawJson | ConvertFrom-Json).meta.generatedAt
Write-OK "JSON有效，generatedAt=$genAt"
Write-Info "数据文件：$DataJson"

# ---------- Step 2: 内嵌JSON到HTML，生成 widget.html + index.html ----------
Write-Step "2/4 内嵌JSON到HTML（生成 widget.html + index.html）"
if (-not (Test-Path $SourceHtml)) {
  Stop-OnError 'Step2-HTML模板' "源文件不存在：$SourceHtml"
}

$htmlTemplate = Get-Content $SourceHtml -Raw -Encoding UTF8

# 压缩JSON为单行（与原文件格式一致）
$compactJson = ($rawJson | ConvertFrom-Json | ConvertTo-Json -Depth 100 -Compress)

# 替换 DATA-JSON script 块内容（用字符串定位，避免正则 replacement 中 $ 被转义）
$startTag = '<script id="DATA-JSON" type="application/json">'
$endTag = '</script>'
$startIdx = $htmlTemplate.IndexOf($startTag)
if ($startIdx -lt 0) {
  Stop-OnError 'Step2-HTML替换' '未找到 DATA-JSON script 开始标签'
}
$endIdx = $htmlTemplate.IndexOf($endTag, $startIdx)
if ($endIdx -lt 0) {
  Stop-OnError 'Step2-HTML替换' '未找到 DATA-JSON script 结束标签'
}
$contentStart = $startIdx + $startTag.Length
$newHtml = $htmlTemplate.Substring(0, $contentStart) + "`n" + $compactJson + "`n" + $htmlTemplate.Substring($endIdx)
Write-Info "DATA-JSON 替换完成（位置 $startIdx ~ $endIdx）"

# 同步更新硬编码的 tab 日期（从 DATA-JSON 提取）
$dataObj = $rawJson | ConvertFrom-Json
$todayDate = $dataObj.today.date                                    # 2026-09-29
$weekRange = $dataObj.week.range                                    # 2026-09-23 ~ 2026-09-29
$monthRange = $dataObj.month.range                                  # 2026-09-01 ~ 2026-09-29
# 转为短格式 MM-DD ~ MM-DD
$weekShort = $weekRange -replace '^\d{4}-(\d{2}-\d{2}) ~ \d{4}-(\d{2}-\d{2})$', '$1 ~ $2'
$monthShort = $monthRange -replace '^\d{4}-(\d{2}-\d{2}) ~ \d{4}-(\d{2}-\d{2})$', '$1 ~ $2'

$newHtml = $newHtml -replace '(<div class="d" id="tabD-today">)[^<]*(</div>)', "`${1}$todayDate`${2}"
$newHtml = $newHtml -replace '(<div class="d" id="tabD-week">)[^<]*(</div>)', "`${1}$weekShort`${2}"
$newHtml = $newHtml -replace '(<div class="d" id="tabD-month">)[^<]*(</div>)', "`${1}$monthShort`${2}"
Write-Info "tab日期已同步: today=$todayDate week=$weekShort month=$monthShort"

# 用 .NET 直接写 UTF-8 无 BOM（避免 Set-Content 在 PS 5.1 加 BOM 导致 lark-cli 解析问题）
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  
  # 回写源文件 经营看板.html（保证本地打开源文件也是最新数据）
  [System.IO.File]::WriteAllText($SourceHtml, $newHtml, $utf8NoBom)
  Write-OK "经营看板.html 源文件已同步更新"
  
  # 写 widget.html（保留meta标签，飞书文档用）
  [System.IO.File]::WriteAllText($WidgetHtml, $newHtml, $utf8NoBom)
  Write-OK "widget.html 已生成（含meta标签）"

# 写 index.html（GitHub Pages版，去掉3个meta标签）—— 注意 PS 变量不区分大小写，用独立变量名
$indexContent = $newHtml -replace '(?m)^<meta name="use-iframe" content="true">\r?\n', ''
$indexContent = $indexContent -replace '(?m)^<meta name="html-box-height-mode" content="auto">\r?\n', ''
$indexContent = $indexContent -replace '(?m)^<meta name="description" content="[^"]*">\r?\n', ''
[System.IO.File]::WriteAllText($IndexHtml, $indexContent, $utf8NoBom)
Write-OK "index.html 已生成（GitHub Pages版，去meta）"

# ---------- Step 3: git push ----------
if ($SkipGit) {
  Write-Step "3/4 [跳过] git push（-SkipGit）"
} else {
  Write-Step "3/4 git 提交并推送 GitHub Pages"
  # native command（git）写到 stderr 的 warning 不会被 $ErrorActionPreference=Stop 视作错误
  # 临时切换策略，避免 git 的 warning 被误判为 fatal
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    Push-Location $DeployDir
    Write-Info "git add index.html widget.html + 固化脚本/成本表"
    $null = & git add index.html widget.html dashboard.html portal.html build-shopee.js build-msku-cost.js build-rakuten.js build-coupang.js msku-cost.json .gitignore 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git add 失败 (exit $LASTEXITCODE)" }

    # 检查已暂存的变更（仅staged，避免untracked文件触发误commit）
    $staged = & git diff --cached --name-only 2>&1
    if (-not $staged) {
      Write-OK "数据无变化，跳过 commit/push"
    } else {
      $commitMsg = "每日刷新 $Date"
      Write-Info "git commit -m `"$commitMsg`""
      $null = & git commit -m $commitMsg 2>&1
      if ($LASTEXITCODE -ne 0) { throw "git commit 失败 (exit $LASTEXITCODE)" }

      Write-Info "git push origin main（走 ssh.github.com:443）"
      $null = & git push origin main 2>&1
      if ($LASTEXITCODE -ne 0) { throw "git push 失败 (exit $LASTEXITCODE，请检查SSH连接）" }
      Write-OK "推送完成"
    }
  } catch {
    Pop-Location
    $ErrorActionPreference = $prevEAP
    Stop-OnError 'Step3-git' $_.Exception.Message
  }
  $ErrorActionPreference = $prevEAP
  Pop-Location
}

# ---------- Step 4: 飞书文档更新 ----------
if ($SkipLark) {
  Write-Step "4/4 [跳过] 飞书文档更新（-SkipLark）"
} else {
  Write-Step "4/4 更新飞书文档 html5-block"
  if (-not (Test-Path $LarkCli)) {
    Stop-OnError 'Step4-lark-cli' "lark-cli 不存在：$LarkCli"
  }
  # 4.0 凭据预检：定时任务（Task Scheduler）不继承 TRAE 注入的 LARKSUITE_CLI_* 环境变量，
  #     缺凭据时 lark-cli 返回 config/not_configured（2026-10-03~10-06 Step4 连续失败根因）
  if (-not $env:LARKSUITE_CLI_USER_ACCESS_TOKEN) {
    Write-Info "环境变量 LARKSUITE_CLI_USER_ACCESS_TOKEN 缺失（Windows定时任务的正常现象），将尝试 lark-cli 本地持久化凭据"
  }
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    Push-Location $DeployDir

    # 解析 lark-cli JSON 输出中的错误；凭据缺失时给出可执行的修复指引，而不是误报"未找到block"
    function Get-LarkCliError {
      param([string[]]$Lines)
      $txt = ($Lines -join "`n")
      if ($txt -notmatch '"ok"\s*:\s*false') { return $null }
      $sub = [regex]::Match($txt, '"subtype"\s*:\s*"([^"]+)"').Groups[1].Value
      $msg = [regex]::Match($txt, '"message"\s*:\s*"([^"]+)"').Groups[1].Value
      if ($sub -eq 'not_configured') {
        return "飞书凭据未配置（config/not_configured）。当前进程无 TRAE 注入的 LARKSUITE_CLI_USER_ACCESS_TOKEN，且本机未做 lark-cli 持久化授权。修复二选一：① 在普通 PowerShell（不依赖TRAE）执行 `"$LarkCli`" config init --new 并浏览器完成授权，凭据落盘后定时任务即可自动刷新；② 每日在 TRAE 内手动触发部署。"
      }
      return "lark-cli 返回错误($sub)：$msg"
    }

    # 4.1 + 4.2 整体最多尝试3轮（网络抖动/限流可重试；not_configured 不重试）
    $maxAttempts = 3
    $done = $false
    for ($attempt = 1; $attempt -le $maxAttempts -and -not $done; $attempt++) {
      try {
        if ($attempt -gt 1) { Write-Info "第 $attempt 次重试（等待15s）"; Start-Sleep -Seconds 15 }
        # 4.1 动态获取当前 html5-block id（block_replace 每次生成新 id，硬编码会失效）
        Write-Info "fetch 文档定位当前 html5-block id"
        $fetchOut = & $LarkCli docs +fetch --doc $LarkDocId --detail with-ids --as user 2>&1
        $cliErr = Get-LarkCliError $fetchOut
        if ($cliErr) { throw $cliErr }
        # fetch 输出为转义JSON，id 引号可能形如 id=\"...\"，正则兼容转义/非转义
        $mm = [regex]::Match(($fetchOut -join ' '), '<html5-block[^>]*id=\\?"([A-Za-z0-9]+)\\?"')
        if (-not $mm.Success) { throw "fetch 成功但未在文档中匹配到 html5-block（文档结构可能被改动），请人工检查飞书文档" }
        $curBlockId = $mm.Groups[1].Value
        Write-Info "当前 html5-block id=$curBlockId"
        # 4.2 已有 data-ref 的块必须带 --reference-map，content 用 path 引用新 widget
        $content = "<html5-block path='@./widget.html'/>"
        $output = & $LarkCli docs +update --doc $LarkDocId --command block_replace --block-id $curBlockId --content $content --reference-map "@./reference-map.json" --as user 2>&1
        $cliErr = Get-LarkCliError $output
        if ($LASTEXITCODE -ne 0 -or $cliErr) {
          throw ("lark-cli block_replace 失败 (exit $LASTEXITCODE)：" + $(if ($cliErr) { $cliErr } else { ($output -join ' ') }))
        }
        Write-OK "飞书文档 html5-block 已更新"
        $done = $true
      } catch {
        if ($_.Exception.Message -match 'not_configured') { throw }   # 凭据问题重试无意义
        if ($attempt -eq $maxAttempts) { throw "Step4 重试 $maxAttempts 次仍失败：$($_.Exception.Message)" }
        Write-Info "本轮失败：$($_.Exception.Message)"
      }
    }

    # 4.3 回验：重新 fetch 下载 block 资源，确认内嵌数据日期确为本次部署日期（防止"假成功"）
    Write-Info "回验 block 内数据日期..."
    $verifyOut = & $LarkCli docs +fetch --doc $LarkDocId --detail with-ids --as user 2>&1
    $vErr = Get-LarkCliError $verifyOut
    if ($vErr) { throw "回验fetch失败：$vErr" }
    $vTxt = $verifyOut -join "`n"
    $resRel = [regex]::Match($vTxt, '"path"\s*:\s*"(@doc-fetch-resources/[^"]+)"').Groups[1].Value
    if (-not $resRel) { throw "回验失败：reference_map 中未找到 html5 资源路径" }
    $resPath = Join-Path $DeployDir ($resRel -replace '^@', '')
    if (-not (Test-Path $resPath)) { throw "回验失败：资源文件未落盘 $resPath" }
    $resHtml = Get-Content $resPath -Raw -Encoding UTF8
    $vDate = [regex]::Match($resHtml, '"today"\s*:\s*\{[^}]*?"date"\s*:\s*"([^"]+)"').Groups[1].Value
    if ($vDate -ne $todayDate) {
      throw "回验失败：block 内 today=$vDate，期望 $todayDate（block_replace 可能未生效或CDN缓存，需人工排查）"
    }
    Write-OK "回验通过：飞书 block 内 today=$vDate（与 operation_data.json 一致）"
  } catch {
    Pop-Location
    $ErrorActionPreference = $prevEAP
    Stop-OnError 'Step4-lark' $_.Exception.Message
  }
  $ErrorActionPreference = $prevEAP
  Pop-Location
}

# ============ 完成 ============
$elapsed = (Get-Date) - $startTime
Write-Host "`n========================================" -ForegroundColor Yellow
Write-Host "  部署完成 ｜ 耗时 $([Math]::Round($elapsed.TotalSeconds,1))s" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "`n访问地址：" -ForegroundColor White
Write-Host "  GitHub Pages：$PagesUrl" -ForegroundColor Cyan
Write-Host "  飞书文档：  $LarkDocUrl" -ForegroundColor Cyan
Write-Host ""
