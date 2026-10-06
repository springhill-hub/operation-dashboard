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
const ROOT = process.env.CS_ROOT || 'f:/ai agent';
const { callApi } = require(path.join(ROOT, 'jst_api.js'));

const DAYS = Number((process.argv.find(a => a.startsWith('--days=')) || '--days=60').split('=')[1]) || 60;
const OUT  = (process.argv.find(a => a.startsWith('--out=')) || '').split('=')[1] || path.join(ROOT, 'domestic_data.json');
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
  // 统计口径：统一T-1（展示前一天完整数据，与外盘/领星口径对齐）
  const prevDay = new Date(now.getTime() - 1 * 86400e3);
  const prevMonthBegin = new Date(prevDay.getFullYear(), prevDay.getMonth(), 1);   // 昨天所在月的1号
  data.today     = periodAgg(orders, dAgo(1), dAgo(1));                                    // 今日看板 = 昨天
  data.yesterday = periodAgg(orders, dAgo(2), dAgo(2));                                    // 环比基准 = 前天
  data.week      = periodAgg(orders, dAgo(7), dAgo(1));                                    // 滚动7天（不含今天）
  data.lastWeek  = periodAgg(orders, dAgo(14), dAgo(8));                                   // 上周（7天，不含今天）
  data.month     = periodAgg(orders, fmtD(prevMonthBegin), dAgo(1));                        // 本月=昨天所在月
  data.lastMonth = periodAgg(orders, fmtD(lastMonthBegin), fmtD(lastMonthEnd));

  // 勾稽：today+…各周期渠道GMV合计 vs totals.gmv
  // ---- 天猫兜底：生意参谋商品排行导出（奇门接口恢复前），货号=SKU，支付口径 ----
  // 整月导出：注入 lastMonth（及月初回看的 month）；月至今MTD片段：coverage.partial=true，
  // 只要文件覆盖区间落在周期区间内即注入当月 month，并在 tmallCoverage/meta 标注截止日，防与聚水潭周期口径混淆。
  for (const pk of ['month', 'lastMonth']) {
    const P = data[pk];
    const mKey = P.dateFrom.slice(0, 7);                              // 周期所在月（如 2026-09）
    const tmallPath = path.join(ROOT, `tmall_sales_${mKey}.json`);
    const chExisting = P.channels['天猫/淘宝'];
    const qimenBack = chExisting && chExisting.gmv > 0;                 // 聚水潭已能拉到天猫单 = 奇门恢复，防双算
    if (qimenBack) {
      console.log(`tmall fallback skipped [${pk}]: 聚水潭已含天猫/淘宝订单（奇门已恢复）`);
      continue;
    }
    if (!fs.existsSync(tmallPath)) {
      console.log(`tmall fallback [${pk}]: 无 ${mKey} 导出文件，跳过`);
      continue;
    }
    const td = JSON.parse(fs.readFileSync(tmallPath, 'utf8'));
    // 文件覆盖区间：新文件带 coverage（MTD片段）；历史无 coverage 文件按整月处理
    const mEnd = fmtD(new Date(Number(mKey.slice(0, 4)), Number(mKey.slice(5, 7)), 0));
    const cov = td.coverage || { dateFrom: `${mKey}-01`, dateTo: mEnd, partial: false };
    const within = cov.dateFrom >= P.dateFrom && cov.dateTo <= P.dateTo; // 文件区间必须落在周期内
    if (!within) {
      console.log(`tmall fallback [${pk}]: 文件覆盖 ${cov.dateFrom}~${cov.dateTo} 不在周期 ${P.dateFrom}~${P.dateTo} 内，跳过`);
      continue;
    }
    const t = P.totals;
    const pay = r2(td.totalPayAmt || 0), refund = r2(td.totalRefundAmt || 0), buyers = td.totalBuyers || 0;
    // 净支付口径（2026-10-01 王泉斐确认）：gmv/net 存净支付 = 支付金额 − 成功退款金额；
    // 前端"支付GMV"= gmv+refund 恰等于生意参谋支付金额，"净销售额"= gmv 即净支付，退款率=refund/支付金额
    const gmv = r2(pay - refund);
    const mtdTag = cov.partial ? `MTD ${cov.dateFrom.slice(5)}~${cov.dateTo.slice(5)}` : '整月';
    P.channels['天猫/淘宝'] = { orders: buyers, gmv, refund, net: gmv };
    P.shops.push({ shopId: 'sycm-tmall', shop: `天猫gooutspringhill（生意参谋${mtdTag}）`, channel: '天猫/淘宝', orders: buyers, gmv, refund });
    P.tmallCoverage = cov;
    t.gmv = r2(t.gmv + gmv); t.net = r2(t.net + gmv); t.refund = r2(t.refund + refund);
    t.orders += buyers;
    t.aov = t.orders ? r2(t.net / t.orders) : 0;
    const rangeNote = cov.partial && cov.dateTo < P.dateTo
      ? `；注意天猫数据仅至${cov.dateTo}（${cov.days}天MTD），周期内其他聚水潭渠道截至${P.dateTo}` : '';
    data.meta.tmallFallback = `天猫/淘宝：生意参谋商品排行导出兜底（${mtdTag}；净支付口径：支付¥${pay}−成功退款¥${refund}=净支付¥${gmv}；件数=${td.totalPayQty}；买家数=${buyers}为商品维度购买人次加总偏高估；成功退款金额为统计期内退款成功口径${rangeNote}）；整月导出后MTD自动被覆盖；奇门恢复后停用`;
    data.meta.gaps = '京东/微店/拼多多已在聚水潭授权但订单未进入OpenAPI；天猫/淘宝因奇门接口未恢复，走生意参谋导出兜底（净支付口径=支付−退款；整月T+1同步，月中可MTD更新；聚水潭各渠道净销售额未含退货退款，两口径并存已标注）；部分退款(items.refund_qty)与平台佣金未含';
    console.log(`tmall fallback injected [${pk}]: ${mtdTag} ${cov.dateFrom}~${cov.dateTo} pay=${pay} refund=${refund} netPay=${gmv} buyers=${buyers}`);
  }
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
