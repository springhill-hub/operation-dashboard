/* ============================================================
 * 春山户外 · SKU健康总表构建（v1.0 · 2026-10-06）
 * ------------------------------------------------------------
 * 目标：每个SKU
 *   库存：国内总仓(聚水潭) + 跨境备货仓 + FBA + 海外仓 + 在途
 *   销量：近7天 / 近30天，内盘、外盘分别汇总
 *   判定：断货风险（已断货/紧急/关注/健康/偏高）与滞销
 *
 * 数据源：
 *   领星 MCP（X-Mcp-Key）：get_fba_stock_list、platform_v2_page_list
 *   领星 REST（服务器IP已白名单）：海外仓/跨境本地仓报表
 *   聚水潭 OpenAPI：国内库存与订单（IP白名单，110失败时降级）
 *   天猫生意参谋导出：聚水潭不可用时的内盘兜底（支付件数口径）
 *   乐天 RMS raw 订单：build-rakuten 拉取的订单JSON
 *
 * 输出：inventory_data.json 新增 skuHealth 块
 * 运行：node build-sku-health.js [YYYY-MM-DD]
 * ============================================================ */
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { callApi: jstCall } = require(path.join(__dirname, '..', 'jst_api.js'));
const { callTool } = require(path.join(__dirname, '..', 'lx_api.js'));

const APP_ID = 'ak_M7HmqeOuHZaKM';
const APP_SECRET = 'iDyoq2lp49+ksuSqmpMQiQ==';
const ROOT = process.env.CS_ROOT || (process.platform === 'win32' ? 'f:/ai agent' : '/opt/chunshan');
const DATA_PATH = path.join(ROOT, 'inventory_data.json');

// ---------- 领星 REST ----------
let _token = null, _tokenAt = 0;
function lxSign(params, appKey) {
  const keys = Object.keys(params).sort();
  const str = keys.map(k => {
    const v = params[k];
    const s = (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
    return `${k}=${s}`;
  }).join('&');
  const md5Hex = crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase();
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(appKey, 'utf8'), null);
  let enc = cipher.update(md5Hex, 'utf8');
  enc = Buffer.concat([enc, cipher.final()]);
  return enc.toString('base64');
}
async function getToken() {
  if (_token && Date.now() - _tokenAt < 100 * 60 * 1000) return _token;
  const qs = `appId=${encodeURIComponent(APP_ID)}&appSecret=${encodeURIComponent(APP_SECRET)}`;
  _token = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openapi.lingxing.com', path: `/api/auth-server/oauth/access-token?${qs}`,
      method: 'POST', headers: { 'Content-Length': 0 }, timeout: 20000,
    }, res => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d).data.access_token); } catch (e) { reject(new Error(d.slice(0, 200))); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
  _tokenAt = Date.now();
  return _token;
}
async function lxRest(apiPath, bizParams) {
  const token = await getToken();
  const ts = Math.floor(Date.now() / 1000).toString();
  const base = { access_token: token, app_key: APP_ID, timestamp: ts };
  const sign = lxSign(Object.assign({}, base, bizParams), APP_ID);
  const query = Object.assign({}, base, { sign });
  const qs = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const body = JSON.stringify(bizParams);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openapi.lingxing.com', path: `${apiPath}?${qs}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 60000,
    }, res => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ code: -1, raw: d.slice(0, 300) }); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

