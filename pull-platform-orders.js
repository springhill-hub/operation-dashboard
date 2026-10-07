/* ============================================================
 * 春山户外 · 多平台下单口径拉数（固化版 v1.0 · 2026-10-06）
 * ------------------------------------------------------------
 * 与日亚同款：领星 MCP platform_v2_page_list（X-Mcp-Key，无需IP白名单）
 *   resultType 1=销量(件) 2=订单量(单) 3=销售额(本币)
 *
 * 覆盖店铺（store_id 来自 get_multi_platform_shop_list）：
 *   泰国shopee / 马来shopee / 独立站-日本 / 独立站-国际
 *
 * 写入 DATA[period].settlement[key] 下单口径字段（与回款口径并存）：
 *   qty/orderCount/salesAmount/net（=下单成交金额）+ generatedAt/caliber
 *   Shopee 回款字段(cashSettlement等，build-shopee.js 维护)保持不动；
 *   独立站成本参考日亚单位成本（JPY同币直取；Shopee仅写下单三指标）。
 *
 * 运行：node pull-platform-orders.js [--anchor=YYYY-MM-DD]
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const { callTool } = require(path.join(__dirname, '..', 'lx_api.js'));
const { normKey, loadJpyCostMap, toCcy } = require(path.join(__dirname, 'cost-lib.js'));

const ROOT = process.env.CS_ROOT || 'f:/ai agent';
const DATA_PATH = process.env.CS_ROOT
  ? path.join(process.env.CS_ROOT, 'operation_data.json')
  : 'f:/ai agent/operation_data.json';

const argv = {};
process.argv.slice(2).forEach(a => {
  if (!a.startsWith('--')) return;
  const i = a.indexOf('=');
  argv[a.slice(2, i < 0 ? undefined : i)] = i < 0 ? true : a.slice(i + 1);
});

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ANCHOR = argv.anchor ? new Date(argv.anchor + 'T12:00:00') : new Date();
const T1 = new Date(ANCHOR); T1.setDate(T1.getDate() - 1);
const MS = new Date(ANCHOR.getFullYear(), ANCHOR.getMonth(), 1);
const WS = new Date(ANCHOR); WS.setDate(WS.getDate() - 7);
const PERIODS = {
  today: [iso(T1), iso(T1)],
  week:  [iso(WS), iso(T1)],
  month: [iso(MS), iso(T1)],
};

// key 必须与看板 KNOW 映射一致；feeRate 仅用于独立站估算（领星店铺 rate 字段）
// skuDetail: shopee=下单口径SKU+账单已结算净额；shopifyJp=Shopify账单明细+变体映射；shopifyIntl=国际店账单明细
// 统一口径（2026-10-07 王泉斐拍板）：净销售额=销售额−退款−取消。
//   独立站两店 net 直接取Shopify账单（含退款负行）；Shopee/Coupang 领星无实时退款数据，net 保留下单口径+settledNet 补充。
const STORES = [
  { id: '110568528420653568', key: '泰国shopee',    ccy: 'THB', feeRate: 0,    estCost: false, skuDetail: 'shopee', settleSite: 'TH' },
  { id: '110568528420760576', key: '马来shopee',    ccy: 'MYR', feeRate: 0,    estCost: false, skuDetail: 'shopee', settleSite: 'MY' },
  { id: '110666537349581824', key: '独立站-日本',   ccy: 'JPY', feeRate: 0.06, estCost: true,  skuDetail: 'shopifyJp' },
  { id: '110719720300987904', key: '独立站-国际',   ccy: 'USD', feeRate: 0.03, estCost: false, skuDetail: 'shopifyIntl' },
];

// ===== Shopify 账单明细（行级，独立站-日本/国际共用）+ 在线变体 local_sku 映射 =====
// 领星 platform_v2 对 Shopify 只有整店聚合行；platform_shopify_bill_statement_list 给行级订单
// 行上 mskuId 实为 Shopify variant_id，经 platform_shopify_variant_list 的 local_sku 反查内部SKU
// 账单口径天然符合统一口径：net=销售额−退款（退款行为负），取消单（未支付）无账单行
let _jpVariants = null;   // 按店铺id缓存：{ sid: Map }
async function jpVariantMap(sid) {
  if (_jpVariants && _jpVariants[sid]) return _jpVariants[sid];
  _jpVariants = _jpVariants || {};
  const map = new Map();
  for (let offset = 0; ; offset += 1000) {
    const r = await callTool('action', { toolId: 'platform_shopify_variant_list',
      params: { store_ids: [String(sid)], length: 1000, offset } });
    const dd = r.data && (r.data.data || r.data);
    const list = (dd && (dd.list || dd.records)) || [];
    for (const v of list) {
      if (v.variant_id) map.set(String(v.variant_id), v);
    }
    if (list.length < 1000) break;
  }
  _jpVariants[sid] = map;
  return map;
}

async function pullShopifyJp(sid, start, end) {
  const vmap = await jpVariantMap(sid);
  // 行聚合 key(localSku) -> 行；订单计数按 orderId+localSku 去重
  const rows = new Map();
  const orderSet = new Set();
  let billNet = 0, billQty = 0;
  const flat = [];
  for (let offset = 0; ; offset += 200) {
    const r = await callTool('action', { toolId: 'platform_shopify_bill_statement_list',
      params: { sids: [String(sid)], offset, length: 200, startDate: start, endDate: end, timeType: 2 } });
    const d = r.data && r.data.data;
    if (!d) throw new Error('shopify bill 返回异常: ' + JSON.stringify(r).slice(0, 160));
    const list = Array.isArray(d.list) ? d.list : [];
    for (const o of list) {
      flat.push(o);
      if (Array.isArray(o.children)) flat.push(...o.children);
    }
    if (list.length < 200) break;   // list 按 master 订单行分页
  }
  const ensure = (code, v) => {
    if (!rows.has(code)) rows.set(code, {
      msku: code,
      name: (v && ((v.title || v.local_name || '') + '')) || '',
      img: (v && (v.picture_url || v.parent_picture_url)) || '',
      qty: 0, orders: 0, net: 0, _orders: new Set(),
    });
    return rows.get(code);
  };
  for (const x of flat) {
    const isRefund = /退/.test(x.transactionType || '');
    const sign = isRefund ? -1 : 1;
    const q = num(isRefund ? (x.refundQuantity ?? x.orderedQuantity) : x.orderedQuantity);
    // 订单行金额用 itemAmount（折扣前，与 platform_v2 店铺 net 同口径）；退款行只有折扣后负数
    const amt = isRefund ? num(x.itemSubtotalAfterDiscount) : num(x.itemAmount);
    billQty += sign * q;
    billNet += sign * amt;
    const v = vmap.get(String(x.mskuId));
    // 变体在领星存在但未填 local_sku：出占位行（编码前缀★未映射），保证净额勾稽并提示补映射
    const code = (v && (v.local_sku || v.msku)) || ('★未映射-' + x.mskuId);
    const row = ensure(code, v || { title: x.mskuName || '' });
    row.qty += sign * q;
    row.net += sign * amt;
    if (x.orderId && !isRefund) {
      const k = x.orderId + '|' + code;
      if (!row._orders.has(k)) { row._orders.add(k); row.orders++; }
      orderSet.add(x.orderId);
    }
  }
  const out = [...rows.values()].map(r => ({ ...r, _orders: undefined }));
  return { rows: out, billNet: r2(billNet), billQty: r2(billQty), orderCount: orderSet.size, variantCount: vmap.size };
}

// ===== Shopee 已回款净额（真实现金口径）=====
// 数据源 finance_shopee_income_list（打款账单）：
//   每行=一笔已打款订单的结算明细，amount=卖家实收（退款单为负行）；
//   取消/未付款单不产生账单行 → 金额天然=销售额−退款−取消后的真实现金。
// 归集维度=打款日（payoutTime）。【重要边界】账单按订单日覆盖滞后约10-14天，
//   无法支撑"订单日净额"的近端周期（T-1/T-7永远空窗）；故本字段口径=该周期内实际打款入账，
//   间歇性非打款日为空属正常（与回款字段同特性）。订单级净销售额彻底解=Shopee OPEN API（待开通）。
let _shopeeIncome = {};   // site -> { dayNet: Map, coverFrom, coverTo }
async function pullShopeeSettled(site, start, end) {
  if (!_shopeeIncome[site]) {
    const S = new Date(iso(T1) + 'T00:00:00'); S.setDate(S.getDate() - 35);   // income_list 保留期约36天，超窗返回空
    const sStart = iso(S);
    const rows = [];
    for (let offset = 0; ; offset += 200) {
      const r = await callTool('action', { toolId: 'finance_shopee_income_list',
        params: { sites: [site], startDate: sStart, endDate: iso(T1), length: 200, offset, expandChildren: true } });
      const dd = r && r.data && (r.data.data || r.data);
      const recs = (dd && (dd.list || dd.records)) || [];
      rows.push(...recs);
      if (recs.length < 200) break;
    }
    const dayNet = new Map();
    let coverFrom = null, coverTo = null;
    for (const x of rows) {
      const day = String(x.payoutTime || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (!coverFrom || day < coverFrom) coverFrom = day;
      if (!coverTo || day > coverTo) coverTo = day;
      dayNet.set(day, (dayNet.get(day) || 0) + num(x.amount));
    }
    _shopeeIncome[site] = { dayNet, coverFrom, coverTo };
    console.log('  [shopee-settle] ' + site + ' 账单行=' + rows.length + ' 打款日覆盖=' + coverFrom + '~' + coverTo);
  }
  const c = _shopeeIncome[site];
  let net = 0, hit = false;
  for (let d = new Date(start + 'T00:00:00'); d <= new Date(end + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
    const day = iso(d);
    if (c.dayNet.has(day)) hit = true;
    net += c.dayNet.get(day) || 0;
  }
  return { net: hit ? r2(net) : null, coverTo: c.coverTo, coverFrom: c.coverFrom };
}

// 统一日亚 JPY 成本库（同货同成本，THB/MYR 按外管中间价折算；cost-lib）
const DATA0 = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const JPY_COST = loadJpyCostMap(DATA0);
function shopeeUnit(ccy, msku) {
  const j = JPY_COST[normKey(msku)];
  return j != null ? toCcy(j, ccy, DATA0) : null;  // 本币负值
}

const num = v => Number(v) || 0;
const r2 = v => Math.round(num(v) * 100) / 100;

async function pullOne(sid, resultType, start, end) {
  let pageNum = 1, fetched = 0, totalRows = Infinity;
  const rows = [];
  let total = null, ccy = '';
  while (fetched < totalRows) {
    const r = await callTool('action', {
      toolId: 'platform_v2_page_list',
      params: {
        sids: [String(sid)], searchType: 3, dataType: '3',
        start, end, dateUnit: '4',
        resultType: String(resultType), pageNum, pageSize: 200, currencyCode: '',
      },
    });
    const dd = r && r.data && r.data.data ? r.data.data : null;
    if (!dd) {
      throw new Error('rt=' + resultType + ' sid=' + sid + ': ' + JSON.stringify(r).slice(0, 160));
    }
    if (total == null) { totalRows = num(dd.count) || 0; total = dd.totalList; ccy = (dd.totalList && dd.totalList.currencyCode) || ''; }
    const list = Array.isArray(dd.statisticsList) ? dd.statisticsList : [];
    rows.push(...list);
    fetched += list.length;
    pageNum++;
    if (!list.length) break;
  }
  return { rows, total, ccy };
}

// 三指标按行内 dateCollect 汇总；同时按内部SKU(sku[0])累计 qty/orders/net + 品名/图片
async function pullStore(store, start, end) {
  const days = [];
  for (let d = new Date(start + 'T00:00:00'); d <= new Date(end + 'T00:00:00'); d.setDate(d.getDate() + 1))
    days.push(iso(d));
  const sumIn = x => { let v = 0; for (const day of days) v += num(x.dateCollect && x.dateCollect[day]); return v; };
  const out = { qty: 0, orders: 0, net: 0, qtyByMsku: {}, skus: new Map() };
  const rowKey = x => {
    const c = Array.isArray(x.sku) ? x.sku[0] : x.sku;
    if (c && c !== '-') return c;
    const m = Array.isArray(x.msku) ? x.msku[0] : x.msku;
    return m && m !== '-' ? m : null;
  };
  for (const [rt, field] of [['1','qty'], ['2','orders'], ['3','net']]) {
    const { rows, ccy } = await pullOne(store.id, rt, start, end);
    if (ccy) out.ccy = ccy;
    for (const x of rows) {
      const v = sumIn(x);
      if (field === 'net') out.net += v; else out[field] += v;
      const code = rowKey(x);
      if (field === 'qty' && code) out.qtyByMsku[code] = (out.qtyByMsku[code] || 0) + v;
      if (!code) continue; // Shopify 未映射行只有整店聚合，不出 SKU 明细
      if (!out.skus.has(code)) {
        out.skus.set(code, {
          msku: code,
          name: (Array.isArray(x.productName) ? x.productName[0] : '')
            || (Array.isArray(x.platformProductTitle) ? x.platformProductTitle[0] : '') || '',
          img: x.picUrl || '',
          qty: 0, orders: 0, net: 0,
        });
      }
      const sk = out.skus.get(code);
      // 不同 resultType 返回的品名/图片完整度不同，逐次补全空字段
      if (!sk.name) sk.name = (Array.isArray(x.productName) ? x.productName[0] : '')
        || (Array.isArray(x.platformProductTitle) ? x.platformProductTitle[0] : '') || '';
      if (!sk.img && x.picUrl) sk.img = x.picUrl;
      sk[field] += v;
    }
  }
  out.qty = r2(out.qty); out.orders = r2(out.orders); out.net = r2(out.net);
  return out;
}

// 成本/归一化统一走 cost-lib（顶部已加载 JPY_COST / normKey）

(async () => {
  console.log('====================================================');
  console.log(' Multi-platform order pull | T1=' + iso(T1));
  console.log('====================================================');
  const D = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const costMap = JPY_COST;   // 统一日亚成本库（cost-lib）
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

  for (const [p, [s, e]] of Object.entries(PERIODS)) {
    if (!D[p]) continue;
    if (!D[p].settlement) D[p].settlement = {};
    for (const store of STORES) {
      const m = await pullStore(store, s, e);
      // 独立站两店：Shopify 账单行级明细（platform_v2 仅整店聚合，给不出 SKU/退款）
      const jpBill = (store.skuDetail === 'shopifyJp' || store.skuDetail === 'shopifyIntl')
        ? await pullShopifyJp(store.id, s, e) : null;
      const cur = D[p].settlement[store.key] || { currency: store.ccy };
      cur.currency = store.ccy;
      // —— 下单三指标（Shopee 与回款字段并存） ——
      cur.qty = m.qty;
      cur.orderCount = m.orders;
      cur.salesAmount = m.net;
      cur.net = m.net;
      cur.caliber = 'order';
      cur.generatedAt = stamp;

      // —— Shopee 已回款净额（真实现金=销售额−退款−取消后的入账，按打款日归集） ——
      if (store.settleSite) {
        const st = await pullShopeeSettled(store.settleSite, s, e);
        cur.settledNet = st.net;             // 非打款窗口 → null（不造数）
        cur.settledCoverTo = st.coverTo;
        cur.settledNote = '已回款净额=打款账单实收（销售额−退款−取消后的真实现金，按打款日归集；订单日口径滞后10-14天无法近端计算）';
      }

      if (store.estCost) {
        // 独立站-日本：Shopify账单行级明细 × 日亚统一成本库（JPY同币直取）；
        // 个别未匹配编码的净额按日亚当月综合成本率兜底
        const am = D.month && D.month.amazonJP;
        const blendedRate = am && num(am.net) ? num(am.cost) / num(am.net) : -0.35;
        let productCost = 0, matchedNet = 0;
        if (jpBill) {
          for (const x of jpBill.rows) {
            if (x.net <= 0) continue;
            const unit = JPY_COST[normKey(x.msku)];   // JPY 负值
            if (unit != null) { productCost += x.qty * unit; matchedNet += x.net; }
          }
        }
        // —— 统一口径：独立站 net=账单净额（销售额−退款），件数/订单同账单 ——
        if (jpBill) {
          cur.qty = jpBill.billQty;
          cur.orderCount = jpBill.orderCount;
          cur.net = jpBill.billNet;
          cur.salesAmount = jpBill.billNet;
          cur.caliber = 'bill';
          cur.settledNet = jpBill.billNet;
          cur.settledNote = '净销售额=销售额−退款（Shopify账单行级）；取消/未付款单无账单行';
        }
        const unmatchedNet = cur.net - matchedNet;
        if (unmatchedNet > 0) productCost += unmatchedNet * blendedRate;
        cur.productCost = r2(productCost);
        cur.commission = r2(-cur.net * store.feeRate);
        cur.platformFeeTotal = cur.commission;
        cur.profit = r2(cur.net + productCost + cur.commission);
        cur.margin = cur.net ? r2(cur.profit / cur.net * 100) + '%' : '0%';
        cur.feeEstimated = true;
        cur.feeNote = store.key + '账单口径（Shopify账单行级明细×日亚统一成本库）；手续费按' + (store.feeRate * 100)
          + '%估算(支付/订阅费未含)；单品成本覆盖' + r2(matchedNet / (cur.net || 1) * 100)
          + '%净额，余按日亚当月综合成本率' + r2(-blendedRate * 100) + '%估算';
        cur.costCoveragePct = cur.net ? r2(matchedNet / cur.net * 100) : null;
      } else if (store.skuDetail === 'shopifyIntl' && jpBill) {
        // 独立站-国际：统一口径 net=账单净额（销售额−退款）；USD 无成本库，费用行级估算
        cur.qty = jpBill.billQty;
        cur.orderCount = jpBill.orderCount;
        cur.net = jpBill.billNet;
        cur.salesAmount = jpBill.billNet;
        cur.caliber = 'bill';
        cur.settledNet = jpBill.billNet;
        cur.settledNote = '净销售额=销售额−退款（Shopify账单行级）；取消/未付款单无账单行';
        cur.productCost = null;
        cur.commission = null;
        cur.platformFeeTotal = null;
        cur.profit = null;
        cur.margin = null;
        cur.feeNote = '账单口径（销售额−退款，含退款负行）；手续费按3%估算于SKU行；成本待结算';
      }

      // —— SKU 明细（看板"SKU销售/利润构成"按平台切换） ——
      if (store.skuDetail === 'shopee') {
        // Shopee：下单口径销量/订单/净额 + 统一日亚单位成本(本币折算)；平台费/毛利随双周账单结算
        const rows = [...m.skus.values()]
          .filter(x => x.qty > 0 || x.net > 0)
          .map(x => {
            const unit = shopeeUnit(store.ccy, x.msku);  // 本币负值或 null
            const cost = unit != null ? r2(x.qty * unit) : null;
            return {
              msku: x.msku, name: x.name, img: x.img,
              qty: r2(x.qty), orders: r2(x.orders), net: r2(x.net),
              settledNet: null, cost, platformFee: null,
              profit: null, margin: null, settled: false,
              pct: m.net ? r2(x.net / m.net * 100) : 0,
            };
          })
          .sort((a, b) => b.net - a.net);
        cur.skuDetail = rows;
      } else if (store.skuDetail === 'shopifyJp') {
        // 独立站-日本：Shopify账单行 × local_sku映射 × 日亚统一JPY成本；手续费6%估算到行
        const feeRate = store.feeRate;
        const rows = jpBill.rows
          .filter(x => x.qty > 0 || x.net > 0)
          .map(x => {
            const unit = JPY_COST[normKey(x.msku)];   // JPY 负值或 null
            const cost = unit != null ? r2(x.qty * unit) : null;
            const platformFee = r2(-x.net * feeRate);
            const profit = cost != null ? r2(x.net + cost + platformFee) : null;
            const marginNum = profit != null && x.net ? r2(profit / x.net * 100) : null;
            return {
              msku: x.msku, name: x.name, img: x.img,
              qty: r2(x.qty), orders: r2(x.orders), net: r2(x.net),
              settledNet: r2(x.net), cost, platformFee,
              profit, margin: marginNum, settled: true, feeEstimated: true,
              pct: jpBill.billNet ? r2(x.net / jpBill.billNet * 100) : 0,
            };
          })
          .sort((a, b) => b.net - a.net);
        cur.skuDetail = rows;
      } else if (store.skuDetail === 'shopifyIntl') {
        // 独立站-国际：Shopify账单行级明细（销售额−退款）；变体local_sku映射，未映射出占位编码
        const feeRate = store.feeRate;
        const rows = (jpBill ? jpBill.rows : [])
          .filter(x => x.qty > 0 || x.net > 0)
          .map(x => ({
            msku: x.msku, name: x.name, img: x.img,
            qty: r2(x.qty), orders: r2(x.orders), net: r2(x.net),
            settledNet: r2(x.net), cost: null, platformFee: r2(-x.net * feeRate),
            profit: null, margin: null, settled: true, feeEstimated: true,
            pct: (jpBill && jpBill.billNet) ? r2(x.net / jpBill.billNet * 100) : 0,
          }))
          .sort((a, b) => b.net - a.net);
        cur.skuDetail = rows;
      } else if (store.skuDetail === 'none') {
        // Shopify 领星无商品映射（仅整店一行），清空手工旧明细避免过期误读；恢复条件：领星做SKU映射
        cur.skuDetail = [];
      }

      D[p].settlement[store.key] = cur;
      console.log(p + ' | ' + store.key + ' | qty=' + cur.qty + ' orders=' + cur.orderCount + ' net=' + cur.net + ' ' + store.ccy
        + (cur.settledNet != null ? ' settled=' + cur.settledNet : '')
        + (store.estCost ? ' GP=' + cur.profit + '(' + cur.margin + ')' : '')
        + (cur.skuDetail && cur.skuDetail.length ? ' | skuRows=' + cur.skuDetail.length : ''));
    }
  }
  fs.writeFileSync(DATA_PATH, JSON.stringify(D, null, 2), 'utf8');
  console.log('written: ' + DATA_PATH);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
