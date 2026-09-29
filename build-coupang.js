/* ============================================================
 * 春山户外 · 韩国 Coupang 销售额聚合脚本（固化版 v1.0）
 * ------------------------------------------------------------
 * 数据源：领星 platform_v2_page_list（店铺 sid=110719712118729216）
 *   - resultType=3 销售额（KRW，按日/按SKU）
 *   - resultType=1 销量（件，按日/按SKU）
 *   原始数据由 Agent 拉取后落 coupang-raw/（.gitignore）。
 *
 * 口径限制（领星对 Coupang 的覆盖边界）：
 *   - 下单口径：含未付款；领星无订单数(orderTotal=0)，取消率无法核实；
 *   - 利润/结算报表不支持 Coupang（platformCode 10020 不在支持列表）；
 *   - 本脚本佣金按 10.8% 估算（판매수수료，运动户外类目常见档），
 *     真实回款待 Coupang OPEN API 或后台结算单校准。
 *
 * 成本：单位成本取自 ①日亚skuDetail JPY成本 ②Shopee THB/MYR
 *   按外管局中间价折 JPY（与 build-rakuten 同一成本表），
 *   再按 JPY→KRW 折算；键归一化 + 别名；不匹配列入 unknownKeys。
 *
 * 非交互 / 路径以脚本目录锚定。
 * 运行：node build-coupang.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const RAWDIR = path.join(__dirname, 'coupang-raw');
const DATAP  = 'f:/ai agent/operation_data.json';
const COMMISSION_RATE = 0.108;

const num = v => Number(v) || 0;
const r2  = v => Math.round(num(v) * 100) / 100;

// ---------- 读取领星原始数据（取目录下最新一对） ----------
function latestRaw(prefix) {
  const f = fs.readdirSync(RAWDIR).filter(x => x.startsWith(prefix) && x.endsWith('.json'))
    .sort().slice(-1)[0];
  if (!f) throw new Error('missing raw: ' + prefix);
  console.log('raw: ' + f);
  return JSON.parse(fs.readFileSync(path.join(RAWDIR, f), 'utf8'));
}
const salesRaw = latestRaw('sales_');
const volRaw   = latestRaw('volume_');

// ---------- 成本表（JPY 单位成本，与 build-rakuten 同构） ----------
const D = JSON.parse(fs.readFileSync(DATAP, 'utf8'));
const R = num(D.meta.jpyRate);
const fx = D.meta.fx || {};
const krwCny = num(fx.krwCny);

function jpyCostTable() {
  const map = {};
  for (const p of ['month', 'week', 'today']) {
    const a = D[p] && D[p].amazonJP;
    if (!a || !Array.isArray(a.skuDetail)) continue;
    for (const r of a.skuDetail) {
      if (!r.msku || !r.qty) continue;
      if (map[r.msku] == null) map[r.msku] = num(r.cost) / num(r.qty);
    }
  }
  return map;
}
const norm = s => String(s || '').toUpperCase();
const STRIP = ['-FBA1', '-FBA', '-FBM', '-NEW', '-ATZ', '-DP', '-JP'];
function normKey(s) {
  let k = norm(s).replace(/\+/g, '-');
  let prev;
  do {
    prev = k;
    for (const suf of STRIP) if (k.endsWith(suf)) k = k.slice(0, -suf.length);
  } while (k !== prev);
  return k;
}
const costMap = {};
for (const [k, v] of Object.entries(jpyCostTable())) {
  const nk = normKey(k);
  if (costMap[nk] == null) costMap[nk] = v;
}
const shopeeCost = JSON.parse(fs.readFileSync(path.join(__dirname, 'msku-cost.json'), 'utf8')).unitCost || {};
let crossAdded = 0;
for (const ccy of ['THB', 'MYR']) {
  const cnyPer = ccy === 'THB' ? num(fx.thbCny) : num(fx.myrCny);
  for (const [k, v] of Object.entries(shopeeCost[ccy] || {})) {
    const nk = normKey(k);
    if (costMap[nk] == null && cnyPer && R) {
      costMap[nk] = -Math.abs(num(v)) * cnyPer / R;
      crossAdded++;
    }
  }
}
const ALIAS = {
  'BEL-CFZ-IGTB': 'BEL-CFZ-E-IGTB',
  'LDL-CQ4P-E2.0': 'LDL-CQ4P-E',
};
for (const [from, to] of Object.entries(ALIAS)) {
  if (costMap[normKey(from)] == null && costMap[normKey(to)] != null)
    costMap[normKey(from)] = costMap[normKey(to)];
}
console.log('JPY cost keys: ' + Object.keys(jpyCostTable()).length +
  ' native + ' + crossAdded + ' cross-market; JPY/KRW rate=' + (R / krwCny).toFixed(4));

// ---------- 合并 SKU 行（sales × volume） ----------
// 以内部编码 sku[0] 为主键；数字 platformProductId 兜底
const byCode = new Map();
function bucket(code, pid, name) {
  const key = code || pid;
  if (!byCode.has(key)) byCode.set(key, { code: code || '', pid: pid || '', name: name || '', daily: {} });
  return byCode.get(key);
}
for (const r of salesRaw.statisticsList) {
  const b = bucket(r.sku[0], r.platformProductId[0], r.productName[0]);
  for (const [d, v] of Object.entries(r.dateCollect || {})) b.daily[d] = b.daily[d] || {};
  for (const [d, v] of Object.entries(r.dateCollect || {})) b.daily[d].sales = num(v);
}
for (const r of volRaw.statisticsList) {
  const b = bucket(r.sku[0], r.platformProductId[0], r.productName[0]);
  for (const [d, v] of Object.entries(r.dateCollect || {})) b.daily[d] = b.daily[d] || {};
  for (const [d, v] of Object.entries(r.dateCollect || {})) b.daily[d].units = num(v);
}
const products = [...byCode.values()];
console.log('merged products: ' + products.length);

// ---------- 三周期聚合 ----------
const PERIODS = {
  month: ['2026-09-01', '2026-09-28'],
  week: ['2026-09-22', '2026-09-28'],
  today: ['2026-09-28', '2026-09-28'],
};
const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
const summary = [];

for (const [p, [s, e]] of Object.entries(PERIODS)) {
  if (!D[p]) { console.warn('[skip] ' + p); continue; }
  let qty = 0, salesAmount = 0, productCost = 0;
  const unknownKeys = {}, unknownQty = { v: 0 };
  for (const prod of products) {
    const nk = normKey(prod.code);
    const unitCostJpy = costMap[nk];
    const unitCostKrw = unitCostJpy != null ? unitCostJpy * (R / krwCny) : null;
    for (const [d, dv] of Object.entries(prod.daily)) {
      if (d < s || d > e) continue;
      const u = num(dv.units);
      salesAmount += num(dv.sales);
      qty += u;
      if (u > 0) {
        if (unitCostKrw != null) productCost += u * unitCostKrw;
        else { unknownKeys[prod.code || prod.pid] = (unknownKeys[prod.code || prod.pid] || 0) + u; unknownQty.v += u; }
      }
    }
  }

  const net = salesAmount;
  const commission = -r2(net * COMMISSION_RATE);
  productCost = r2(productCost);
  const profit = r2(net + productCost + commission);
  const margin = net ? r2(profit / net * 100) : 0;
  const uk = Object.entries(unknownKeys).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([key, q]) => ({ key, qty: q }));
  const knownQty = qty - unknownQty.v;
  const coverage = qty ? r2(knownQty / qty * 100) : null;

  if (!D[p].settlement) D[p].settlement = {};
  D[p].settlement['韩国-Coupang'] = {
    currency: 'KRW',
    qty,
    refundVol: 0,
    salesAmount: r2(salesAmount),
    promoDisc: 0,
    net: r2(net),
    productCost,
    commission,
    delivery: 0,
    otherPlatformFee: 0,
    serviceFee: 0,
    storage: 0,
    otherLogistics: 0,
    ads: 0,
    affiliate: 0,
    otherPromo: 0,
    incomeRefund: 0,
    platformFeeTotal: commission,
    profit,
    margin: margin + '%',
    feeEstimated: true,
    feeNote: '佣金按10.8%估算(판매수수료运动户外档)；下单口径含未付款、订单数缺失；KRW为含税标价未剥VAT；待Coupang OPEN API/结算单校准',
    costCoveragePct: coverage,
    unknownKeys: uk,
    generatedAt: stamp,
  };
  summary.push({ period: p, qty, sales: r2(salesAmount), cost: productCost, commission, profit, margin, coverage });
}

fs.writeFileSync(DATAP, JSON.stringify(D, null, 2), 'utf8');
console.log('\nperiod | qty | sales | cost | commission | GP | margin | coverage');
for (const x of summary) {
  console.log([x.period, x.qty, x.sales, x.cost, x.commission, x.profit,
    x.margin + '%', x.coverage == null ? '-' : x.coverage + '%'].join(' | '));
}
console.log('\nwritten: ' + DATAP);
