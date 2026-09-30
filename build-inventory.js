/* ============================================================
 * 春山户外 · 库存管理看板数据构建脚本（v2.0 · 2026-09-30）
 * ------------------------------------------------------------
 * 数据源：
 *   1. 领星 REST API（FBA库存 + 海外仓库存 + 跨境本地仓库存）
 *   2. 聚水潭 OpenAPI（总仓库存）
 *
 * 接口：
 *   FBA:     /cost/center/openApi/fba/gather/query  （汇总）
 *            /cost/center/openApi/fba/detail/query    （明细）
 *   海外仓:  /inventory/center/openapi/storageReport/overseas/aggregate/list
 *            /inventory/center/openapi/storageReport/overseas/detail/page
 *   跨境仓:  /inventory/center/openapi/storageReport/local/detail/page
 *   总仓:    /open/inventory/query（聚水潭）
 *
 * 输出：inventory_data.json
 * ============================================================ */
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const { callApi: jstCall } = require('../jst_api.js');

const APP_ID = 'ak_M7HmqeOuHZaKM';
const APP_SECRET = 'iDyoq2lp49+ksuSqmpMQiQ==';
const OUT_PATH = 'f:/ai agent/inventory_data.json';

let _token = null, _tokenAt = 0;
const SELLERS = [
    { sid: 3118, seller_id: 'ADIYJW0UXJYNU', name: '日本-亚马逊', key: 'amazonJP', country: 'JP' },
    // 美国亚马逊已停用，从领星后台删除
    // { sid: 3116, seller_id: 'A3WVG9GU455RD', name: '美国-亚马逊', key: 'amazonUS', country: 'US' },
];

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
            method: 'POST', headers: { 'Content-Length': 0 }, timeout: 20000
        }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d).data.access_token); } catch (e) { reject(new Error(d.slice(0, 200))); } });
        });
        req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
    _tokenAt = Date.now();
    return _token;
}

