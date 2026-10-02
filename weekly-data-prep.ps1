# 周度经营策划数据准备脚本
# 每周一 03:00 触发，拉取上周数据生成 weekly-data.json
param([string]$WeekStart = "")  # 默认上周一

$ErrorActionPreference = "Stop"
$deployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $deployDir

# 计算上周一~上周日
if (-not $WeekStart) {
    $today = Get-Date
    $daysSinceMonday = ($today.DayOfWeek.value__ + 6) % 7  # 周一=0
    $lastMonday = $today.AddDays(-$daysSinceMonday - 7)
    $WeekStart = $lastMonday.ToString("yyyy-MM-dd")
}
$weekEnd = ([datetime]$WeekStart).AddDays(6).ToString("yyyy-MM-dd")
Write-Host "拉取周数据: $WeekStart ~ $weekEnd"

# 1. 外盘数据（从 operation_data.json 提取 lastWeek + 对比）
$opData = Get-Content "f:\ai agent\operation_data.json" -Raw | ConvertFrom-Json
$lastWeek = $opData.lastWeek
$week = $opData.week

# 2. 内盘数据
$domData = Get-Content "f:\ai agent\domestic_data.json" -Raw | ConvertFrom-Json
$domLastWeek = $domData.lastWeek
$domWeek = $domData.week

# 3. 汇总周度数据
$weekly = @{
    weekStart = $WeekStart
    weekEnd = $weekEnd
    generatedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    crossborder = @{
        lastWeek = $lastWeek
        week = $week
        channels = @{}
    }
    domestic = @{
        lastWeek = $domLastWeek
        week = $domWeek
        channels = @{}
    }
    topSkus = @()
    alerts = @()
}

# 外盘渠道汇总
foreach ($ch in $lastWeek.settlement.PSObject.Properties) {
    $name = $ch.Name
    $lw = $ch.Value
    $w = $week.settlement.$name
    $weekly.crossborder.channels[$name] = @{
        lastWeek = @{ net = $lw.net; profit = $lw.profit; margin = $lw.margin; qty = $lw.qty }
        week = @{ net = $w.net; profit = $w.profit; margin = $w.margin; qty = $w.qty }
        wowNet = if ($lw.net -and $w.net) { [math]::Round(($w.net - $lw.net) / $lw.net * 100, 1) } else { $null }
        wowProfit = if ($lw.profit -and $w.profit) { [math]::Round(($w.profit - $lw.profit) / $lw.profit * 100, 1) } else { $null }
    }
}

# 日亚单独
if ($lastWeek.amazonJP) {
    $jpLw = $lastWeek.amazonJP
    $jpW = $week.amazonJP
    $weekly.crossborder.channels["日本-亚马逊"] = @{
        lastWeek = @{ net = $jpLw.net; profit = $jpLw.gp; margin = $jpLw.margin; qty = $jpLw.qty; orders = $jpLw.orders }
        week = @{ net = $jpW.net; profit = $jpW.gp; margin = $jpW.margin; qty = $jpW.qty; orders = $jpW.orders }
        wowNet = if ($jpLw.net -and $jpW.net) { [math]::Round(($jpW.net - $jpLw.net) / $jpLw.net * 100, 1) } else { $null }
        wowProfit = if ($jpLw.gp -and $jpW.gp) { [math]::Round(($jpW.gp - $jpLw.gp) / $jpLw.gp * 100, 1) } else { $null }
    }
}

# 内盘渠道汇总
if ($domLastWeek.channels) {
    foreach ($ch in $domLastWeek.channels.PSObject.Properties) {
        $name = $ch.Name
        $lw = $ch.Value
        $w = $domWeek.channels.$name
        $weekly.domestic.channels[$name] = @{
            lastWeek = @{ net = $lw.net; profit = $lw.profit; margin = $lw.margin; orders = $lw.orders }
            week = @{ net = $w.net; profit = $w.profit; margin = $w.margin; orders = $w.orders }
            wowNet = if ($lw.net -and $w.net) { [math]::Round(($w.net - $lw.net) / $lw.net * 100, 1) } else { $null }
            wowProfit = if ($lw.profit -and $w.profit) { [math]::Round(($w.profit - $lw.profit) / $lw.profit * 100, 1) } else { $null }
        }
    }
}

