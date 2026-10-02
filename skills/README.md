# 春山户外经营看板 SKILL 库

## 概述
本目录包含春山户外经营看板的核心技能文档，用于跨设备快速部署和理解系统。

## SKILL 列表

| SKILL | 用途 | 适用场景 |
|-------|------|----------|
| [data-caliber](./data-caliber/SKILL.md) | 数据口径与算法 | 理解双口径逻辑、修改计算公式 |
| [dashboard-frontend](./dashboard-frontend/SKILL.md) | 前端渲染逻辑 | 修改看板UI、新增卡片/图表 |
| [dashboard-refresh](./dashboard-refresh/SKILL.md) | 每日刷新部署 | 排查定时任务、手动部署 |

## 快速开始（新设备）

### 1. 克隆仓库
```bash
git clone git@github.com:springhill-hub/operation-dashboard.git
cd operation-dashboard
```

### 2. 安装依赖
```bash
# 需要 Node.js 16+
npm install node-fetch  # 如 Node < 18
```

### 3. 配置密钥
```bash
# 创建 deploy/secrets/rakuten.json
{
  "appKey": "your_rakuten_app_key",
  "appSecret": "your_rakuten_app_secret"
}
```

### 4. 设置定时任务（Windows）
```powershell
# 以管理员运行
.\skills\setup-scheduled-task.ps1
```

### 5. 手动刷新
```powershell
cd deploy
.\daily-refresh.ps1
```

## 关键决策记录

### 2026-10-02: 日亚切双口径
- **背景**: 王泉斐发现日亚销量/销售额与领星后台差15倍
- **根因**: 原用 get_profit_report_msku 结算口径，只含已结算订单
- **决策**: 销售额切下单口径(asinDailyLists)，毛利保留结算口径
- **新增**: 预估毛利卡（单品成本换算法）

### 2026-09-29: 销售口径拍板
- 王泉斐确认: **销售口径=下单时间**（项目记忆）

## 核心算法速查

```javascript
// 毛利率（自洽，禁止混口径）
margin = settled.gp / settled.net

// 预估毛利（单品换算）
estProfit = settled ? realProfit : net × unitMarginFromLastMonth
```

## 数据流图

```
领星REST(下单) ──┐
领星MCP(结算) ──┼──> build-crossborder.js ──> operation_data.json
乐天RMS ────────┤                                    │
Shopee ─────────┘                                    ▼
                                              经营看板.html
                                              (内嵌DATA-JSON)
                                                     │
                              ┌──────────────────────┼──────────────────────┐
                              ▼                      ▼                      ▼
                        GitHub Pages            飞书文档              本地直接打开
```

## 更新日志

- **2026-10-02**: 新增"上月汇总"tab、预估毛利卡、SKU成本换算
- **2026-10-01**: 动态日期化、补录9月数据
- **2026-09-29**: 初版上线
