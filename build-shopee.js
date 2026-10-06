/* ============================================================
 * 春山户外 · Shopee 利润聚合脚本（固化版 v1.1）
 * ------------------------------------------------------------
 * 用途：把领星 MCP 拉取的 Shopee 底层账单原始数据，按验证过的
 *       口径聚合为「双口径」数据，写回 operation_data.json。
 *
 * 双口径：
 *   1) ⚡ 结算回款 cashSettlement（真实现金，Income + Adjustment）
 *   2) ✓ 真实毛利   = 回款 + 商品成本(productCost，负值)
 *
 * 成本来源（优先级）：
 *   ① 领星利润报表 productCost（权威，滞后7-10天）— 存在则用它
 *   ② 静态 MSKU 成本表 msku-cost.json（build-msku-cost.js 生成）—
 *      报表未出时按 Σ 结算数量×单位成本 估算，真实毛利提速至结算当日
 *
 * 已验证勾稽（2026-09，TH/MY）：
 *   cashSettlement + productCost == 利润报表 profit（分毫不差）
 *
 * 数据流（每日刷新）：
 *   ① Agent 通过 run_mcp 拉取，原始响应存入 shopee-raw/（分页！）：
 *       - {SITE}_income_{offset}.txt : finance_shopee_income_list
 *            sites=['TH'|'MY'], length=200, offset=0,200,400...
 *            翻到 list 为空为止；totalSum 各页应完全一致
 *       - adjustment.json : finance_finance_shopee_adjustment, length=200（保存业务data）
 *   ② node build-shopee.js --period=month
 *
 * 陷阱：Income 自带 COGS 为「售价占位」非真实成本，禁止使用。
 *
 * 非交互 / 路径以脚本目录锚定 / 仅读写约定文件。
 * 运行：node build-shopee.js [--period=month] [--start=YYYY-MM-DD] [--end=YYYY-MM-DD]
 * ============================================================ */
const fs = require('fs');
const path = require('path');

// ---------- 参数解析（--key=value） ----------
const argv = {};
process.argv.slice(2).forEach(a => {
  const i = a.indexOf('=');
  if (i > 0) argv[a.slice(2, i)] = a.slice(i + 1);
});
const PERIOD  = argv.period || 'month';                 // today | week | month
const RAWDIR  = argv.rawDir ? path.resolve(argv.rawDir) : path.join(__dirname, 'shopee-raw');
const DATAP   = argv.dataPath ? path.resolve(argv.dataPath)
  : (process.env.CS_ROOT ? path.join(process.env.CS_ROOT, 'operation_data.json') : 'f:/ai agent/operation_data.json');
const COSTP   = path.join(__dirname, 'msku-cost.json');
const { normKey, loadJpyCostMap, toCcy } = require(path.join(__dirname, 'cost-lib.js'));
const today   = new Date();
const START   = argv.start || today.toISOString().slice(0, 8) + '01';
const END     = argv.end   || today.toISOString().slice(0, 10);

const SITES = [
  { site: 'TH', key: '泰国shopee', ccy: 'THB' },
  { site: 'MY', key: '马来shopee', ccy: 'MYR' }
];

const num = v => Number(v) || 0;
const r2  = v => Math.round(num(v) * 100) / 100;

// ---------- 读取原始数据（兼容 MCP包装文本 / 纯业务JSON） ----------
function loadRaw(file) {
  let s = fs.readFileSync(file, 'utf8').trim();
  const pfx = 'The MCP server responded with:';
  if (s.startsWith(pfx)) {
    s = s.slice(pfx.length).trim();
    const arr = JSON.parse(s);                 // [{type:'text', text:'...'}]
    return JSON.parse(arr[0].text).data.data; // {totalSum, list, totalCount}
  }
  const o = JSON.parse(s);
  return o.totalSum ? o : o.data.data;
}

