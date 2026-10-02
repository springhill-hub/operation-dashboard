# SKILL: 春山户外数据口径与算法

## 一、数据口径矩阵（铁律，不可混用）

| 平台 | 销售额口径 | 毛利口径 | 滞后 | 数据源 |
|------|-----------|---------|------|--------|
| 日本亚马逊 | 下单口径（即时，剔除取消） | 结算口径（滞后7-10天） | 是 | 领星REST asinDailyLists(type=1/2/3) + get_profit_report_msku |
| 美国亚马逊 | 结算口径 | 结算口径 | 是 | 领星 |
| 日本乐天 | 下单口径（T+0） | 费率估算（佣金4.5%） | 否 | Rakuten RMS API |
| 韩国Coupang | 下单口径（含未付款） | 费率估算（佣金10.8%） | 否 | 领星下单口径 |
| Shopee泰/马 | 结算口径 | 结算口径 | 是（月账单） | 领星 finance_settlement_profit_list |
| 独立站-日本 | 下单口径 | 下单口径 | 否 | Shopify快照 |
| 独立站-国际 | 下单口径 | 下单口径 | 否 | Shopify快照 |
| 内盘（聚水潭） | 支付口径 | 成本口径 | 否 | 聚水潭 pay_date |

## 二、核心公式

### 2.1 净销售额
```
净销售额 = 含税销售额 − 消费税(10%)
JPY折算CNY: CNY = JPY × jpyRate
```

### 2.2 毛利润（结算口径）
```
毛利润 = 平台收入 + 平台费用 + 商品成本
平台费用 = 扣点 + FBA派送 + FBA仓储 + 广告 + 其他
```

### 2.3 毛利率（自洽公式，**禁止混口径相除**）
```
毛利率 = 结算毛利 ÷ 结算净销售额
       = settled.gp ÷ settled.net

# ❌ 错误（会产生2.92%这种离谱值）：
毛利率 = settled.gp ÷ order.net  # 结算毛利 ÷ 下单净销售额
```

### 2.4 下单口径预估毛利（**单品成本换算法**）
```
对于日亚 SKU i：
  if 已结算(settled=true):   estProfit_i = profit_i  (真实毛利)
  if 未结算(settled=false):  estProfit_i = net_i × unitMargin_i
  
  其中 unitMargin_i = 该SKU上月结算毛利率 = profit_lastMonth / net_lastMonth
  若该SKU上月无数据(新品):  unitMargin_i = 店铺上月结算毛利率

对于乐天/Coupang/Shopee/独立站：
  estProfit = 实际毛利（本身即结算/下单口径利润，无需换算）

全店预估毛利 = Σ 各SKU estProfit × 汇率折算
```

## 三、领星API签名算法

```javascript
// AES-128-ECB 签名
const crypto = require('crypto');
function lxSign(params, appKey) {
  const str = Object.keys(params).sort()
    .map(k => `${k}=${params[k]}`).join('&') + `&app_key=${appKey}`;
  const md5 = crypto.createHash('md5').update(str).digest('hex').toUpperCase();
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(APP_SECRET, 'utf8'), null);
  cipher.setAutoPadding(true);
  return cipher.update(md5, 'utf8', 'base64') + cipher.final('base64');
}

// 请求头
headers = {
  'X-Mcp-Key': MCP_KEY,           // lx_api.js 用
  // 或 REST: access_token + app_key + timestamp + sign
}
```

## 四、数据文件结构

### 4.1 operation_data.json 顶层
```json
{
  "meta": { "generatedAt": "2026-10-02", "fx": { "jpyRate": 0.0427, ... } },
  "today":     { "date": "2026-10-01", "amazonJP": {...}, "amazonUS": {...}, "settlement": {...} },
  "yesterday": {...},
  "week":      { "range": "...", ... },
  "lastWeek":  {...},
  "month":     {...},
  "lastMonth": {...},  // 上月完整自然月
  "lastYearSep": {...} // 同比基期
}
```

### 4.2 amazonJP 结构（双口径）
```json
{
  "caliber": "order",           // 顶层为下单口径
  "qty": 44, "orders": 44, "net": 853985, "salesAmt": 853985, "tax": 0,
  "gp": 24910.92, "margin": 43.12,  // 结算口径
  "cost": ..., "commission": ..., "fbaDeliv": ..., "storage": ..., "ads": ...,
  "settled": {                   // 结算口径快照
    "qty": 8, "net": 57768, "gp": 24910.92, "margin": 43.12
  },
  "skuDetail": [
    {
      "msku": "BH-QNQ-ZWJ", "name": "...", "qty": 3, "orders": 3,
      "net": 389997, "cost": null, "platformFee": null,
      "profit": null, "margin": null,   // null = 待结算
      "settled": false, "img": "...", "pct": 45.7
    }
  ]
}
```

## 五、汇率中间价（每日更新）

| 币种 | 字段 | 来源 |
|------|------|------|
| JPY→CNY | meta.fx.jpyRate | 国家外汇管理局当日中间价 |
| THB→CNY | meta.fx.thbCny | 同上 |
| MYR→CNY | meta.fx.myrCny | 同上 |
| KRW→CNY | meta.fx.krwCny | 同上 |
| USD→CNY | meta.fx.usdCny | 同上 |

## 六、特殊口径说明

- **Shopee取消率极高**：泰国约70%、马来约68%，复盘必须用真实成交口径（结算口径），不能用下单口径
- **独立站Shopify手续费未录入**：利润率虚高3-5pp，需人工月度校准
- **乐天佣金按4.5%估算**：月度精算书CSV出来后需手工校准
- **Coupang佣金按10.8%估算**：待Coupang OPEN API/结算单校准
- **头程运费未计入**：中国→海外仓运费需额外扣除