async function callApi(apiPath, bizParams) {
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
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 60000
        }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ code: -1, raw: d.slice(0, 300) }); } });
        });
        req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body); req.end();
    });
}

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = v => Math.round(num(v) * 100) / 100;

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function monthStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function lastMonthStr() {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

(async () => {
    const today = todayStr();
    const thisMonth = monthStr();
    const lastMonth = lastMonthStr();
    const sellerIds = SELLERS.map(s => s.seller_id);

    console.log('====================================================');
    console.log('  build-inventory | today=' + today + ' month=' + thisMonth);
    console.log('====================================================');

    const D = { meta: { generatedAt: today, source: '领星ERP REST API' }, fba: {}, overseas: {} };

    // ===== 1. FBA新版汇总（本月）=====
    console.log('\n[FBA汇总] 月份=' + thisMonth);
    {
        const r = await callApi('/cost/center/openApi/fba/gather/query', {
            offset: 0, length: 50,
            seller_id: sellerIds,
            start_date: thisMonth, end_date: thisMonth
        });
        if (r.code === 0 && r.data) {
            const rows = r.data.row_data || [];
            console.log('  返回 ' + rows.length + ' 条汇总');
            for (const row of rows) {
                // FBA汇总用 sid 字段匹配店铺（不是 seller_id）
                const seller = SELLERS.find(s => s.sid === row.sid);
                // 跳过全0的空行
                if (num(row.end_count) === 0 && num(row.end_total_amount) === 0 && num(row.receipts_count) === 0) continue;
                const key = seller ? seller.key : ('sid_' + row.sid);
                D.fba[key] = {
                    sid: row.sid,
                    sellerId: seller ? seller.seller_id : '',
                    storeName: seller ? seller.name : (row.ware_house_name || ('sid_' + row.sid)),
                    country: seller ? seller.country : '',
                    // 期末库存
                    endCount: num(row.end_count || 0),
                    endAmount: r2(row.end_total_amount || 0),
                    // 期末在途
                    endOnWayCount: num(row.end_on_way_count || 0),
                    endOnWayAmount: r2(row.end_on_way_logistic_amount || 0),
                    // 期初库存
                    startCount: num(row.start_count || 0),
                    startAmount: r2(row.start_total_amount || 0),
                    // 入库
                    receiptsCount: num(row.receipts_count || 0),
                    // 发货
                    shipmentsCount: num(row.shipments_count || 0),
                    // 调拨出库
                    transferOutCount: num(row.transferring_out_count || 0),
                    // 仓库调拨
                    whseTransfersCount: num(row.whse_transfers_count || 0),
                    // 买家退货
                    customerReturnsCount: num(row.customer_returns_count || 0),
                    // 残损
                    damagedCount: num(row.damaged_count || 0),
                    // 丢失
                    lostCount: num(row.lost_count || 0),
                    // 盘盈
                    foundCount: num(row.found_count || 0),
                    // 丢弃
                    disposedCount: num(row.disposed_count || 0),
                    // 差异
                    differenceCount: num(row.difference_count || 0),
                    // 供应商退货
                    vendorReturnsCount: num(row.vendor_returns_count || 0),
                    // 周转
                    turnoverDays: r2(row.inventory_turnover_days || 0),
                    turnoverRate: r2(row.inventory_turnover_rate || 0),
                    stockToUseRate: r2(row.stock_to_use_rate || 0),
                };
                const f = D.fba[key];
                console.log(`  ${f.storeName}: 期初=${f.startCount} 期末=${f.endCount}件 ¥${f.endAmount} 在途=${f.endOnWayCount} 入库=${f.receiptsCount} 发货=${f.shipmentsCount} 周转天=${f.turnoverDays}`);
            }
        } else {
            console.log('  FAIL:', r.code, r.msg || r.message || '');
        }
    }

    // ===== 2. FBA新版明细（本月）=====
    console.log('\n[FBA明细] 月份=' + thisMonth);
    {
        const r = await callApi('/cost/center/openApi/fba/detail/query', {
            offset: 0, length: 500,
            seller_id: sellerIds,
            start_date: thisMonth, end_date: thisMonth
        });
        if (r.code === 0 && r.data) {
            const rows = r.data.row_data || r.data.list || r.data.records || [];
            console.log('  返回 ' + rows.length + ' 条明细');
            for (const seller of SELLERS) {
                const skuList = rows.filter(x => x.seller_id === seller.seller_id);
                if (!skuList.length) continue;
                const key = seller.key;
                if (!D.fba[key]) D.fba[key] = { sellerId: seller.seller_id, storeName: seller.name, country: seller.country };
                D.fba[key].skuDetail = skuList.map(x => ({
                    fnsku: x.fnsku || '',
                    asin: x.asin || '',
                    msku: x.seller_sku || x.msku || '',
                    // 领星FBA明细不返回product_name，中文品名在 local_name，对应本地SKU在 local_sku
                    localSku: x.local_sku || '',
                    productName: x.local_name || x.product_name || '',
                    endCount: num(x.end_count || 0),
                    endAmount: r2(x.end_total_amount || 0),
                    endOnWayCount: num(x.end_on_way_count || 0),
                    receiptsCount: num(x.receipts_count || 0),
                    customerReturnsCount: num(x.customer_returns_count || 0),
                    damagedCount: num(x.damaged_count || 0),
                    lostCount: num(x.lost_count || 0),
                    foundCount: num(x.found_count || 0),
                    disposedCount: num(x.disposed_count || 0),
                    differenceCount: num(x.difference_count || 0),
                    brandName: x.brand_name || '',
                    category: x.product_category_name || '',
                })).sort((a, b) => b.endAmount - a.endAmount);
                console.log(`  ${seller.name}: ${skuList.length} 个SKU`);
                // 打印前5
                D.fba[key].skuDetail.slice(0, 5).forEach(s =>
                    console.log(`    ${s.msku || s.fnsku} 期末=${s.endCount}件 ¥${s.endAmount} 在途=${s.endOnWayCount}`)
                );
            }
        } else {
            console.log('  FAIL:', r.code, r.msg || r.message || '');
        }
    }

    // ===== 3. 海外仓汇总 =====
    console.log('\n[海外仓汇总]');
    {
        const r = await callApi('/inventory/center/openapi/storageReport/overseas/aggregate/list', {
            start_date: lastMonthStr() + '-01', end_date: today
        });
        if (r.code === 0) {
            const rows = r.data || [];
            console.log('  返回 ' + rows.length + ' 条');
            D.overseas.summary = rows.map(x => ({
                warehouseName: x.ware_house_name || '',
                warehouseType: x.ware_house_type || '',
                productCount: num(x.product_count || 0),
                dayEarlyCount: num(x.day_early_count || 0),
                dayEndCount: num(x.day_end_count || 0),
                dayEarlyCost: r2(x.day_early_cost || 0),
                dayEndCost: r2(x.day_end_cost || 0),
                allocationInTransitCount: num(x.allocation_in_transit_count || 0),
                allocationInTransitCost: r2(x.allocation_in_transit_cost || 0),
                purchaseInCount: num(x.purchase_in_count || 0),
                allocationOutCount: num(x.allocation_out_count || 0),
                fbaOutCount: num(x.fba_out_count || 0),
                fbmOutCount: num(x.fbm_out_count || 0),
                returnGoodsInCount: num(x.return_goods_in_count || 0),
                rotationDayCost: r2(x.rotation_day_cost || 0),
                sysWid: x.sys_wid || 0,
            }));
            D.overseas.summary.forEach(x =>
                console.log(`  ${x.warehouseName} 期初=${x.dayEarlyCount} 期末=${x.dayEndCount} 在途=${x.allocationInTransitCount} 周转天=${x.rotationDayCost}`)
            );
        } else {
            console.log('  FAIL:', r.code, r.message || r.msg || '');
        }
    }

    // ===== 4. 海外仓明细 =====
    console.log('\n[海外仓明细]');
    {
        const r = await callApi('/inventory/center/openapi/storageReport/overseas/detail/page', {
            start_date: lastMonthStr() + '-01', end_date: today, page: 1, size: 500
        });
        if (r.code === 0) {
            const rows = r.data || [];
            console.log('  返回 ' + rows.length + ' 条');
            D.overseas.skuDetail = rows.map(x => ({
                warehouseName: x.ware_house_name || '',
                sku: x.sku || '',
                spu: x.spu || '',
                productName: x.product_name || '',
                brand: x.brand || '',
                dayEarlyCount: num(x.day_early_count || 0),
                dayEndCount: num(x.day_end_count || 0),
                dayEarlyCost: r2(x.day_early_cost || 0),
                dayEndCost: r2(x.day_end_cost || 0),
                allocationInTransitCount: num(x.allocation_in_transit_count || 0),
                purchaseInCount: num(x.purchase_in_count || 0),
                allocationOutCount: num(x.allocation_out_count || 0),
                fbaOutCount: num(x.fba_out_count || 0),
                returnGoodsInCount: num(x.return_goods_in_count || 0),
                rotationDayCount: r2(x.rotation_day_count || 0),
                category1: x.category1 || '',
                category2: x.category2 || '',
            })).sort((a, b) => b.dayEndCount - a.dayEndCount);
            D.overseas.skuDetail.slice(0, 5).forEach(x =>
                console.log(`  [${x.warehouseName}] ${x.sku} 期末=${x.dayEndCount} 在途=${x.allocationInTransitCount} 周转天=${x.rotationDayCount}`)
            );
        } else {
            console.log('  FAIL:', r.code, r.message || r.msg || '');
        }
    }

    // ===== 5. 聚水潭总仓库存 =====
    console.log('\n[聚水潭总仓库存]');
    {
        const now = new Date();
        const end = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} 23:59:59`;
        const sd = new Date(now); sd.setDate(sd.getDate() - 6);
        const start = `${sd.getFullYear()}-${String(sd.getMonth()+1).padStart(2,'0')}-${String(sd.getDate()).padStart(2,'0')} 00:00:00`;

        const jstMap = new Map();
        let page = 1;
        while (true) {
            const r = await jstCall('/open/inventory/query', {
                page_index: page, page_size: 100,
                modified_begin: start, modified_end: end,
            });
            const j = JSON.parse(r);
            if (j.code !== 0) { console.log('  第', page, '页失败:', j.msg); break; }
            const invs = (j.data && j.data.inventorys) || [];
            if (!invs.length) break;
            for (const x of invs) {
                jstMap.set(x.sku_id, {
                    sku: x.sku_id,
                    name: x.name || '',
                    qty: num(x.qty),
                    orderLock: num(x.order_lock),
                    purchaseQty: num(x.purchase_qty),
                    virtualQty: num(x.virtual_qty),
                    available: num(x.qty) - num(x.order_lock),
                });
            }
            if (invs.length < 100) break;
            page++;
        }

        let totalQty = 0, totalAvailable = 0, totalPurchase = 0, withStock = 0;
        const skuList = [];
        for (const v of jstMap.values()) {
            totalQty += v.qty;
            totalAvailable += v.available;
            totalPurchase += v.purchaseQty;
            if (v.qty > 0) withStock++;
            skuList.push(v);
        }
        skuList.sort((a, b) => b.qty - a.qty);

        D.jst = {
            skuCount: jstMap.size,
            withStock,
            totalQty,
            totalAvailable,
            totalPurchase,
            skuDetail: skuList,
        };
        console.log(`  SKU数: ${jstMap.size}, 有库存: ${withStock}`);
        console.log(`  总库存: ${totalQty} 件, 可用: ${totalAvailable} 件, 采购在途: ${totalPurchase} 件`);
        skuList.slice(0, 5).forEach(s => console.log(`    ${s.sku} ${s.name} 库存=${s.qty} 可用=${s.available} 在途=${s.purchaseQty}`));
    }

    // ===== 6. 领星跨境仓（本地仓）库存 =====
    console.log('\n[领星跨境仓库存]');
    {
        const localMap = new Map();
        let p = 1;
        while (true) {
            const r = await callApi('/inventory/center/openapi/storageReport/local/detail/page', {
                start_date: lastMonthStr() + '-01', end_date: today, page: p, size: 100
            });
            if (r.code !== 0 || !r.data || r.data.length === 0) break;
            for (const x of r.data) {
                const sku = x.sku || x.api_sku || x.spu;
                if (!sku) continue;
                if (!localMap.has(sku)) {
                    localMap.set(sku, {
                        sku, name: x.product_name || '',
                        dayEndCount: 0, allocationInTransitCount: 0,
                        purchaseInCount: 0, fbaOutCount: 0, warehouses: []
                    });
                }
                const o = localMap.get(sku);
                o.dayEndCount += num(x.day_end_count);
                o.allocationInTransitCount += num(x.allocation_in_transit_count);
                o.purchaseInCount += num(x.purchase_in_count);
                o.fbaOutCount += num(x.fba_out_count);
                if (x.ware_house_name) o.warehouses.push(x.ware_house_name);
            }
            if (r.data.length < 100) break;
            p++;
        }
        let totalQty = 0;
        const skuList = [...localMap.values()].filter(x => x.dayEndCount > 0).sort((a, b) => b.dayEndCount - a.dayEndCount);
        for (const x of skuList) totalQty += x.dayEndCount;
        D.crossBorder = {
            skuCount: localMap.size,
            withStock: skuList.length,
            totalQty,
            skuDetail: skuList.map(x => ({
                sku: x.sku, name: x.name,
                dayEndCount: x.dayEndCount,
                allocationInTransitCount: x.allocationInTransitCount,
                purchaseInCount: x.purchaseInCount,
                fbaOutCount: x.fbaOutCount,
                warehouses: [...new Set(x.warehouses)],
            })),
        };
        console.log(`  SKU数: ${localMap.size}, 有库存: ${skuList.length}, 总库存: ${totalQty} 件`);
        skuList.slice(0, 5).forEach(s => console.log(`    ${s.sku} ${s.name} 期末=${s.dayEndCount} 仓=[${s.warehouses.join(',')}]`));
    }

    // ===== 7. 云端总仓：按SKU合并所有库存 + 本月销售 + 周转率 =====
    console.log('\n[云端总仓合并]');
    {
        // 按SKU聚合：聚水潭(qty) + 跨境仓(dayEndCount) + FBA(endCount) + 海外仓(dayEndCount) + 在途
        const cloudMap = new Map(); // sku -> {sku, name, jstQty, localQty, fbaQty, overseasQty, inTransitQty, cloudQty, salesQty}

        const addSku = (sku, name) => {
            if (!sku) return null;
            if (!cloudMap.has(sku)) cloudMap.set(sku, { sku, name: name || '', jstQty: 0, localQty: 0, fbaQty: 0, overseasQty: 0, inTransitQty: 0 });
            return cloudMap.get(sku);
        };

        // 聚水潭（从 D.jst.skuDetail 读取）
        for (const v of (D.jst.skuDetail || [])) {
            const o = addSku(v.sku, v.name);
            o.jstQty = v.qty;
            o.inTransitQty += v.purchaseQty;
        }
        // 跨境仓（从 D.crossBorder.skuDetail 读取）
        for (const x of (D.crossBorder.skuDetail || [])) {
            const o = addSku(x.sku, x.name);
            o.localQty = x.dayEndCount;
            o.inTransitQty += x.allocationInTransitCount;
        }
        // FBA（品名取 local_name）
        const fbaSkuMap = new Map();
        {
            const r = await callApi('/cost/center/openApi/fba/detail/query', {
                offset: 0, length: 500,
                seller_id: SELLERS.map(s => s.seller_id),
                start_date: thisMonth, end_date: thisMonth
            });
            if (r.code === 0 && r.data) {
                for (const x of (r.data.row_data || [])) {
                    const sku = x.seller_sku || x.msku || x.fnsku;
                    if (!sku) continue;
                    const prev = fbaSkuMap.get(sku);
                    fbaSkuMap.set(sku, { qty: (prev ? prev.qty : 0) + num(x.end_count), name: x.local_name || '' });
                }
            }
        }
        for (const [sku, info] of fbaSkuMap) {
            const o = addSku(sku, info.name);
            o.fbaQty = info.qty;
            if (!o.name && info.name) o.name = info.name;
        }
        // 海外仓
        for (const x of (D.overseas.skuDetail || [])) {
            const o = addSku(x.sku, x.productName);
            o.overseasQty = x.dayEndCount;
            o.inTransitQty += x.allocationInTransitCount;
        }

        // 计算云端总仓库存
        let totalCloudQty = 0, totalInTransit = 0;
        for (const v of cloudMap.values()) {
            v.cloudQty = v.jstQty + v.localQty + v.fbaQty + v.overseasQty; // 现货库存
            totalCloudQty += v.cloudQty;
            totalInTransit += v.inTransitQty;
        }

        // 拉取本月销售数据
        console.log('  拉取本月销售数据...');
        const monthStartDate = today.slice(0, 8) + '01';
        const salesMap = new Map(); // sku -> qty

        // 聚水潭订单（国内）- 按7天分片拉取，每片内分页
        {
            const monthStart = new Date(monthStartDate + 'T00:00:00+08:00');
            const todayEnd = new Date(today + 'T23:59:59+08:00');
            let orderCount = 0;
            let cur = new Date(monthStart);
            while (cur <= todayEnd) {
                const sliceEnd = new Date(cur);
                sliceEnd.setDate(sliceEnd.getDate() + 6);
                const end = sliceEnd > todayEnd ? todayEnd : sliceEnd;
                const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:00:00`;
                // 每个分片内分页
                let page = 1;
                while (true) {
                    const r = await jstCall('/open/orders/single/query', {
                        page_index: page, page_size: 100,
                        modified_begin: fmt(cur), modified_end: fmt(end),
                    });
                    const j = JSON.parse(r);
                    if (j.code !== 0 || !j.data || !j.data.orders || j.data.orders.length === 0) break;
                    for (const order of j.data.orders) {
                        if (order.items && Array.isArray(order.items)) {
                            for (const item of order.items) {
                                const sku = item.sku_id;
                                if (sku) salesMap.set(sku, (salesMap.get(sku) || 0) + num(item.qty));
                            }
                        }
                    }
                    orderCount += j.data.orders.length;
                    if (!j.data.has_next || j.data.orders.length < 100) break;
                    page++;
                    if (page > 80) break;
                }
                cur = new Date(end);
                cur.setDate(cur.getDate() + 1);
            }
            console.log(`    聚水潭订单: ${orderCount} 单, 涉及 ${salesMap.size} 个SKU`);
        }

        // 领星销量（跨境日亚）
        {
            const { getProfitReport } = require('../lx_api.js');
            const { records } = await getProfitReport({
                startDate: monthStartDate, endDate: today, isMonthly: false, pageSize: 500
            });
            for (const r of records) {
                if (r.storeName && r.storeName.includes('日本')) {
                    const sku = r.msku;
                    if (sku) salesMap.set(sku, (salesMap.get(sku) || 0) + num(r.totalSalesQuantity));
                }
            }
            console.log(`    领星日亚销量: ${records.length} 条记录`);
        }

        // 合并销售到云端总仓
        let totalSales = 0;
        for (const v of cloudMap.values()) {
            v.salesQty = salesMap.get(v.sku) || 0;
            totalSales += v.salesQty;
            // 周转率 = 现货库存 / 本月销售量（用户口径：库存可卖几个月）
            v.turnover = v.salesQty > 0 ? r2(v.cloudQty / v.salesQty) : (v.cloudQty > 0 ? 999 : 0);
            v.turnoverDays = v.salesQty > 0 ? r2(v.cloudQty / v.salesQty * 30) : (v.cloudQty > 0 ? 9999 : 0);
        }

        // 排序：按云端库存降序
        const skuList = [...cloudMap.values()].sort((a, b) => b.cloudQty - a.cloudQty);
        const withStock = skuList.filter(x => x.cloudQty > 0).length;

        D.cloudWarehouse = {
            skuCount: cloudMap.size,
            withStock,
            totalCloudQty,
            totalInTransit,
            totalSales,
            turnoverOverall: totalSales > 0 ? r2(totalCloudQty / totalSales) : 0,
            skuDetail: skuList,
        };
        console.log(`  云端总仓: ${cloudMap.size} SKU, 有库存 ${withStock}, 现货 ${totalCloudQty} 件, 在途 ${totalInTransit} 件`);
        console.log(`  本月销售: ${totalSales} 件, 整体周转率(月): ${D.cloudWarehouse.turnoverOverall}`);
        console.log('  Top 10:');
        skuList.slice(0, 10).forEach(s => console.log(`    ${s.sku} ${s.name.slice(0,15)} 现货=${s.cloudQty} 销售=${s.salesQty} 周转=${s.turnover}月`));
    }

    // 写文件
    fs.writeFileSync(OUT_PATH, JSON.stringify(D, null, 2), 'utf8');
    console.log('\n写入: ' + OUT_PATH);
    console.log('完成');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
