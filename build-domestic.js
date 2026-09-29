/* ============================================================
 * 春山户外 · 国内经营看板数据构建脚本（聚水潭 OpenAPI · v1.0）
 * ------------------------------------------------------------
 * 数据源：聚水潭 /open/orders/single/query（按 modified 拉取，≤7天分片）
 * 口径（国内·支付口径）：
 *   - 归期 = pay_date（支付时间），非下单时间
 *   - 支付GMV = Σ pay_amount（pay_date∈周期 且 status≠Cancelled）
 *   - 取消退款 = Σ pay_amount（pay_date∈周期 且 status=Cancelled 且已支付）
 *   - 净销售额 = 支付GMV − 取消退款
 *   - 订单数 = 非取消有效订单数；客单价 = 净销售额 / 订单数
 *   - 部分退款（items.refund_qty）与平台佣金 v1 未含 → 待财务校准
 * 覆盖渠道：抖音/视频号/小红书/线下分销（聚水潭可拉）；
 *   天猫/淘宝/京东/微店/拼多多 已授权但订单未入API → 缺口在 meta.gaps
 * 周期：today/yesterday/week(滚动7天)/lastWeek/month(自然月)/lastMonth
 * 运行：node build-domestic.js [--days=60] [--out=path]
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const { callApi } = require(path.join('f:', 'ai agent', 'jst_api.js'));

const DAYS = Number((process.argv.find(a => a.startsWith('--days=')) || '--days=60').split('=')[1]) || 60;
const OUT  = (process.argv.find(a => a.startsWith('--out=')) || '').split('=')[1] || 'f:/ai agent/domestic_data.json';
const PAGE = 200;

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const fmtD = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ---------- 1. 拉取（modified 分片，≤6天/片） ----------
async function pullOrders(days) {
  const now = new Date();
  const begin = new Date(now.getTime() - days * 86400e3);
  begin.setHours(0, 0, 0, 0);
  const chunks = [];
  let cur = new Date(begin);
  while (cur < now) {
    const nxt = new Date(Math.min(cur.getTime() + 6 * 86400e3, now.getTime()));
    const f = d => `${fmtD(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
    chunks.push([f(cur), f(nxt)]);
    cur = nxt;
  }
  let all = [], apiCalls = 0;
  for (const [b, e] of chunks) {
    let page = 1;
    while (true) {
      apiCalls++;
      const r = await callApi('/open/orders/single/query', {
        modified_begin: b, modified_end: e, page_index: page, page_size: PAGE,
      });
      const j = JSON.parse(r);
      if (j.code !== 0) throw new Error(`${b}~${e} p${page}: ${j.msg}`);
      const orders = (j.data && j.data.orders) || [];
      all = all.concat(orders);
      if (!j.data || !j.data.has_next || orders.length === 0) break;
      page++;
      if (page > 80) break; // 防死循环
    }
  }
  console.log(`pulled ${all.length} orders via ${apiCalls} API calls (${days}d window)`);
  return all;
}

// ---------- 2. 清洗/去重/渠道映射 ----------
const CHANNELS = ['抖音', '视频号', '小红书', '天猫/淘宝', '京东', '拼多多', '微店', '线下/分销'];
function channelOf(o) {
  const site = String(o.shop_site || '');
  const name = String(o.shop_name || '');
  if (site === '头条放心购' || name.startsWith('「抖音」')) return '抖音';
  if (site === '微信视频号' || name.includes('视频号')) return '视频号';
  if (site === '小红书' || name.startsWith('「小红书」')) return '小红书';
  if (site === '淘宝天猫') return '天猫/淘宝';
  if (site === '京东商城') return '京东';
  if (site === '拼多多') return '拼多多';
  if (site === '口袋微店') return '微店';
  if (site === '快团团') return '线下/分销';
  if (site === '线下店铺' || site === '阿里巴巴' || site === '商家自有商城' || site === '密选') return '线下/分销';
  return '线下/分销';
}

function normalize(orders) {
  const seen = new Set(), out = [];
  for (const o of orders) {
    if (!o.pay_date || !String(o.pay_date).trim()) continue;       // 未付款剔除
    const key = o.so_id || o.o_id;
    if (seen.has(key)) continue; seen.add(key);                    // so_id 去重
    const cancelled = String(o.status || '') === 'Cancelled';
    const items = (Array.isArray(o.items) ? o.items : []).map(it => ({
      skuId: it.sku_id || ('i_' + it.i_id),
      name: it.name || it.properties_value || '',
      qty: Number(it.qty) || 0,
      amount: Number(it.amount) || 0,
      gift: !!it.is_gift,
    }));
    out.push({
      soId: String(key),
      shopId: o.shop_id, shopName: o.shop_name || o.shop_site,
      channel: channelOf(o),
      payDate: String(o.pay_date).slice(0, 10),
      status: String(o.status || ''),
      cancelled,
      gmv: Number(o.pay_amount) || 0,
      items,
    });
  }
  return out;
}

// ---------- 3. 周期聚合 ----------
function periodAgg(orders, dateFrom, dateTo) {
  const sel = orders.filter(o => o.payDate >= dateFrom && o.payDate <= dateTo);
  const ch = {}, shopMap = {}, skuMap = {}, daily = {};
  let gmv = 0, refund = 0, validOrders = 0, cancelOrders = 0;
  for (const o of sel) {
    // 渠道/店铺桶始终登记（含取消单，便于 refund 拆分）
    ch[o.channel] = ch[o.channel] || { orders: 0, gmv: 0, refund: 0 };
    shopMap[o.shopId] = shopMap[o.shopId] || { shopName: {}, channel: o.channel, orders: 0, gmv: 0, refund: 0 };
    shopMap[o.shopId].shopName[o.shopName] = (shopMap[o.shopId].shopName[o.shopName] || 0) + 1;
    if (o.cancelled) {
      cancelOrders++; refund += o.gmv;
      ch[o.channel].refund += o.gmv;
      shopMap[o.shopId].refund += o.gmv;
      continue;
    }
    validOrders++;
    gmv += o.gmv;
    ch[o.channel].orders++; ch[o.channel].gmv += o.gmv;
    shopMap[o.shopId].orders++; shopMap[o.shopId].gmv += o.gmv;
    // SKU
    for (const it of o.items) {
      const uk = it.skuId;
      skuMap[uk] = skuMap[uk] || { skuId: uk, name: {}, qty: 0, amount: 0 };
      if (it.name) skuMap[uk].name[it.name] = (skuMap[uk].name[it.name] || 0) + 1;
      skuMap[uk].qty += it.qty; skuMap[uk].amount += it.amount;
    }
    // 日趋势
    daily[o.payDate] = daily[o.payDate] || { gmv: 0, net: 0, orders: 0 };
    daily[o.payDate].gmv += o.gmv; daily[o.payDate].net += o.gmv; daily[o.payDate].orders += 1;
  }
  const shops = Object.entries(shopMap).map(([shopId, v]) => {
    const names = Object.entries(v.shopName).sort((a, b) => b[1] - a[1]);
    return { shopId, shop: names[0][0], channel: v.channel, orders: v.orders, gmv: r2(v.gmv), refund: r2(v.refund) };
  }).sort((a, b) => (b.gmv + b.refund) - (a.gmv + a.refund));
  const skuTop = Object.values(skuMap).map(s => ({
    skuId: s.skuId,
    name: Object.entries(s.name).sort((a, b) => b[1] - a[1])[0]?.[0] || '',
    qty: s.qty, amount: r2(s.amount),
  })).sort((a, b) => b.amount - a.amount).slice(0, 20);
  // 净销售额 = 有效订单支付额（取消单的钱未留存，已在 refund 单列，勿重复扣减）
  const net = r2(gmv);
  return {
    dateFrom, dateTo,
    totals: {
      gmv: r2(gmv), refund: r2(refund), net,
      orders: validOrders, cancelOrders,
      aov: validOrders ? r2(net / validOrders) : 0,
      skuCount: Object.keys(skuMap).length,
    },
    channels: Object.fromEntries(CHANNELS.filter(c => ch[c]).map(c => [c, {
      orders: ch[c].orders, gmv: r2(ch[c].gmv), refund: r2(ch[c].refund), net: r2(ch[c].gmv),
    }])),
    shops, skuTop,
    dailyTrend: Object.entries(daily).sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([d, v]) => ({ date: d, gmv: r2(v.gmv), orders: v.orders })),
  };
}

// ---------- 4. 主流程 ----------
(async () => {
  const now = new Date();
  const today = fmtD(now);
  const dAgo = n => fmtD(new Date(now.getTime() - n * 86400e3));
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);   // 上月最后一天
  const lastMonthBegin = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const raw = await pullOrders(DAYS);
  const orders = normalize(raw);
  console.log(`normalized ${orders.length} paid orders`);

  const data = {
    meta: {
      generatedAt: `${today} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
      source: '聚水潭 OpenAPI /open/orders/single/query',
      currency: 'CNY',
      caliber: '支付口径：按支付时间(pay_date)归期；净销售额=有效订单支付额（取消单退款单列，不重复扣减）；支付GMV=净销售额+取消退款；客单价=净销售额/有效订单数',
      coveredChannels: CHANNELS,
      gaps: '天猫/淘宝/京东/微店/拼多多已在聚水潭授权但订单未进入OpenAPI（待开启订单下载）；部分退款(items.refund_qty)与平台佣金未含，待财务校准SOP接入',
      window: `${fmtD(new Date(now.getTime() - DAYS * 86400e3))} ~ ${today}（按modified拉取）`,
    },
  };
  // 本周=滚动7天（含今日），对齐跨境版
  data.today     = periodAgg(orders, today, today);
  data.yesterday = periodAgg(orders, dAgo(1), dAgo(1));
  data.week      = periodAgg(orders, dAgo(6), today);
  data.lastWeek  = periodAgg(orders, dAgo(13), dAgo(7));
  data.month     = periodAgg(orders, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, today);
  data.lastMonth = periodAgg(orders, fmtD(lastMonthBegin), fmtD(lastMonthEnd));

  // 勾稽：today+…各周期渠道GMV合计 vs totals.gmv
  let ok = true;
  for (const p of ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth']) {
    const sumCh = Object.values(data[p].channels).reduce((s, c) => s + c.gmv, 0);
    const diff = Math.abs(sumCh - data[p].totals.gmv);
    if (diff > 0.05) { ok = false; console.error(`RECONCILE FAIL ${p}: channels=${sumCh} vs totals=${data[p].totals.gmv}`); }
  }
  console.log(ok ? 'reconcile OK (channels == totals, all periods)' : 'RECONCILE FAILED');
  data.meta.reconcile = ok ? 'OK' : 'FAIL';

  fs.writeFileSync(OUT, JSON.stringify(data));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`written ${OUT} (${kb} KB)`);
  // 摘要
  for (const p of ['today', 'week', 'month']) {
    const t = data[p].totals;
    console.log(`${p}: GMV=${t.gmv} refund=${t.refund} net=${t.net} orders=${t.orders} aov=${t.aov} shops=${data[p].shops.length}`);
  }
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
