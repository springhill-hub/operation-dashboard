# 周度经营策划系统部署说明

## 系统结构

| 文件 | 用途 |
|------|------|
| `weekly-data-prep.ps1` | 每周一 03:00 定时任务，拉取上周数据生成 weekly-data.json + weekly-prompt.txt |
| `weekly.html` | 周度策划页面，展示数据 + AI方案生成区 |
| `weekly-data.json` | 上周各渠道数据、TOP SKU、库存预警 |
| `weekly-prompt.txt` | 格式化数据提示文本，可复制给 AI 生成策划方案 |

## 定时任务设置（Windows）

```powershell
# 以管理员运行 PowerShell
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-ExecutionPolicy Bypass -File "f:\ai agent\deploy\weekly-data-prep.ps1"'
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "03:00"
Register-ScheduledTask -TaskName "ChunShan-Weekly-Prep" `
  -Action $action -Trigger $trigger -RunLevel Highest
```

## 使用流程

1. **周一 03:00**：定时任务自动跑 `weekly-data-prep.ps1`
   - 拉取上周（周一~周日）数据
   - 生成 `weekly-data.json`（结构化数据）
   - 生成 `weekly-prompt.txt`（AI 提示文本）

2. **周一白天**：打开 https://springhill-hub.github.io/operation-dashboard/weekly.html
   - 查看"上周数据总览"（各渠道环比）
   - 查看"TOP 利润 SKU"（前10）
   - 查看"库存预警"
   - 点击"复制数据提示文本" → 粘贴给 AI（Trae/ChatGPT/Claude）
   - AI 生成策划方案 → 粘贴回页面保存

3. **周一会议**：基于 AI 方案讨论决策

## AI 策划方案框架（AI 输出格式）

```markdown
## 一、高利润产品聚焦
- TOP SKU 共性分析（品类/价格带/平台）
- 主推资源分配建议

## 二、增量机会
- 环比下滑渠道原因分析
- 2-3 个可落地增量活动（促销/内容/新品）

## 三、库存协同
- 预警 SKU 补货/清仓节奏

## 四、平台差异化策略
- 日亚：精细化运营建议
- 乐天：促销活动建议
- Coupang：物流/定价建议
- Shopee：价格敏感策略
- 内盘：内容电商建议

## 五、本周必干（5项）
- [ ] 动作1（负责渠道，预期效果）
- [ ] 动作2 ...
```

## 数据口径

- 环比：本周 vs 上周
- 净销售额：下单口径（即时）或结算口径（滞后7-10天），各渠道标注
- 毛利：结算口径（已含平台扣点/FBA/广告等）
- TOP SKU：按毛利排序，取前10

## 注意事项

- `weekly-data-prep.ps1` 依赖 `operation_data.json` 和 `domestic_data.json`，需确保每日刷新正常
- 库存预警目前从 `inventory-data.json` 提取，如该文件不存在则预警为空
- AI 生成的方案保存到 localStorage，换设备需重新粘贴
