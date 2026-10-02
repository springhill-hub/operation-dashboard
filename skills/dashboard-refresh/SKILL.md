# SKILL: 看板每日刷新部署

## 一、定时任务（Windows 计划任务）

**任务名**: `ChunShan-Daily-Refresh`  
**触发**: 每日 08:30  
**执行**: `powershell.exe -ExecutionPolicy Bypass -File "f:\ai agent\deploy\daily-refresh.ps1"`

### 手动重建
```powershell
# 以管理员运行 PowerShell
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-ExecutionPolicy Bypass -File "f:\ai agent\deploy\daily-refresh.ps1"'
$trigger = New-ScheduledTaskTrigger -Daily -At "08:30"
Register-ScheduledTask -TaskName "ChunShan-Daily-Refresh" `
  -Action $action -Trigger $trigger -RunLevel Highest
```

## 二、刷新流水线

```
daily-refresh.ps1
  ├─ [1/3] 内盘: node deploy-domestic.js --rebuild
  │         └─ 聚水潭API → domestic_data.json → embed → git → 飞书
  │
  ├─ [2/3] 外盘拉数: node build-crossborder.js
  │         ├─ 领星REST: asinDailyLists(下单口径)
  │         ├─ 领星MCP: get_profit_report_msku(结算口径)
  │         ├─ 乐天RMS API
  │         └─ 写入 operation_data.json
  │
  └─ [3/3] 外盘部署: .\deploy-dashboard.ps1
            ├─ 校验JSON
            ├─ 内嵌到 经营看板.html → widget.html + index.html
            ├─ git push GitHub Pages
            └─ 飞书 html5-block 更新
```

## 三、部署命令速查

### 3.1 完整刷新（日常）
```powershell
cd f:\ai agent\deploy
.\daily-refresh.ps1                    # 自动取当天日期
.\daily-refresh.ps1 -Date 2026-10-02   # 指定日期
```

### 3.2 仅外盘
```powershell
cd f:\ai agent\deploy
node build-crossborder.js              # 拉数据
.\deploy-dashboard.ps1                 # 部署
```

### 3.3 仅内盘
```powershell
cd f:\ai agent\deploy
node build-domestic.js --days=60       # 拉60天数据
node embed-domestic.js                 # 内嵌
node deploy-domestic.js                # 部署
```

### 3.4 仅语法/渲染校验（不部署）
```powershell
node check-js-syntax.js "f:\ai agent\经营看板.html"
node verify-render-dom.js "f:\ai agent\经营看板.html" "f:\ai agent\国内经营看板.html"
```

## 四、环境依赖

### 4.1 API密钥位置
| 服务 | 位置 | 字段 |
|------|------|------|
| 领星REST | build-crossborder.js L69-70 | LX_APP_ID, LX_APP_SECRET |
| 领星MCP | lx_api.js | X-Mcp-Key |
| 乐天RMS | deploy/secrets/rakuten.json | (gitignore) |
| 聚水潭 | build-domestic.js | (内置) |

### 4.2 代理
乐天RMS需走系统代理 `127.0.0.1:7892`（CONNECT隧道+TLS）

### 4.3 Node.js
- 需要 Node 16+
- 依赖: `node-fetch` 或 Node 18+ 原生 fetch

## 五、故障排查

### 5.1 领星IP白名单失效
**症状**: build-crossborder.js 报 "IP白名单" 错误  
**解决**: 登录领星后台 → 设置 → API → 更新白名单IP

### 5.2 飞书html5-block更新失败
**症状**: deploy-dashboard.ps1 [STEP 4] 报错  
**解决**: 飞书文档 block id 会变，脚本会自动 fetch 新 id；若仍失败，手动更新：
```powershell
# 获取文档结构
lark-cli docs +fetch --doc HLvidGwVroPZRxxjngdclO2SnQb --detail with-ids --as user
# 替换block
lark-cli docs +update --command block_replace --block-id <id> --content "<html5-block path='@./widget.html'/>" --reference-map "@./reference-map.json" --as user
```

### 5.3 GitHub Pages 未更新
**症状**: 推送成功但网页未变  
**检查**: Pages 构建延迟约75秒，稍等刷新；或检查 `generatedAt` 字段是否更新

### 5.4 数据为0或null
**检查**: 
1. operation_data.json 的 meta.generatedAt 是否为今天
2. 领星MCP是否报"参数有误"（sid错误）
3. 乐天代理是否启动

## 六、访问地址

| 看板 | 地址 |
|------|------|
| 外盘(GitHub) | https://springhill-hub.github.io/operation-dashboard/ |
| 内盘(GitHub) | https://springhill-hub.github.io/operation-dashboard/domestic.html |
| 外盘(飞书) | https://scnnkf4b8hxl.feishu.cn/docx/HLvidGwVroPZRxxjngdclO2SnQb |
| 内盘(飞书) | https://scnnkf4b8hxl.feishu.cn/docx/AtYWd4f2aoX8rZx40GHcDmiqnG0 |

## 七、文件清单

```
f:\ai agent\
├─ operation_data.json          # 外盘数据（每天08:30更新）
├─ domestic_data.json           # 内盘数据
├─ 经营看板.html                 # 外盘源文件（含DATA-JSON内嵌块）
├─ 国内经营看板.html             # 内盘源文件
├─ deploy\
│  ├─ daily-refresh.ps1         # 定时任务入口
│  ├─ deploy-dashboard.ps1      # 外盘部署（内嵌+git+飞书）
│  ├─ deploy-domestic.js        # 内盘部署
│  ├─ build-crossborder.js      # 外盘数据拉取
│  ├─ build-domestic.js         # 内盘数据拉取
│  ├─ embed-domestic.js         # 内盘数据内嵌
│  ├─ lx_api.js                 # 领星MCP HTTP封装
│  ├─ check-js-syntax.js        # 语法校验
│  ├─ verify-render-dom.js      # 渲染断言
│  ├─ msku-cost.json            # SKU成本表（领星导出）
│  └─ daily-refresh.log         # 运行日志
└─ skills\                      # 本SKILL目录
   ├─ data-caliber\SKILL.md
   ├─ dashboard-frontend\SKILL.md
   └─ dashboard-refresh\SKILL.md
```
