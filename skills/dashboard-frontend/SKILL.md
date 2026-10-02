# SKILL: 经营看板前端渲染逻辑

## 一、KPI 五卡结构（外盘）

| # | 卡片 | 数据源 | 口径 | 标注色 |
|---|------|--------|------|--------|
| 1 | 净销售额 | t.net | 下单口径·即时 | 默认 |
| 2 | 预估毛利 | t.orderProfit | 下单·单品成本换算 | 蓝(⚡) |
| 3 | 销量 | t.qty + t.orders | 下单口径 | 默认 |
| 4 | 毛利润 | t.settledProfit | 结算·滞后7-10天 | 金(⏳) |
| 5 | 毛利率 | t.margin | 结算·自洽 | 金(⏳) |

## 二、核心函数

### 2.1 amzRow(p, a, tagNote) — 亚马逊行构建
```javascript
// 输入: a = amazonJP/amazonUS 数据对象
// 输出: { name, currency, qty, orders, net, profit, margin, 
//         jpyNet, jpyProfit, jpySettledNet, jpySettledProfit, jpyEstOrderProfit }

// 关键字段:
jpyNet = a.net                    // 下单口径净销售额
jpyProfit = a.gp                  // 结算口径毛利
jpySettledNet = a.settled.net     // 结算净销售额(快照)
jpySettledProfit = a.settled.gp   // 结算毛利(快照)
jpyEstOrderProfit = estOrderProfitJP(a)  // 单品换算预估毛利
```

### 2.2 estOrderProfitJP(a) — 单品成本换算
```javascript
function estOrderProfitJP(a){
  if(a.caliber!=='order' || !a.skuDetail?.length) return a.gp;
  const shopMargin = a.settled?.net ? a.settled.gp/a.settled.net : 0;
  let sum = 0;
  for(const x of a.skuDetail){
    if(x.settled && x.profit!=null) sum += x.profit;           // 已结算：真实毛利
    else if(x.net!=null){
      const m = unitMarginOf(x.msku);                          // 未结算：上月单品毛利率
      sum += x.net * (m ?? shopMargin);                        // 缺历史→店铺整体毛利率
    }
  }
  return +sum.toFixed(2);
}
```

### 2.3 totals(rows) — 全渠道合计
```javascript
// 返回: { qty, net, profit, orders, settledNet, settledProfit, orderProfit, margin, orderMargin }

// 各字段来源:
t.net = Σ (r.currency==='JPY' ? r.net : r.jpyNet)              // 下单口径合计
t.settledNet = Σ r.jpySettledNet ?? r.net                      // 结算口径合计
t.settledProfit = Σ r.jpySettledProfit ?? r.profit             // 结算毛利合计
t.orderProfit = Σ r.jpyEstOrderProfit                          // 预估毛利合计
t.margin = settledProfit / settledNet                          // 自洽结算毛利率
t.orderMargin = orderProfit / net                              // 预估毛利率
```

### 2.4 stRows(settlement, knowMap) — 其他平台行
```javascript
// 乐天/Coupang: tag='est', note='下单口径·费率估算'
// Shopee有cashSettlement: tag='cash', note='⚡回款+✓真实毛利'
// 独立站: tag='warn', note='Shopify手续费未录入'
// jpyEstOrderProfit = toJpy(currency, profit)  // 直接取实际利润
```

## 三、页面结构

### 3.1 Tab 切换
```javascript
tabs = ['today', 'week', 'month', 'lastMonth']  // 4个周期
prevMap = { today:'yesterday', week:'lastWeek', month:'lastMonth', lastMonth:null }
// lastMonth无上期，环比显示"—"
```

### 3.2 渲染流程
```
render(period)
  ├─ kpiHTML(totals(rows), label, prevTotals, yoyTotals)  // 5张KPI卡
  ├─ platformTableHTML(rows)                              // 平台对比表
  ├─ waterfallHTML(d)                                     // 费用瀑布(结算口径自洽)
  ├─ pieHTML(rows)                                        // 平台占比
  ├─ barHTML(rows)                                        // 净销售额对比
  └─ skuDetailHTML(d)                                     // SKU明细(下单口径)
```

### 3.3 SKU明细表列（下单口径）
| 列 | 字段 | 说明 |
|----|------|------|
| 销量 | qty | 下单件数 |
| 订单量 | orders | 日亚下单单量 |
| 净销售额 | net | 下单口径 |
| 成本/费用/毛利 | cost/platformFee/profit | null→"待结算" |
| 毛利率 | margin | null→"待结算" |
| 占比 | pct | 该SKU净额/店铺净额 |

## 四、样式规范

```css
/* KPI卡标注色 */
--gold: #e5b567   /* 结算口径提示 */
--blue: #6ea8fe   /* 下单口径/预估 */
--green: #4ade80  /* 正收益/达标 */
--red: #f87171    /* 负收益/未达标 */

/* tagCls 对应 */
.ok   /* 正常 */
.warn /* 警告(独立站) */
.mut  /* 弱化(无销售) */
.est  /* 估算(乐天/Coupang) */
.cash /* 回款(Shopee) */
.bad  /* 错误(无数据) */
```

## 五、瀑布图口径（必须自洽）
```javascript
// ❌ 错误：用 a.net(下单) 减 a.cost(结算)
// ✅ 正确：用 a.settled.net 减 a.settled 的各项费用
const a = a0.settled ? {...a0, net:a0.settled.net, gp:a0.settled.gp} : a0;
steps = [净销售(结算), 成本, 扣点, FBA派送, FBA仓储, 广告, 其他, 毛利(结算)]
```
