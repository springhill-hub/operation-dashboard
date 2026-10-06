/* ============================================================
 * 春山户外 · 日本乐天（楽天市場）RMS 订单聚合脚本（固化版 v1.0）
 * ------------------------------------------------------------
 * 用途：通过 RMS WEB API（ESA 鉴权）拉取楽天ペイ受注订单，
 *       聚合为看板「双口径」数据，写入 DATA[period].settlement['日本-乐天']。
 *
 * 双口径：
 *   1) 下单成交口径（按 orderDatetime，T+0）：salesAmount/tax/net
 *   2) ⚡ 回款代理口径（按 orderFixDatetime 注文確定）：cashSettlement
 *      月度真精算書（每月约20日出）无 API，后续 CSV 导入覆盖校准。
 *
 * 费用：
 *   commission = net × 10.5%（システム利用料等，估算，待精算書校准）
 *   其余乐天费用（ポイント原資負担・R-Card・固定费等）首版未含。
 *
 * 成本：复用现有口径 = Σ 数量 × 单位成本（JPY），
 *   单位成本取自 operation_data 日亚 skuDetail 的 cost/qty；
 *   键匹配 merchantDefinedSkuId / manageNumber / itemNumber
 *   （归一化：大写 + 去 -FBA/-FBM/-JP/-NEW 等后缀）。
 *
 * 两段式取数：searchOrder（分页）→ getOrder（每批≤100）。
 * 原始数据落 rakuten-raw/（.gitignore），不入库。
 *
 * 非交互 / 路径以脚本目录锚定 / 仅读写约定文件。
 * 运行：node build-rakuten.js [--start=YYYY-MM-DD] [--end=YYYY-MM-DD]
 *                [--pullOnly] [--periods=today,week,month]
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const https = require('https');
// 云服务器（阿里云）不支持 IPv6，乐天 RMS 若解析到 v6 会 ENETUNREACH，强制 IPv4 优先
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) {}
const http = require('http');
const tls = require('tls');

// ---------- 参数解析（--key=value） ----------
const argv = {};
process.argv.slice(2).forEach(a => {
  if (!a.startsWith('--')) return;
  const body = a.slice(2);
  const i = body.indexOf('=');
  if (i < 0) argv[body] = true;
  else argv[body.slice(0, i)] = body.slice(i + 1);
});
// 动态日期（与 build-crossborder.js 周期口径对齐：today=T-1, week=[T-7,T-1], month=[月初,T-1]）
const _now = new Date();
const _pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
const ANCHOR = argv.anchor ? new Date(argv.anchor + 'T12:00:00') : _now; // 历史补录锚点（以该日为"今天"算周期）
const T1 = new Date(ANCHOR); T1.setDate(T1.getDate() - 1);              // T-1
const MS = new Date(ANCHOR.getFullYear(), ANCHOR.getMonth(), 1);          // 本月月初
const WS = new Date(ANCHOR); WS.setDate(WS.getDate() - 7);              // T-7
const RANGE_START = (WS < MS ? WS : MS);                              // 拉数下限：月初与T-7取更早
const START   = argv.start || iso(RANGE_START);
const END     = argv.end   || iso(T1);
// 周期重定向（补录历史用，如 --map=month:lastMonth,week:lastWeek,today:yesterday）
const MAP = {};
(argv.map || '').split(',').forEach(x => { const [a, b] = x.split(':'); if (a && b) MAP[a] = b; });
// 显式周期覆盖 --ranges=month:2026-09-01:2026-09-30,week:...:...,today:...:...（补录历史用，优先级最高）
const RANGES = {};
(argv.ranges || '').split(',').forEach(x => { const [p, s, e] = x.split(':'); if (p && s && e) RANGES[p] = [s, e]; });
const PULLONLY = !!argv.pullOnly;
const PERIODS = (argv.periods || 'today,week,month').split(',');

const SECRETP = path.join(__dirname, 'secrets', 'rakuten.json');
const RAWDIR  = path.join(__dirname, 'rakuten-raw');
const DATAP   = argv.dataPath ? path.resolve(argv.dataPath)
  : path.join(process.env.CS_ROOT || 'f:/ai agent', 'operation_data.json');
const HOST    = 'api.rms.rakuten.co.jp';
// 服务器无本地代理时不走代理直连；有 HTTPS_PROXY 环境变量才用
const PROXY   = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || (process.platform === 'win32' ? 'http://127.0.0.1:7892' : '');
// 国内服务器 DNS 污染时，用已知 IPv4 直连（配合 servername=HOST 保持 SNI/证书正确）
const HOST_IP = process.env.RAKUTEN_HOST_IP || '';
const COMMISSION_RATE = 0.105;

const num = v => Number(v) || 0;
const r2  = v => Math.round(num(v) * 100) / 100;

// ---------- RMS 传输层（代理 CONNECT 隧道 + TLS） ----------
const cred = JSON.parse(fs.readFileSync(SECRETP, 'utf8'));
const proxyUrl = PROXY ? new URL(PROXY) : null;

function tunnel() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyUrl.hostname, port: proxyUrl.port,
      method: 'CONNECT', path: HOST + ':443',
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { reject(new Error('CONNECT ' + res.statusCode)); return; }
      const tlsSock = tls.connect({ socket, servername: HOST }, () => resolve(tlsSock));
      tlsSock.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('proxy timeout')));
    req.end();
  });
}

function post(apiPath, payload) {
  return new Promise(async (resolve, reject) => {
    let socket;
    if (proxyUrl) {
      try { socket = await tunnel(); } catch (e) { reject(e); return; }
    }
    const body = JSON.stringify(payload);
    const req = https.request({
      ...(socket ? { createConnection: () => socket } : {}),
      hostname: HOST_IP || HOST, servername: HOST, path: apiPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'ESA ' + Buffer.from(cred.serviceSecret + ':' + cred.licenseKey).toString('base64'),
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', x => d += x);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------- 拉取：searchOrder 分页 + getOrder 批次 ----------
async function pullOrders(start, end) {
  const allNums = [];
  let page = 1, totalPages = 1;
  do {
    const r = await post('/es/2.0/order/searchOrder/', {
      dateType: 1,
      orderProgressList: [100, 200, 300, 400, 500, 600, 700, 800, 900],
      startDatetime: start + 'T00:00:00+0900',
      endDatetime: end + 'T23:59:59+0900',
      PaginationRequestModel: { requestPage: page, requestRecordsAmount: 1000 },
    });
    if (r.status !== 200) throw new Error('searchOrder p' + page + ' HTTP' + r.status + ' ' + r.body.slice(0, 300));
    const o = JSON.parse(r.body);
    allNums.push(...(o.orderNumberList || []));
    totalPages = num(o.PaginationResponseModel.totalPages);
    console.log('searchOrder p' + page + '/' + totalPages + ' got=' + (o.orderNumberList || []).length +
      ' total=' + o.PaginationResponseModel.totalRecordsAmount);
  } while (page++ < totalPages);

  const orders = [];
  for (let i = 0; i < allNums.length; i += 100) {
    const batch = allNums.slice(i, i + 100);
    const r = await post('/es/2.0/order/getOrder/', { orderNumberList: batch, version: '7' });
    if (r.status !== 200) throw new Error('getOrder HTTP' + r.status + ' ' + r.body.slice(0, 300));
    const o = JSON.parse(r.body);
    if (o.MessageModelList) {
      const errs = o.MessageModelList.filter(m => m.messageType === 'ERROR');
      if (errs.length) throw new Error('getOrder business error: ' + JSON.stringify(errs).slice(0, 300));
    }
    orders.push(...(o.OrderModelList || []));
    console.log('getOrder batch ' + (i / 100 + 1) + ' got=' + (o.OrderModelList || []).length);
  }
  return { orderNumbers: allNums, orders };
}

// ---------- 日亚 JPY 单位成本表 ----------
function jpyCostTable(D) {
  const map = {};
  // lastMonth 优先：全结算完整月成本最全；month/today 下单口径改造后含 cost=null/0 的行需跳过
  for (const p of ['lastMonth', 'month', 'week', 'today']) {
    const a = D[p] && D[p].amazonJP;
    if (!a || !Array.isArray(a.skuDetail)) continue;
    for (const r of a.skuDetail) {
      if (!r.msku || !r.qty || !r.cost) continue;   // 跳过 cost 为 null/0（无成本信息）
      const u = num(r.cost) / num(r.qty);
      if (map[r.msku] == null) map[r.msku] = u;
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

// ---------- 单订单：行明细（用于聚合） ----------
function orderLines(o) {
  const lines = [];
  for (const pkg of o.PackageModelList || []) {
    for (const it of pkg.ItemModelList || []) {
      const skus = (it.SkuModelList || []).map(s => s.merchantDefinedSkuId || s.variantId);
      lines.push({
        keys: [...new Set([...skus, it.manageNumber, it.itemNumber].filter(Boolean))],
        qty: num(it.units),
      });
    }
  }
  return lines;
}

// ---------- 主流程 ----------
(async () => {
  console.log('====================================================');
  console.log(' Rakuten RMS builder | ' + START + ' ~ ' + END + (PULLONLY ? ' | pullOnly' : ''));
  console.log('====================================================');

  if (!fs.existsSync(RAWDIR)) fs.mkdirSync(RAWDIR, { recursive: true });
  const searchP = path.join(RAWDIR, 'search_' + START + '_' + END + '.json');
  const ordersP = path.join(RAWDIR, 'orders_' + START + '_' + END + '.json');

  let data;
  if (fs.existsSync(ordersP) && !argv.refresh) {
    console.log('use cached raw: ' + ordersP + ' (加 --refresh 强制重拉)');
    data = { orders: JSON.parse(fs.readFileSync(ordersP, 'utf8')) };
  } else {
    data = await pullOrders(START, END);
    fs.writeFileSync(searchP, JSON.stringify(data.orderNumbers, null, 1), 'utf8');
    fs.writeFileSync(ordersP, JSON.stringify(data.orders, null, 1), 'utf8');
    console.log('raw saved: ' + ordersP);
  }
  const orders = data.orders;

  // —— SKU 盘点 ——
  const skuSet = new Set();
  for (const o of orders) for (const l of orderLines(o)) l.keys.forEach(k => skuSet.add(k));
  console.log('distinct order item keys: ' + skuSet.size);

  if (PULLONLY) return;

  const D = JSON.parse(fs.readFileSync(DATAP, 'utf8'));
  const rawCostMap = jpyCostTable(D);
  // 归一化成本键（冲突时保留首个）；日亚 JPY 成本优先
  const costMap = {};
  for (const [k, v] of Object.entries(rawCostMap)) {
    const nk = normKey(k);
    if (costMap[nk] == null) costMap[nk] = v;
  }
  // —— 跨市场折算成本（Shopee THB/MYR → JPY），同一物理产品 ——
  // 已验证(2026-09)：MYR LDL-CQ4P-E 折算¥18,216 ≈ 日亚¥18,176
  const R = num(D.meta.jpyRate);
  const fx = D.meta.fx || {};
  const shopeeCost = JSON.parse(fs.readFileSync(path.join(__dirname, 'msku-cost.json'), 'utf8')).unitCost || {};
  const toJpyCost = (ccy, v) => {
    const cnyPer = ccy === 'THB' ? num(fx.thbCny) : num(fx.myrCny);
    if (!cnyPer || !R) return null;
    return -Math.abs(num(v)) * cnyPer / R;
  };
  let crossAdded = 0;
  for (const ccy of ['THB', 'MYR']) {
    for (const [k, v] of Object.entries(shopeeCost[ccy] || {})) {
      const nk = normKey(k);
      if (costMap[nk] == null) {
        const jv = toJpyCost(ccy, v);
        if (jv != null) { costMap[nk] = r2(jv); crossAdded++; }
      }
    }
  }
  // —— 显式别名（编码差异，人工维护） ——
  const ALIAS = {
    'BEL-CFZ-IGTB': 'BEL-CFZ-E-IGTB',   // 日亚马甲 BEL-CFZ-E+IGTB
    'LDL-CQ4P-E2.0': 'LDL-CQ4P-E',
  };
  for (const [from, to] of Object.entries(ALIAS)) {
    if (costMap[normKey(from)] == null && costMap[normKey(to)] != null) {
      costMap[normKey(from)] = costMap[normKey(to)];
    }
  }
  console.log('JPY unit-cost keys: ' + Object.keys(rawCostMap).length +
    ' native + ' + crossAdded + ' cross-market converted');

  // —— 聚合桶 ——
  const bucketOf = {};
  for (const p of PERIODS) {
    if (!D[p]) { console.warn('[skip] period missing: ' + p); continue; }
    const [s, e] = RANGES[p] || (p === 'month' ? [iso(MS), iso(T1)]
      : p === 'week' ? [iso(WS), iso(T1)]
      : [iso(T1), iso(T1)]);
    bucketOf[p] = { s, e, agg: newAgg() };
  }
  const inRange = (d, s, e) => d && d.slice(0, 10) >= s && d.slice(0, 10) <= e;

  for (const o of orders) {
    const cancelled = o.orderProgress === 900;
    const lines = orderLines(o);
    const tax = (o.TaxSummaryModelList || []).reduce((x, t) => x + num(t.reqPriceTax), 0);
    for (const p of Object.keys(bucketOf)) {
      const b = bucketOf[p], a = b.agg;
      if (!inRange(o.orderDatetime, b.s, b.e)) continue;
      a.orderCount++;
      if (cancelled) { a.cancelOrders++; a.cancelAmount += num(o.requestPrice); continue; }
      if (o.orderProgress === 800) a.cancelPending++;
      a.qty += lines.reduce((x, l) => x + l.qty, 0);
      a.salesAmount += num(o.requestPrice);
      a.tax += tax;
      for (const l of lines) {
        const hit = l.keys.map(normKey).find(k => costMap[k] != null);
        if (hit) a.productCost += l.qty * costMap[hit];
        else { a.unknownKeys[l.keys[0]] = (a.unknownKeys[l.keys[0]] || 0) + l.qty; a.unknownQty += l.qty; }
      }
    }
    // ⚡ 回款代理：按注文確定日
    for (const p of Object.keys(bucketOf)) {
      const b = bucketOf[p], a = b.agg;
      if (!cancelled && inRange(o.orderFixDatetime, b.s, b.e)) {
        a.cashOrders++;
        a.cashNet += num(o.requestPrice) - tax;
      }
    }
  }

  // —— 写回 DATA ——
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const summary = [];
  for (const p of Object.keys(bucketOf)) {
    const dst = MAP[p] || p;
    if (!D[dst].settlement) D[dst].settlement = {};
    const a = bucketOf[p].agg;
    const net = a.salesAmount - a.tax;
    const commission = -r2(net * COMMISSION_RATE);
    const productCost = r2(a.productCost);
    const platformFeeTotal = commission;
    const profit = r2(net + productCost + commission);
    const margin = net ? r2(profit / net * 100) : 0;
    const unknownKeys = Object.entries(a.unknownKeys).sort((x, y) => y[1] - x[1]).slice(0, 10)
      .map(([k, q]) => ({ key: k, qty: q }));
    const totalQty = a.qty;
    const knownQty = totalQty - a.unknownQty;
    const coverage = totalQty ? r2(knownQty / totalQty * 100) : null;

    D[dst].settlement['日本-乐天'] = {
      currency: 'JPY',
      qty: a.qty,
      orderCount: a.orderCount,
      cancelOrders: a.cancelOrders,
      cancelPending: a.cancelPending,
      cancelAmount: r2(a.cancelAmount),
      salesAmount: r2(a.salesAmount),
      tax: r2(a.tax),
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
      platformFeeTotal,
      profit,
      margin,
      feeEstimated: true,
      feeNote: '佣金按10.5%估算，待月度精算書CSV校准；ポイント原資/R-Card/固定费未含',
      costCoveragePct: coverage,
      unknownKeys,
      cashSettlement: r2(a.cashNet),
      cashOrders: a.cashOrders,
      cashStatus: 'proxy-注文確定口径，非真精算',
      cashGeneratedAt: stamp,
    };
    summary.push({ period: p, orders: a.orderCount, qty: a.qty, sales: r2(a.salesAmount),
      net: r2(net), cost: productCost, commission, profit, margin,
      cancel: a.cancelOrders, cash: r2(a.cashNet), coverage });
  }

  fs.writeFileSync(DATAP, JSON.stringify(D, null, 2), 'utf8');

  console.log('\nperiod | orders/qty | sales | net | cost | commission | GP | margin | cancel | cashProxy | coverage');
  for (const s of summary) {
    console.log([s.period, s.orders + '/' + s.qty, s.sales, s.net, s.cost, s.commission,
      s.profit, s.margin + '%', s.cancel, s.cash, (s.coverage == null ? '-' : s.coverage + '%')].join(' | '));
  }
  console.log('\nwritten: ' + DATAP);
})().catch(e => { console.error('FATAL', e); process.exit(1); });

function newAgg() {
  return { orderCount: 0, qty: 0, salesAmount: 0, tax: 0, productCost: 0,
    cancelOrders: 0, cancelPending: 0, cancelAmount: 0,
    cashOrders: 0, cashNet: 0, unknownKeys: {}, unknownQty: 0 };
}
