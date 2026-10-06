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
// skuDetail: shopee=静态成本表可做SKU级(费用待结算)；shopify=领星无商品映射仅整店一行，不出SKU明细
const STORES = [
  { id: '110568528420653568', key: '泰国shopee',    ccy: 'THB', feeRate: 0,    estCost: false, skuDetail: 'shopee' },
  { id: '110568528420760576', key: '马来shopee',    ccy: 'MYR', feeRate: 0,    estCost: false, skuDetail: 'shopee' },
  { id: '110666537349581824', key: '独立站-日本',   ccy: 'JPY', feeRate: 0.06, estCost: true,  skuDetail: 'none'  },
  { id: '110719720300987904', key: '独立站-国际',   ccy: 'USD', feeRate: 0.03, estCost: false, amountOnly: true, skuDetail: 'none' },
];

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
      const cur = D[p].settlement[store.key] || { currency: store.ccy };
      cur.currency = store.ccy;
      // —— 下单三指标（Shopee 与回款字段并存） ——
      cur.qty = m.qty;
      cur.orderCount = m.orders;
      cur.salesAmount = m.net;
      cur.net = m.net;
      cur.caliber = 'order';
      cur.generatedAt = stamp;

      if (store.estCost) {
        // 独立站-日本：优先单品成本（日亚同币单位成本）；未匹配部分按日亚当月综合成本率估算
        // （Shopify 未做领星SKU映射时 msku 为空，全部走成本率）
        const am = D.month && D.month.amazonJP;
        const blendedRate = am && num(am.net) ? num(am.cost) / num(am.net) : -0.35;
        let productCost = 0, matchedQty = 0, totalQty = 0, unmatchedNet = 0;
        for (const [msku, q] of Object.entries(m.qtyByMsku)) {
          totalQty += q;
          const c = costMap[normKey(msku)];
          if (c != null) { productCost += q * c; matchedQty += q; }
        }
        if (matchedQty < totalQty || totalQty === 0) {
          // 未匹配销量按整体净额比例摊成本：未匹配净额 = net ×（未匹配件数占比）
          const unmatchedRatio = totalQty ? (totalQty - matchedQty) / totalQty : 1;
          unmatchedNet = r2(m.net * unmatchedRatio);
          productCost += unmatchedNet * blendedRate;
        }
        cur.productCost = r2(productCost);
        cur.commission = r2(-m.net * store.feeRate);
        cur.platformFeeTotal = cur.commission;
        cur.profit = r2(m.net + productCost + cur.commission);
        cur.margin = m.net ? r2(cur.profit / m.net * 100) + '%' : '0%';
        cur.feeEstimated = true;
        cur.feeNote = store.key + '下单口径；手续费按' + (store.feeRate * 100)
          + '%估算(支付/订阅费未含)；成本：单品匹配'
          + (totalQty ? r2(matchedQty / totalQty * 100) : 0)
          + '%，余按日亚当月综合成本率' + r2(-blendedRate * 100) + '%估算';
        cur.costCoveragePct = totalQty ? r2(matchedQty / totalQty * 100) : null;
      } else if (store.amountOnly) {
        // 国际站：仅展示本币下单金额，成本/费用无映射来源，清空旧快照利润避免误读
        cur.productCost = null;
        cur.commission = null;
        cur.platformFeeTotal = null;
        cur.profit = null;
        cur.margin = null;
        cur.feeNote = '下单口径(T-1即时)，仅本币金额；成本/手续费待Shopify账单或领星SKU映射';
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
      } else if (store.skuDetail === 'none') {
        // Shopify 领星无商品映射（仅整店一行），清空手工旧明细避免过期误读；恢复条件：领星做SKU映射
        cur.skuDetail = [];
      }

      D[p].settlement[store.key] = cur;
      console.log(p + ' | ' + store.key + ' | qty=' + m.qty + ' orders=' + m.orders + ' net=' + m.net + ' ' + store.ccy
        + (store.estCost ? ' GP=' + cur.profit + '(' + cur.margin + ')' : '')
        + (store.skuDetail === 'shopee' ? ' | skuRows=' + cur.skuDetail.length : ''));
    }
  }
  fs.writeFileSync(DATA_PATH, JSON.stringify(D, null, 2), 'utf8');
  console.log('written: ' + DATA_PATH);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