// ---------- utils ----------
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r1 = v => Math.round(num(v) * 10) / 10;
function fmtDate(d0) {
  return `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

// 状态码：OUT已断货 URG紧急 WARN关注 OK健康 HIGH偏高 DEAD滞销 SKIP数据不全不判
const STATUS_RANK = { OUT: 0, URG: 1, DEAD: 2, WARN: 3, HIGH: 4, OK: 5 };
const STATUS_LABEL = {
  OUT: ['已断货', 'urg'], URG: ['紧急补货', 'urg'], WARN: ['需要关注', 'mid'],
  OK: ['健康', 'norm'], HIGH: ['库存偏高', 'gry'], DEAD: ['滞销', 'gry'],
};
// 非卖品/杂项链接：不计库存、不计销量
const NON_SKU = /邮费|补差价|补差链接|处理品|放心购|快递.*消毒|test|^WL-|CS-WL-/i;
function judge(stock, pipeline, s7, s30, degraded) {
  if (s30 <= 0 && s7 <= 0) {
    if (pipeline > 0) return degraded ? 'SKIP' : 'DEAD';
    return null;
  }
  if (pipeline <= 0) return 'OUT';
  const rate = Math.max(s7 / 7, s30 / 30);
  const days = pipeline / rate;
  if (days <= 14) return 'URG';
  if (days <= 30) return 'WARN';
  if (days <= 90) return 'OK';
  if (days <= 180) return 'HIGH';
  return degraded ? 'SKIP' : 'DEAD';
}

(async () => {
  const today0 = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2])
    ? process.argv[2] : fmtDate(new Date());
  const d7Start = fmtDate(addDays(new Date(today0 + 'T00:00:00'), -6));
  const d30Start = fmtDate(addDays(new Date(today0 + 'T00:00:00'), -29));
  const today = new Date();
  const lastMonth = fmtDate(new Date(today.getFullYear(), today.getMonth() - 1, 1)).slice(0, 7);
  console.log('====================================================');
  console.log(' build-sku-health | today=' + today0);
  console.log(' d7: ' + d7Start + ' ~ ' + today0 + ' | d30: ' + d30Start + ' ~ ' + today0);
  console.log('====================================================');

  const D = fs.existsSync(DATA_PATH)
    ? JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))
    : { meta: { generatedAt: '' }, jst: null, fba: null, overseas: null, crossBorder: null };
  if (!D.meta || !D.meta.generatedAt) console.log('  [WARN] 无历史inventory_data.json（云端首跑）');
  // 上一轮健康行（某数据源失败时回退，保持判定连续）
  const PREV = new Map(((D.skuHealth && D.skuHealth.rows) || []).map(r => [r.sku, r]));

  // 行容器
  const R = new Map(); // sku -> row
  const row = (sku, name) => {
    if (!sku) return null;
    if (!R.has(sku)) R.set(sku, {
      sku, name: name || '', img: '',
      jst: 0, jstAvail: 0, cross: 0, fba: 0, ov: 0, ovRest: 0, ovCp: 0, inTransit: 0,
      in7: 0, in30: 0, out7: 0, out30: 0,
    });
    const o = R.get(sku);
    if (!o.name && name) o.name = name;
    return o;
  };
  const inWin = d => d >= d30Start && d <= today0;
  const in7 = d => d >= d7Start && d <= today0;

  const coverage = {
    generatedAt: today0,
    windows: { d7: [d7Start, today0], d30: [d30Start, today0] },
    jst: { inventory: '', sales: '', ip: '' },
    notes: [],
  };

  // ===== 1. FBA库存（MCP，本地SKU键） =====
  console.log('\n[1] FBA库存 MCP');
  try {
    let offset = 0;
    while (true) {
      const r = await callTool('action', {
        toolId: 'get_fba_stock_list',
        params: { sid: '3118', length: 500, offset, is_hide_zero_stock: '1' },
      });
      const d = r.data;
      const list = (d && d.list) || [];
      for (const x of list) {
        const sku = x.sku || x.seller_sku;
        const o = row(sku, x.product_name);
        if (!o) continue;
        o.fba += num(x.afn_fulfillable_quantity);
        o.inTransit += num(x.afn_inbound_shipped_quantity);
        if (x.pic_url) o.img = x.pic_url;
      }
      if (list.length < 500) break;
      offset += 500;
    }
    console.log('  FBA rows累计: ' + R.size);
  } catch (e) {
    console.log('  [WARN] FBA拉取失败，回退上一轮数据: ' + e.message);
    coverage.notes.push('FBA库存为上一轮缓存（本次MCP拉取失败：' + e.message.slice(0, 80) + '）');
    for (const [sku, p] of PREV) { const o = row(sku, p.name); if (o) { o.fba = num(p.fba); o.inTransit += num(p.inTransit); if (p.img) o.img = p.img; } }
  }

  // ===== 2. 海外仓库存（REST；IP未白名单时回退上一轮） =====
  console.log('\n[2] 海外仓库存 REST');
  try {
    const r = await lxRest('/inventory/center/openapi/storageReport/overseas/detail/page', {
      start_date: lastMonth + '-01', end_date: today0, page: 1, size: 500,
    });
    if (r.code !== 0) throw new Error('code=' + r.code + ' ' + JSON.stringify(r.message || r.msg || r.raw || '').slice(0, 120));
    const rows = r.data || [];
    const whMap = new Map();
    for (const x of rows) {
      const sku = x.sku;
      if (!whMap.has(sku)) whMap.set(sku, { qty: 0, tr: 0, name: x.product_name || '', wh: new Set() });
      const o = whMap.get(sku);
      o.qty += num(x.day_end_count);
      o.tr += num(x.allocation_in_transit_count);
      if (x.ware_house_name) o.wh.add(x.ware_house_name);
    }
    for (const [sku, v] of whMap) {
      const o = row(sku, v.name);
      o.ovRest += v.qty;
      o.inTransit += v.tr;
    }
    console.log('  海外仓SKU: ' + whMap.size + '，行总数: ' + R.size);
  } catch (e) {
    console.log('  [WARN] 海外仓REST失败，回退上一轮数据: ' + e.message);
    coverage.notes.push('海外仓/在途为上一轮缓存（领星REST IP未白名单或失败：' + e.message.slice(0, 80) + '）；如需实时请在领星白名单加本机IP');
    for (const [sku, p] of PREV) { const o = row(sku, p.name); if (o) { o.ovRest = num(p.ovRest != null ? p.ovRest : p.ov); o.inTransit += num(p.inTransit); } }
  }

  // ===== 3. 跨境本地仓库存（REST；IP未白名单时回退上一轮） =====
  console.log('\n[3] 跨境本地仓 REST');
  try {
    const r = await lxRest('/inventory/center/openapi/storageReport/local/detail/page', {
      start_date: lastMonth + '-01', end_date: today0, page: 1, size: 500,
    });
    if (r.code !== 0) throw new Error('code=' + r.code + ' ' + JSON.stringify(r.message || r.msg || r.raw || '').slice(0, 120));
    const rows = r.data || [];
    const lcMap = new Map();
    for (const x of rows) {
      const sku = x.sku || x.api_sku || x.spu;
      if (!lcMap.has(sku)) lcMap.set(sku, { qty: 0, tr: 0, name: x.product_name || '' });
      const o = lcMap.get(sku);
      o.qty += num(x.day_end_count);
      o.tr += num(x.allocation_in_transit_count);
    }
    for (const [sku, v] of lcMap) {
      const o = row(sku, v.name);
      o.cross += v.qty;
      o.inTransit += v.tr;
    }
    console.log('  跨境仓SKU: ' + lcMap.size + '，行总数: ' + R.size);
  } catch (e) {
    console.log('  [WARN] 跨境仓REST失败，回退上一轮数据: ' + e.message);
    coverage.notes.push('跨境备货仓为上一轮缓存（领星REST IP未白名单或失败）');
    for (const [sku, p] of PREV) { const o = row(sku, p.name); if (o) { o.cross = num(p.cross); } }
  }

  // ===== 3.5 Coupang平台仓库存（MCP，无IP限制，REST海外仓不含此仓） =====
  console.log('\n[3.5] Coupang平台仓库存 MCP');
  try {
    let offset = 0, added = 0;
    while (true) {
      const r = await callTool('action', {
        toolId: 'platform_warehouse_coupang_stock',
        params: { storeIdList: ['110719712118729216'], length: 200, offset },
      });
      const sp = (((r.data || {}).data || {}).stockPage) || {};
      const recs = sp.records || [];
      for (const x of recs) {
        if (!x.sku) continue; // 未映射本地SKU的行跳过
        const o = row(x.sku, x.productName || '');
        if (!o) continue;
        o.ovCp += num(x.totalOrderableQuantity);
        if (x.picUrl && !o.img) o.img = x.picUrl;
        added++;
      }
      const total = num(sp.total);
      if (recs.length < 200 || offset + recs.length >= total) break;
      offset += recs.length;
    }
    console.log('  Coupang平台仓有效行: ' + added);
  } catch (e) {
    console.log('  [WARN] Coupang平台仓拉取失败: ' + e.message);
    coverage.notes.push('Coupang平台仓库存本次拉取失败：' + e.message.slice(0, 80));
  }

  // 海外仓合计 = REST海外仓(Shopee泰国等三方仓) + Coupang平台仓（两源独立，不会重复计）
  for (const o of R.values()) o.ov = o.ovRest + o.ovCp;

  // ===== 4. 聚水潭国内库存（IP白名单，失败降级快照） =====
  console.log('\n[4] 聚水潭库存');
  let jstBlocked = false;
  {
    const now = new Date();
    const end = `${fmtDate(now)} 23:59:59`;
    const start = `${fmtDate(addDays(now, -6))} 00:00:00`;
    const r0 = await jstCall('/open/inventory/query', {
      page_index: 1, page_size: 5,
      modified_begin: start, modified_end: end,
    });
    let j;
    try { j = JSON.parse(r0); } catch { j = { code: -1, msg: r0.slice(0, 100) }; }
    if (j.code === 110) {
      jstBlocked = true;
      coverage.jst.inventory = 'blocked';
      coverage.jst.ip = (j.msg.match(/(\d+\.){3}\d+/) || [''])[0];
      console.log('  拦截: ' + j.msg);
    }
    if (!jstBlocked && j.code === 0) {
      // 全量分页拉取
      const m = new Map();
      let page = 1;
      while (true) {
        const r = await jstCall('/open/inventory/query', {
          page_index: page, page_size: 100,
          modified_begin: start, modified_end: end,
        });
        const jj = JSON.parse(r);
        if (jj.code !== 0) break;
        const invs = (jj.data && jj.data.inventorys) || [];
        if (!invs.length) break;
        for (const x of invs) {
          if (NON_SKU.test(x.sku_id + ' ' + (x.name || ''))) continue;
          m.set(x.sku_id, {
            qty: num(x.qty), avail: Math.max(0, num(x.qty) - num(x.order_lock)),
            pur: num(x.purchase_qty), name: x.name || '',
          });
        }
        if (invs.length < 100) break;
        page++;
      }
      for (const [sku, v] of m) {
        const o = row(sku, v.name);
        o.jst = v.qty; o.jstAvail = v.avail; o.inTransit += v.pur;
      }
      coverage.jst.inventory = 'fresh';
      console.log('  聚水潭新鲜库存SKU: ' + m.size);
    } else if (jstBlocked) {
      // 降级：inventory_data 内 09-30 快照
      const snap = D.jst;
      if (snap) {
        for (const v of snap.skuDetail || []) {
          if (NON_SKU.test(v.sku + ' ' + (v.name || ''))) continue;
          const o = row(v.sku, v.name);
          o.jst = v.qty;
          o.jstAvail = Math.max(0, v.available);
          o.inTransit += v.purchaseQty;
        }
        coverage.jst.inventory = 'stale@' + (D.meta && D.meta.generatedAt);
        console.log('  降级快照: ' + coverage.jst.inventory + ' SKU=' + ((snap.skuDetail || []).length));
      }
    }
  }

  // ===== 5. 内盘销量 =====
  console.log('\n[5] 内盘销量');
  // domDaily: date -> sku -> qty
  const domDaily = {};
  const addDom = (date, sku, qty) => {
    if (!date || !sku || !qty) return;
    if (!domDaily[date]) domDaily[date] = {};
    domDaily[date][sku] = (domDaily[date][sku] || 0) + qty;
  };

  if (!jstBlocked) {
    // 聚水潭订单30天，7天分片
    const INVALID = /^(Cancelled|Merged|Split)$/;
    const NON = /邮费|补差价|补差链接|处理品|放心购|test/i;
    const tStart = new Date(d30Start + 'T00:00:00+08:00');
    const tEnd = new Date(today0 + 'T23:59:59+08:00');
    let cur = tStart;
    while (cur <= tEnd) {
      const sliceEnd = addDays(cur, 6) > tEnd ? tEnd : addDays(cur, 6);
      const fmt = d => `${fmtDate(d)} ${String(d.getHours()).padStart(2, '0')}:00:00`;
      let page = 1;
      while (true) {
        const r = await jstCall('/open/orders/single/query', {
          page_index: page, page_size: 100,
          modified_begin: fmt(cur), modified_end: fmt(sliceEnd),
        });
        const jj = JSON.parse(r);
        if (jj.code !== 0 || !jj.data || !jj.data.orders || !jj.data.orders.length) break;
        for (const order of jj.data.orders) {
          if (INVALID.test(order.status || '')) continue;
          const odate = (order.o_date || order.pay_date || '').slice(0, 10);
          for (const it of order.items || []) {
            const sku = it.sku_id;
            if (!sku || NON.test(sku + ' ' + (it.name || ''))) continue;
            const net = Math.max(0, num(it.qty) - num(it.refund_qty));
            addDom(odate || fmtDate(cur), sku, net);
          }
        }
        if (!jj.data.has_next || jj.data.orders.length < 100) break;
        page++;
      }
      cur = addDays(sliceEnd, 1);
    }
    coverage.jst.sales = 'fresh';
  } else {
    coverage.jst.sales = 'blocked-tmall-fallback';
    // 天猫生意参谋兜底：月度SKU销量按店铺daily支付权重摊到日
    const distribute = file => {
      if (!fs.existsSync(file)) return null;
      const td = JSON.parse(fs.readFileSync(file, 'utf8'));
      const daily = td.daily || [];
      const ss = td.skuSales || {};
      const nameMap = new Map((td.items || []).map(it => [it.code, it.name]));
      return { daily, ss, nameMap, tag: td.month };
    };
    for (const monthTag of [d30Start.slice(0, 7), today0.slice(0, 7)]) {
      const dd = distribute(path.join(ROOT, `tmall_sales_${monthTag}.json`));
      if (!dd) { console.log('  无 ' + monthTag + ' 天猫文件'); continue; }
      // 交集日期：优先daily支付件数权重；无daily则窗口内均匀
      let dates = dd.daily
        .filter(x => inWin(x.date))
        .map(x => [x.date, Math.max(1, num(x.payQty))]);
      if (!dates.length) {
        const [y, m] = monthTag.split('-').map(Number);
        const m0 = monthTag + '-01';
        const mEnd = fmtDate(new Date(y, m, 0));
        const d0 = m0 > d30Start ? m0 : d30Start;
        const dE = mEnd < today0 ? mEnd : today0;
        for (let d = d0; d <= dE; d = fmtDate(addDays(new Date(d + 'T00:00:00'), 1))) dates.push([d, 1]);
      }
      const W = dates.reduce((s, x) => s + x[1], 0);
      let nSku = 0;
      for (const [sku, qty0] of Object.entries(dd.ss)) {
        const qty = num(qty0);
        if (qty <= 0) continue;
        const iname0 = dd.nameMap.get(sku) || '';
        if (NON_SKU.test(sku + ' ' + iname0)) continue;
        row(sku, iname0);
        for (const [date, w] of dates) addDom(date, sku, qty * w / W);
        nSku++;
      }
      console.log(`  天猫${monthTag}: ${nSku} SKU摊到${dates.length}天`);
    }
    coverage.notes.push('内盘仅天猫渠道（生意参谋支付件数口径），抖音/B端等其他内盘销量缺失，待聚水潭IP白名单恢复后补全');
  }
  // 汇总domDaily到行
  for (const [date, m] of Object.entries(domDaily)) {
    for (const [sku, qty] of Object.entries(m)) {
      const o = row(sku, '');
      if (in7(date)) o.in7 += qty;
      if (inWin(date)) o.in30 += qty;
    }
  }

  // ===== 6. 外盘销量（v2：日亚/Shopee/Coupang/独立站国际） =====
  console.log('\n[6] 外盘销量 v2');
  const V2 = [
    ['日亚', '3118'],
    ['Shopee泰', '110568528420653568'],
    ['Shopee马', '110568528420760576'],
    ['Coupang', '110719712118729216'],
    ['独立站国际', '110719720300987904'],
  ];
  for (const [name, sid] of V2) {
    let pageNum = 1;
    while (true) {
      const r = await callTool('action', {
        toolId: 'platform_v2_page_list',
        params: {
          currencyCode: '', dataType: '4', dateUnit: '4',
          start: d30Start, end: today0, resultType: '1', searchType: 3,
          sids: [sid], pageSize: 200, pageNum,
        },
      });
      const d = r.data && r.data.data;
      const rows = (d && d.statisticsList) || [];
      for (const x of rows) {
        const sku = (x.sku && x.sku[0]) || '';
        const pname = (x.productName && x.productName[0]) || '';
        const o = row(sku, pname);
        if (!o) continue;
        const dc = x.dateCollect || {};
        for (const [dt, v] of Object.entries(dc)) {
          if (in7(dt)) o.out7 += num(v);
          if (inWin(dt)) o.out30 += num(v);
        }
      }
      if (rows.length < 200) break;
      pageNum++;
    }
    console.log('  ' + name + ' 完成');
  }

  // ===== 7. 乐天（raw订单） =====
  console.log('\n[7] 乐天销量 raw');
  {
    const files = [
      path.join(__dirname, 'rakuten-raw', `orders_${d30Start.slice(0, 7)}-01_${d30Start.slice(0, 7)}-30.json`),
      path.join(__dirname, 'rakuten-raw', 'orders_2026-09-29_2026-10-05.json'),
    ];
    const nums = new Set();
    let used = 0, added = 0;
    for (const f of files) {
      if (!fs.existsSync(f)) { console.log('  缺 ' + path.basename(f)); continue; }
      used++;
      const orders = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const o of orders) {
        if (nums.has(o.orderNumber)) continue;
        nums.add(o.orderNumber);
        if (o.orderProgress === 900) continue; // 已取消
        const dt = (o.orderDatetime || '').slice(0, 10);
        if (!inWin(dt)) continue;
        for (const pkg of o.PackageModelList || []) {
          for (const it of pkg.ItemModelList || []) {
            const skus = (it.SkuModelList || []).map(s => s.merchantDefinedSkuId || s.variantId);
            const code = [...skus, it.manageNumber, it.itemNumber].filter(Boolean)[0];
            const o2 = row(code, it.itemName || '');
            if (!o2) continue;
            if (in7(dt)) o2.out7 += num(it.units);
            o2.out30 += num(it.units);
            added++;
          }
        }
      }
    }
    console.log(`  使用${used}文件，乐天有效行=${added}，截至2026-10-05`);
    if (used === 0) {
      // 云端无raw订单（含PII不入库），回退到Actions每日提交的脱敏聚合 rakuten-sku-daily.json
      const aggP = path.join(__dirname, 'rakuten-sku-daily.json');
      if (fs.existsSync(aggP)) {
        const agg = JSON.parse(fs.readFileSync(aggP, 'utf8'));
        let addedAgg = 0;
        for (const [dt, m] of Object.entries(agg)) {
          if (!inWin(dt)) continue;
          for (const [code, qty] of Object.entries(m)) {
            const o2 = row(code, '');
            if (!o2) continue;
            if (in7(dt)) o2.out7 += num(qty);
            o2.out30 += num(qty);
            addedAgg++;
          }
        }
        console.log('  回退到每日聚合 rakuten-sku-daily.json，有效行=' + addedAgg);
        coverage.notes.push('乐天销量来自Actions每日脱敏聚合（云端无raw订单）');
      } else {
        console.log('  [WARN] 乐天raw与聚合文件均缺失，乐天销量按0计');
        coverage.notes.push('乐天销量缺失（raw与聚合文件均不存在），外盘判定偏严');
      }
    } else {
      coverage.notes.push('乐天数据截至10-05（RMS API当日订单次日可查）');
    }
  }

  // ===== 8. 计算判定并输出 =====
  console.log('\n[8] 判定');
  const out = [];
  const degraded = jstBlocked; // 内盘数据不全（聚水潭被拦）
  for (const o of R.values()) {
    o.in7 = r1(o.in7); o.in30 = r1(o.in30); o.out7 = r1(o.out7); o.out30 = r1(o.out30);
    const stockIn = o.jstAvail;
    const stockOut = o.fba + o.ov + o.cross; // 跨境备货仓也算海外现货
    const pipeOut = o.fba + o.ov + o.cross + o.inTransit;
    const gStock = stockIn + stockOut;
    const gPipe = stockIn + pipeOut;
    const s7all = o.in7 + o.out7, s30all = o.in30 + o.out30;
    if (gStock <= 0 && s30all <= 0 && s7all <= 0) continue; // 全渠道无库存无销量
    const stIn = judge(stockIn, stockIn, o.in7, o.in30, degraded);
    const stOut = judge(stockOut, pipeOut, o.out7, o.out30, false);
    // 可销天数（现货，按max(7d,30d)速率）
    const days = (stock, s7, s30) => {
      if (stock <= 0) return s30 > 0 ? 0 : null;
      if (s30 <= 0 && s7 <= 0) return null;
      return r1(stock / Math.max(s7 / 7, s30 / 30));
    };
    const coverInD = days(stockIn, o.in7, o.in30);
    const coverOutD = days(stockOut, o.out7, o.out30);
    const coverPipeD = days(gPipe, s7all, s30all);
    // 综合：全球总库存 vs 全球总销量；数据不全或无判定时取单边最差
    let overall = judge(gStock, gPipe, s7all, s30all, degraded);
    if (!overall || overall === 'SKIP') {
      const sides = [stIn, stOut].filter(x => x && x !== 'SKIP')
        .sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b]);
      overall = sides[0] || null;
    }
    if (!overall) continue;
    out.push({
      sku: o.sku, name: o.name, img: o.img,
      jst: o.jst, jstAvail: stockIn, cross: o.cross, fba: o.fba, ov: o.ov, inTransit: o.inTransit,
      in7: o.in7, in30: o.in30, out7: o.out7, out30: o.out30,
      coverIn: coverInD, coverOut: coverOutD, coverPipe: coverPipeD,
      stIn: stIn === 'SKIP' ? null : stIn,
      stOut, overall,
    });
  }
  // 排序：状态优先级 → 30天总销量降序
  out.sort((a, b) => STATUS_RANK[a.overall] - STATUS_RANK[b.overall]
    || (b.in30 + b.out30) - (a.in30 + a.out30));

  const counts = {};
  out.forEach(x => { counts[x.overall] = (counts[x.overall] || 0) + 1; });
  console.log('  输出SKU: ' + out.length);
  console.log('  状态分布: ' + JSON.stringify(counts));

  D.skuHealth = {
    generatedAt: today0,
    windows: coverage.windows,
    coverage,
    counts,
    rows: out,
  };
  fs.writeFileSync(DATA_PATH, JSON.stringify(D, null, 2), 'utf8');
  console.log('\n写入: ' + DATA_PATH);
  console.log('完成');
})().catch(e => { console.error('FATAL', e.message, e.stack && e.stack.slice(0, 400)); process.exit(1); });