// ---------- 读取站点全部分页，返回 {totalSum, list} ----------
function loadPages(site) {
  const files = fs.readdirSync(RAWDIR)
    .filter(f => f.startsWith(site + '_income_') && f.endsWith('.txt'))
    .sort((a, b) => parseInt(a.match(/_(\d+)\.txt$/)[1]) - parseInt(b.match(/_(\d+)\.txt$/)[1]));
  if (!files.length) return null;
  let ts = null;
  const list = [];
  for (const f of files) {
    const d = loadRaw(path.join(RAWDIR, f));
    if (!ts) ts = d.totalSum;
    else if (r2(num(d.totalSum.amount)) !== r2(num(ts.amount))) {
      console.warn('[warn] 各页 totalSum.amount 不一致：' + f);
    }
    list.push(...(d.list || []));
  }
  return { totalSum: ts, list };
}

// ---------- 回款勾稽公式（服务端 amount 的分解，用于校验原始数据） ----------
function calcAmount(ts) {
  // 卖家净运费 = 卖家支出 + 买家付运费(补偿+) + 平台运费返还(+)
  const netShipping = num(ts.actualShippingFee) + num(ts.buyerPaidShippingFee) + num(ts.shopeeShippingRebate);
  return num(ts.discountedItemPrice)
    + num(ts.actualCommissionFee)
    + num(ts.amsCommissionFee)
    + num(ts.sellerTransactionFee)
    + num(ts.actualServiceFee)
    + num(ts.adsEscrowTopUpFeeOrTechnicalSupportFee)
    + num(ts.voucherFromSeller)
    + netShipping
    + num(ts.refundAmount)
    + num(ts.totalVatTax)
    + num(ts.totalTariff)
    + num(ts.reverseShippingFee)
    + num(ts.shippingFeeSst)
    + num(ts.sellerOrderProcessingFee);
}

// ---------- 聚合每行（订单）的按 MSKU 结算数量：优先 children ----------
function mskuQtyOf(row) {
  const out = {};
  const add = (m, q) => { if (m) out[m] = (out[m] || 0) + num(q); };
  if (Array.isArray(row.children) && row.children.length) {
    for (const c of row.children) add(c.msku, c.quantity);
  } else {
    add(row.msku, row.quantity);
  }
  return out;
}

// ---------- 主流程 ----------
console.log('====================================================');
console.log(' Shopee profit builder | period=' + PERIOD + ' | ' + START + ' ~ ' + END);
console.log(' raw: ' + RAWDIR);
console.log('====================================================');

const DATA = JSON.parse(fs.readFileSync(DATAP, 'utf8'));
if (!DATA[PERIOD]) { console.error('period not found in data: ' + PERIOD); process.exit(1); }
if (!DATA[PERIOD].settlement) DATA[PERIOD].settlement = {};
const settlement = DATA[PERIOD].settlement;

const adj = loadRaw(path.join(RAWDIR, 'adjustment.json'));
const adjBySite = {};
for (const it of adj.list) adjBySite[it.site] = (adjBySite[it.site] || 0) + num(it.amount);

// 统一成本库：日亚 JPY 单位成本 → 店铺币种（同货同成本）；msku-cost.json 原币表作次级兜底
const DATA_FORCOST = JSON.parse(fs.readFileSync(DATAP, 'utf8'));
const jpyCost = loadJpyCostMap(DATA_FORCOST);
let costTable = null;
if (fs.existsSync(COSTP)) costTable = JSON.parse(fs.readFileSync(COSTP, 'utf8')).unitCost;
function staticUnit(ccy, m) {
  const j = jpyCost[normKey(m)];
  if (j != null) return toCcy(j, ccy, DATA_FORCOST);   // 本币负值
  if (costTable && costTable[ccy] && costTable[ccy][m] != null) return num(costTable[ccy][m]);
  return null;
}

const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
const summary = [];