# 提取 TOP SKU（按利润排序，取前10）
$allSkus = @()
if ($week.amazonJP.skuDetail) {
    foreach ($s in $week.amazonJP.skuDetail) {
        if ($s.profit -and $s.profit -gt 0) {
            $allSkus += @{ msku = $s.msku; name = $s.name; platform = "日亚"; qty = $s.qty; net = $s.net; profit = $s.profit; margin = $s.margin }
        }
    }
}
if ($week.settlement.'日本-乐天'.skuDetail) {
    foreach ($s in $week.settlement.'日本-乐天'.skuDetail) {
        if ($s.profit -and $s.profit -gt 0) {
            $allSkus += @{ msku = $s.msku; name = $s.name; platform = "乐天"; qty = $s.qty; net = $s.net; profit = $s.profit; margin = $s.margin }
        }
    }
}
$weekly.topSkus = $allSkus | Sort-Object -Property profit -Descending | Select-Object -First 10

# 库存预警（从 inventory 数据）
if (Test-Path "f:\ai agent\deploy\inventory-data.json") {
    $inv = Get-Content "f:\ai agent\deploy\inventory-data.json" -Raw | ConvertFrom-Json
    # 提取缺货/低库存 SKU
    if ($inv.alerts) { $weekly.alerts = $inv.alerts }
}

# 保存
$weekly | ConvertTo-Json -Depth 10 | Set-Content "f:\ai agent\deploy\weekly-data.json" -Encoding UTF8
Write-Host "✅ weekly-data.json 已生成: $($weekly.topSkus.Count) 个TOP SKU, $($weekly.alerts.Count) 条预警"

# 4. 生成策划提示文本（供复制给AI）
$prompt = @"
【春山户外 · 周度经营策划请求】
周区间: $WeekStart ~ $weekEnd

## 数据摘要
### 外盘（环比上周）
"@
foreach ($ch in $weekly.crossborder.channels.GetEnumerator()) {
    $c = $ch.Value
    $prompt += "`n- $($ch.Key): 净销售额 $($c.week.net) (环比 $($c.wowNet)%), 毛利 $($c.week.profit) (环比 $($c.wowProfit)%), 毛利率 $($c.week.margin)%"
}
$prompt += "`n`n### 内盘（环比上周）"
foreach ($ch in $weekly.domestic.channels.GetEnumerator()) {
    $c = $ch.Value
    $prompt += "`n- $($ch.Key): 净销售额 $($c.week.net) (环比 $($c.wowNet)%), 毛利 $($c.week.profit) (环比 $($c.wowProfit)%), 毛利率 $($c.week.margin)%"
}
$prompt += "`n`n### TOP 10 利润 SKU"
foreach ($s in $weekly.topSkus) {
    $prompt += "`n- [$($s.platform)] $($s.name): 销量 $($s.qty), 净销售额 $($s.net), 毛利 $($s.profit), 毛利率 $($s.margin)%"
}
$prompt += "`n`n### 库存预警"
foreach ($a in $weekly.alerts) {
    $prompt += "`n- $($a.message)"
}
$prompt += @"

## 任务
请基于以上数据，生成本周（$WeekStart 起）经营策划方案：
1. 【高利润产品聚焦】分析 TOP SKU 的共性（品类/价格带/平台），建议主推资源分配
2. 【增量机会】识别环比下滑渠道的原因，提出 2-3 个可落地的增量活动（促销/内容/新品）
3. 【库存协同】结合预警 SKU，建议补货或清仓节奏
4. 【平台策略】针对各平台特性（日亚精细化/乐天促销/ Coupang 物流/Shopee 价格敏感/内盘内容电商），给出差异化建议
5. 【本周必干】列出 5 项可执行动作，标注负责渠道和预期效果

输出格式：Markdown，可直接粘贴到 weekly.html 的策划方案区。
"@

$prompt | Set-Content "f:\ai agent\deploy\weekly-prompt.txt" -Encoding UTF8
Write-Host "✅ weekly-prompt.txt 已生成（可复制给AI生成详细方案）"
