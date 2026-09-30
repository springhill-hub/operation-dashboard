/* ============================================================
 * 春山户外 · 跨境经营看板数据构建脚本（v1.1 · 2026-09-30）
 * ------------------------------------------------------------
 * 数据源：领星 ERP MCP HTTP 端点（X-Mcp-Key 鉴权，无需 IP 白名单）
 * 拉取：get_profit_report_msku（MSKU 利润报表，结算口径）
 * 拉取：asinDailyLists（REST API，下单口径销量，需 IP 白名单）
 *
 * 6 个周期：
 *   today      T-1          （昨日单日，对应"今日"看板）
 *   yesterday  T-2          （前日单日）
 *   week       [T-7, T-1]   （最近7天）
 *   lastWeek   [T-14, T-8]  （上周7天）
 *   month      [月初, T-1]  （本月累计）
 *   lastMonth  [上月1日, 上月末]  （上月整月）
 *
 * 平台分组（按 storeName）：
 *   日本-亚马逊  → amazonJP
 *   美国-亚马逊  → amazonUS
 *   其他店铺    → settlement 子对象（首版不动，由各平台 build-*.js 维护）
 *
 * 字段映射（领星 → operation_data）：
 *   msku, itemName, smallImageUrl, totalSalesQuantity, refundsQuantity
 *   totalSalesAmount, totalSalesTax  → salesAmt, tax, net=salesAmt-tax
 *   totalCost（商品成本）
 *   platformFee（已含 commission+fbaDeliv+storage+ads+other）
 *     ↳ 反推 commission = platformFee - fbaDeliv - storage - ads - other
 *   fbaDeliveryFee/totalFbaDeliveryFee → fbaDeliv
 *   totalStorageFee/fbaStorageFee    → storage
 *   totalAdsCost                      → ads
 *   sharedSubscriptionFee            → other
 *   grossProfit（领星已计算）           → profit (skuDetail)
 *   platformIncome（用于 gp 汇总）
 *
 * gp = sum(platformIncome) + sum(platExp) + sum(totalCost)
 * margin = gp / net * 100
 *
 * 下单口径销量（v1.1 新增）：
 *   REST API /erp/sc/data/sales_report/asinDailyLists
 *   type=2 销量, asin_type=2 MSKU维度
 *   按 event_date 逐日查询，聚合到 period 范围
 *   合并到 skuDetail.orderQty 字段
 *
 * 运行：node build-crossborder.js
 *   --periods=today,yesterday,week,lastWeek,month,lastMonth  指定周期
 *   --dryRun         只打印不写文件
 *   --skipMeta       不刷新 meta（汇率等）
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { getProfitReport } = require('../lx_api.js');

// ---------- 参数 ----------
const argv = {};
process.argv.slice(2).forEach(a => {
    if (!a.startsWith('--')) return;
    const body = a.slice(2);
    const i = body.indexOf('=');
    if (i < 0) argv[body] = true;
    else argv[body.slice(0, i)] = body.slice(i + 1);
});
const PERIODS = (argv.periods || 'today,yesterday,week,lastWeek,month,lastMonth').split(',');
const DRY_RUN = !!argv.dryRun;
const SKIP_META = !!argv.skipMeta;
const DATA_PATH = argv.dataPath ? path.resolve(argv.dataPath) : 'f:/ai agent/operation_data.json';

// ---------- 领星 REST API（下单口径销量，需IP白名单） ----------
const LX_APP_ID = 'ak_M7HmqeOuHZaKM';
const LX_APP_SECRET = 'iDyoq2lp49+ksuSqmpMQiQ==';
let _lxToken = null;
let _lxTokenAt = 0;

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

function lxRequest(method, apiPath, queryObj, bodyObj) {
    return new Promise((resolve, reject) => {
        const qs = Object.entries(queryObj).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        const body = bodyObj ? JSON.stringify(bodyObj) : '';
        const headers = method === 'GET' ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        const req = https.request({
            hostname: 'openapi.lingxing.com', path: `${apiPath}?${qs}`, method, headers, timeout: 60000
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ code: -1, message: 'parse error', raw: d.slice(0, 200) }); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

async function lxGetToken() {
    // token 有效期2小时，缓存复用
    if (_lxToken && Date.now() - _lxTokenAt < 100 * 60 * 1000) return _lxToken;
    const qs = `appId=${encodeURIComponent(LX_APP_ID)}&appSecret=${encodeURIComponent(LX_APP_SECRET)}`;
    const j = await new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'openapi.lingxing.com', path: `/api/auth-server/oauth/access-token?${qs}`,
            method: 'POST', headers: { 'Content-Length': 0 }, timeout: 20000
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 200))); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
    if (!j.data || !j.data.access_token) throw new Error('领星REST token失败: ' + JSON.stringify(j).slice(0, 200));
    _lxToken = j.data.access_token;
    _lxTokenAt = Date.now();
    return _lxToken;
}

async function lxCallApi(method, apiPath, bizParams) {
    const token = await lxGetToken();
    const ts = Math.floor(Date.now() / 1000).toString();
    const base = { access_token: token, app_key: LX_APP_ID, timestamp: ts };
    const sign = lxSign(Object.assign({}, base, bizParams), LX_APP_ID);
    const query = Object.assign({}, base, { sign });
    if (method === 'GET') return lxRequest('GET', apiPath, Object.assign({}, query, bizParams), null);
    return lxRequest('POST', apiPath, query, bizParams);
}

// 拉单日单店 MSKU 下单量：返回 { msku: qty }
async function fetchOrderQtyOneDay(sid, dateStr) {
    const r = await lxCallApi('POST', '/erp/sc/data/sales_report/asinDailyLists', {
        sid, event_date: dateStr, asin_type: 2, type: 2, offset: 0, length: 1000
    });
    if (r.code !== 0) throw new Error(`asinDailyLists ${dateStr} sid=${sid}: code=${r.code} ${r.message || ''}`);
    const map = {};
    for (const x of (r.data || [])) {
        if (!x.seller_sku) continue;
        const q = Number(x.map_value) || 0;
        map[x.seller_sku] = (map[x.seller_sku] || 0) + q;
    }
    return map;
}

// 拉日期范围内的下单量：{ storeKey: { msku: qty } }，storeKey=amazonJP/amazonUS
async function fetchOrderQtyRange(startDate, endDate) {
    // 店铺sid映射（与店铺名前缀对应）
    const SIDS = [
        { sid: 3118, key: 'amazonJP' },
        // 美国亚马逊已停用
        // { sid: 3116, key: 'amazonUS' },
    ];
    const result = { amazonJP: {}, amazonUS: {} };
    // 逐日循环
    let d = startDate;
    while (d <= endDate) {
        for (const { sid, key } of SIDS) {
            const map = await fetchOrderQtyOneDay(sid, d);
            for (const [msku, q] of Object.entries(map)) {
                result[key][msku] = (result[key][msku] || 0) + q;
            }
        }
        d = dateAdd(d, 1);
    }
    return result;
}

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = v => Math.round(num(v) * 100) / 100;

// ---------- 日期工具 ----------
function dateAdd(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00+08:00');
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}
function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}
function monthStart(dateStr) {
    return dateStr.slice(0, 8) + '01';
}
function prevMonthRange(dateStr) {
    // 返回上个月的 [start, end]
    const d = new Date(dateStr + 'T00:00:00+08:00');
    d.setDate(1); // 切到本月1号
    d.setDate(0); // 上月末
    const end = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    d.setDate(1);
    const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    return [start, end];
}

// ---------- 计算各周期的日期范围 ----------
function getPeriodRange(period, today) {
    // today=T-0（系统今日），领星数据滞后1天，故数据止于 T-1
    const yesterday = dateAdd(today, -1);
    switch (period) {
        case 'today':     return [yesterday, yesterday];
        case 'yesterday': return [dateAdd(today, -2), dateAdd(today, -2)];
        case 'week':     return [dateAdd(today, -7), yesterday];
        case 'lastWeek': return [dateAdd(today, -14), dateAdd(today, -8)];
        case 'month':    return [monthStart(yesterday), yesterday];
        case 'lastMonth':return prevMonthRange(yesterday);
        default: throw new Error('未知 period: ' + period);
    }
}

// ---------- 单平台聚合 ----------
function aggregatePlatform(records) {
    if (!records.length) {
        return { skuCount: 0, qty: 0, refQty: 0, salesAmt: 0, tax: 0, net: 0,
                 cost: 0, commission: 0, fbaDeliv: 0, storage: 0, ads: 0,
                 other: 0, platExp: 0, gp: 0, margin: 0, skuDetail: [] };
    }
    let qty = 0, refQty = 0, salesAmt = 0, tax = 0, cost = 0;
    let fbaDeliv = 0, storage = 0, ads = 0, other = 0;
    let commissionSum = 0; // 扣点（领星 platformFee 字段，仅扣点不含其他费用）
    let grossProfitSum = 0; // gp = sum(领星 grossProfit)
    const skuMap = new Map();

    for (const r of records) {
        const msku = r.msku || '(unknown)';
        const rowQty = num(r.totalSalesQuantity);
        const rowSales = num(r.totalSalesAmount);
        const rowTax = num(r.totalSalesTax);
        const rowCost = num(r.totalCost);
        // 字段映射（与现有 operation_data 口径一致）：
        //   fbaDeliv = sum(fbaDeliveryFee 或 totalFbaDeliveryFee)
        //   storage  = sum(totalStorageFee)  ※ 与领星后台 UI"总仓储费"列对齐（v1.4.2 修正：原 fbaStorageFee+longTermStorageFee 漏算 shared 等导致偏低）
        //   ads     = sum(totalAdsCost)
        //   other   = sum(sharedSubscriptionFee)
        //   commission = sum(platformFee) ※ 领星 platformFee 仅扣点（不含派送/仓储/广告/其他）
        //   platExp  = commission + fbaDeliv + storage + ads + other（计算得出，非直接取 platformExpense）
        //   gp       = sum(grossProfit)（领星已计算，= platformIncome + totalCost + platformExpense）
        const rowFbaDeliv = num(r.totalFbaDeliveryFee) || num(r.fbaDeliveryFee);
        const rowStorage = num(r.totalStorageFee);
        const rowAds = num(r.totalAdsCost);
        const rowOther = num(r.sharedSubscriptionFee);
        const rowCommission = num(r.platformFee);
        const rowGrossProfit = num(r.grossProfit);

        qty += rowQty;
        refQty += num(r.refundsQuantity);
        salesAmt += rowSales;
        tax += rowTax;
        cost += rowCost;
        fbaDeliv += rowFbaDeliv;
        storage += rowStorage;
        ads += rowAds;
        other += rowOther;
        commissionSum += rowCommission;
        grossProfitSum += rowGrossProfit;

        if (!skuMap.has(msku)) {
            skuMap.set(msku, {
                msku,
                name: r.localName || '',
                qty: rowQty,
                net: r2(rowSales - rowTax),
                cost: r2(rowCost),
                platformFee: r2(rowCommission), // skuDetail 的 platformFee = 扣点（与现有数据一致）
                profit: r2(rowGrossProfit),
                margin: rowSales - rowTax > 0 ? r2(rowGrossProfit / (rowSales - rowTax) * 100) : 0,
                img: r.smallImageUrl || ''
            });
        } else {
            // 同 MSKU 多条记录（容错合并）
            const ex = skuMap.get(msku);
            ex.qty += rowQty;
            ex.net = r2(ex.net + rowSales - rowTax);
            ex.cost = r2(ex.cost + rowCost);
            ex.platformFee = r2(ex.platformFee + rowCommission);
            ex.profit = r2(ex.profit + rowGrossProfit);
            ex.margin = ex.net > 0 ? r2(ex.profit / ex.net * 100) : 0;
        }
    }

    const net = salesAmt - tax;
    const platExp = commissionSum + fbaDeliv + storage + ads + other;
    const gp = grossProfitSum;
    const margin = net > 0 ? r2(gp / net * 100) : 0;

    // skuDetail 按 net 降序
    const skuDetail = [...skuMap.values()].sort((a, b) => b.net - a.net);
    // pct: 每个 SKU 占总 net 的比例
    for (const s of skuDetail) {
        s.pct = net > 0 ? r2(s.net / net * 100) : 0;
    }

    return {
        skuCount: skuMap.size,
        qty, refQty,
        salesAmt: r2(salesAmt),
        tax: r2(tax),
        net: r2(net),
        cost: r2(cost),
        commission: r2(commissionSum),
        fbaDeliv: r2(fbaDeliv),
        storage: r2(storage),
        ads: r2(ads),
        other: r2(other),
        platExp: r2(platExp),
        gp: r2(gp),
        margin,
        skuDetail
    };
}

// ---------- 主流程 ----------
(async () => {
    const today = todayStr();
    console.log('====================================================');
    console.log('  build-crossborder | today=' + today + (DRY_RUN ? ' | DRY RUN' : ''));
    console.log('====================================================');

    // 读 operation_data
    const D = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

    // 更新 meta
    if (!SKIP_META) {
        D.meta.generatedAt = today;
        // 汇率: 留现有值（如需自动拉取汇率，见 fx-fetcher.js）
        console.log('  meta.generatedAt = ' + today);
    }

    // 拉每个周期的数据
    for (const period of PERIODS) {
        const [start, end] = getPeriodRange(period, today);
        console.log(`\n[${period}] ${start} ~ ${end}`);

        const t0 = Date.now();
        const { records, total, pages } = await getProfitReport({
            startDate: start, endDate: end, isMonthly: false, pageSize: 200,
            dateType: 'shipDate' // v1.4.2: 切到发货日期口径，与王泉斐 9/28 领星后台 UI 切换一致
        });
        console.log(`  拉取 ${records.length} 条（total=${total}, pages=${pages}） · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

        // 按 storeName 分组（归一化：去首尾空白 + 不可见字符）
        const byStore = {};
        for (const r of records) {
            const raw = r.storeName || '(unknown)';
            // 归一化：trim + 去掉零宽字符/BOM
            const s = raw.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
            if (!byStore[s]) byStore[s] = [];
            byStore[s].push(r);
        }
        console.log('  店铺分布: ' + Object.entries(byStore).map(([s, rs]) => `${s}=${rs.length}`).join(', '));

        // 初始化 period
        if (!D[period]) D[period] = {};
        const P = D[period];

        // 写入 range / date
        if (period === 'today' || period === 'yesterday') {
            P.date = end;
        } else {
            P.range = `${start} ~ ${end}`;
        }

        // amazonJP / amazonUS - 按前缀匹配（防止编码/空格差异导致漏分桶）
        const storeMatchers = [
            { prefix: '日本-亚马逊', key: 'amazonJP' },
            { prefix: '美国-亚马逊', key: 'amazonUS' },
        ];
        for (const { prefix, key } of storeMatchers) {
            const matched = Object.keys(byStore)
                .filter(s => s.startsWith(prefix) || s.includes(prefix))
                .flatMap(s => byStore[s]);
            const agg = aggregatePlatform(matched);
            P[key] = agg;
            console.log(`  ${key}: skuCount=${agg.skuCount} qty=${agg.qty} net=${agg.net} gp=${agg.gp} margin=${agg.margin}%`);
        }

        // ===== 下单口径销量（REST API，逐日聚合），合并到 skuDetail.orderQty =====
        try {
            const t1 = Date.now();
            const orderQty = await fetchOrderQtyRange(start, end);
            for (const key of ['amazonJP', 'amazonUS']) {
                const agg = P[key];
                if (!agg) continue;
                const map = orderQty[key] || {};
                // 合并到已有 skuDetail
                const seen = new Set();
                for (const s of agg.skuDetail) {
                    s.orderQty = map[s.msku] || 0;
                    seen.add(s.msku);
                }
                // 有下单但无结算的 SKU（未结算订单），补一行只有 orderQty 的记录
                for (const [msku, q] of Object.entries(map)) {
                    if (!seen.has(msku)) {
                        agg.skuDetail.push({
                            msku, name: '', qty: 0, net: 0, cost: 0, platformFee: 0,
                            profit: 0, margin: 0, img: '', pct: 0, orderQty: q
                        });
                    }
                }
                const totalOrderQty = Object.values(map).reduce((a, b) => a + b, 0);
                console.log(`  ${key} 下单口径: 总下单量=${totalOrderQty}（${Object.keys(map).length}个MSKU）`);
            }
            console.log(`  下单量拉取耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
        } catch (e) {
            // REST失败（如IP白名单失效）不阻断主流程
            console.log('  [警告] 下单口径拉取失败: ' + e.message);
        }

        // 其他平台（Rakuten/Shopee/Coupang）保留 settlement 子对象，由各 build-*.js 维护
        // （如需将来从领星 MCP 拉取，可在这里扩展）
    }

    // 写回文件
    if (DRY_RUN) {
        console.log('\n[DRY RUN] 不写文件');
        // 打印摘要
        for (const period of PERIODS) {
            const p = D[period];
            if (!p) continue;
            console.log(`\n=== ${period} ===`);
            if (p.date) console.log('date:', p.date);
            if (p.range) console.log('range:', p.range);
            for (const k of ['amazonJP', 'amazonUS']) {
                if (p[k]) console.log(`${k}: gp=${p[k].gp} margin=${p[k].margin}%`);
            }
        }
    } else {
        fs.writeFileSync(DATA_PATH, JSON.stringify(D, null, 2), 'utf8');
        console.log('\n写入: ' + DATA_PATH);
    }
    console.log('\n完成');
})().catch(e => {
    console.error('FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
});