for (const cfg of SITES) {
  const pages = loadPages(cfg.site);
  if (!pages) { console.warn('[skip] no raw pages: ' + cfg.site); continue; }
  const ts = pages.totalSum;

  const srvAmount = num(ts.amount);                 // Income 服务端回款（原币）
  const reconcile = r2(srvAmount - calcAmount(ts)); // 勾稽差异（应≈0）
  const adjSite   = r2(adjBySite[cfg.site] || 0);   // 该站调整
  const cash      = r2(srvAmount + adjSite);        // ⚡现金回款

  let cur = settlement[cfg.key];
  if (!cur) { cur = { currency: cfg.ccy }; settlement[cfg.key] = cur; }

  // —— 按 MSKU 聚合结算数量 ——
  const qtyByMsku = {};
  for (const row of pages.list) {
    for (const [m, q] of Object.entries(mskuQtyOf(row))) qtyByMsku[m] = (qtyByMsku[m] || 0) + q;
  }

  // —— 静态成本估算（统一日亚成本库折算，原币结算表兜底） ——
  let staticCost = null, knownQty = 0, unknownMskus = [];
  {
    let sum = 0, hasAny = false;
    for (const [m, q] of Object.entries(qtyByMsku)) {
      const u = staticUnit(cfg.ccy, m);
      if (u != null) { sum += q * u; knownQty += q; hasAny = true; }
      else unknownMskus.push({ msku: m, qty: q });
    }
    if (hasAny) staticCost = r2(sum);
  }
  const totalUnits = Object.values(qtyByMsku).reduce((s, q) => s + q, 0);
  const coverage = totalUnits ? r2(knownQty / totalUnits * 100) : null;

  // —— 成本来源决策：报表权威优先；缺失时用静态表 ——
  const hasReportCost = cur.productCost != null;
  let costSource = 'none';
  if (hasReportCost) costSource = 'report';
  else if (staticCost != null) {
    cur.productCost = staticCost;
    costSource = 'static';
  }

  // —— 写入双口径字段（不改动报表权威 net/profit/margin） ——
  cur.cashPlatformAmount = r2(srvAmount);
  cur.cashAdjustment     = adjSite;
  cur.cashSettlement     = cash;
  cur.cashOrders         = num(ts.totalCount);
  cur.cashUnits          = num(ts.quantity);
  cur.cashStatus         = 'settled';
  cur.cashRange          = START + ' ~ ' + END;
  cur.cashReconcileDiff  = reconcile;
  cur.cashGeneratedAt    = stamp;
  cur.staticProductCost  = staticCost;
  cur.staticCoveragePct  = coverage;
  cur.costSource         = costSource;
  cur.unknownMskus       = unknownMskus.sort((a, b) => b.qty - a.qty).slice(0, 10);

  // —— 真实毛利：报表成本下勾稽现有 profit；静态成本下直接计算 ——
  let gpFromCash = null, gpDiff = null, staticCostDiff = null;
  if (cur.productCost != null) {
    gpFromCash = r2(cash + num(cur.productCost));
    if (hasReportCost && cur.profit != null) gpDiff = r2(gpFromCash - num(cur.profit));
  }
  if (hasReportCost && staticCost != null) staticCostDiff = r2(staticCost - num(cur.productCost));

  cur.gpFromCash = gpFromCash;
  cur.gpDiff     = gpDiff;

  summary.push({ site: cfg.site, ccy: cur.currency, orders: cur.cashOrders, units: cur.cashUnits,
    amount: r2(srvAmount), adj: adjSite, cash, costSrc: costSource,
    cost: r2(cur.productCost), gp: cur.profit != null ? r2(cur.profit) : gpFromCash,
    rec: reconcile, gpDiff, static: staticCost, staticDiff: staticCostDiff, coverage,
    unknown: unknownMskus.length });
}

fs.writeFileSync(DATAP, JSON.stringify(DATA, null, 2), 'utf8');

console.log('\nsite | ccy | orders/units | income | adj | CASH | costSrc | cost | GP | rec | gpDiff');
for (const s of summary) {
  console.log([s.site, s.ccy, s.orders + '/' + s.units, s.amount, s.adj, s.cash,
    s.costSrc, s.cost, s.gp, s.rec, s.gpDiff].join(' | '));
  console.log('        static=' + s.static + ' (vs report ' + s.staticDiff + ') | coverage=' + s.coverage + '% | unknownMskus=' + s.unknown);
}
const recOk = summary.every(s => Math.abs(s.rec) <= 2);
const gpOk  = summary.every(s => s.gpDiff == null || Math.abs(s.gpDiff) <= 2);
console.log('\nreconcile amount formula: ' + (recOk ? 'PASS' : 'CHECK'));
console.log('cash+cost == report GP   : ' + (gpOk ? 'PASS' : 'CHECK'));
console.log('written: ' + DATAP);
