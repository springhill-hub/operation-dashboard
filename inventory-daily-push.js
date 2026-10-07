/**
 * 库存新增每日播报 · 聚水潭 → 飞书「春山户外」群
 *
 * 机制：
 *   1. 每次拉近 N 小时（默认24h）内 modified 的库存记录（/open/inventory/query 有权限）
 *   2. 维护本地状态库 state.json（键: 仓库i_id + sku_id → 最新qty/name）
 *      - 首期运行只建基线，不播报
 *      - 之后每期对比旧值，qty 净增加的 SKU 计入"库存新增"
 *   3. 口径C：成品 / 辅料 分两组，同一条消息播报到群
 *      - 辅料判定：仓库以 WL 开头（物料仓），或 SKU 名称以"物料"开头，或编码含 WL-
 *   4. 推送走飞书自建应用机器人（服务器 lark-cli，bot 身份），无需群 webhook
 *   5. 断货预警：负库存（过滤虚拟品）每期必报；库存"新跌破"阈值线（上期>线，本期<=线）才报，
 *      长期低库存不重复报，避免刷屏
 *   6. 采购生产动态：/open/purchase/query 有权限（7天窗口），对比上期快照——
 *      新增采购单（🏭 新下单）、到货状态变化（🚚 到货进展）
 *
 * 每日13点一条消息结构：
 *   🚨 断货预警 → 🏭🚚 采购动态 → 📦 库存新增（成品/辅料）
 *
 * 口径说明：
 *   - "新增"= qty 净增加（入库-出库抵消后的净值）。采购入库单接口(/open/purchasein/query)
 *     当前应用无权限；若后续开通，可升级为按真实入库单播报。
 *
 * 用法：
 *   node inventory-daily-push.js            # 正常执行（拉数→diff→按配置推送）
 *   node inventory-daily-push.js --dry-run  # 强制不推送，只生成报告
 *   node inventory-daily-push.js --baseline # 只重建基线，不播报
 *
 * 配置 inventory-push.json（已 gitignore，不入库）：
 *   pushMode         "lark"（默认，机器人）| "webhook"（备用）| "none"
 *   chatId           飞书群 chat_id（机器人须已在群内）
 *   webhookUrl       pushMode=webhook 时使用的群自定义机器人地址
 *   secret           webhook 加签 secret
 *   silentWhenEmpty  true=无净增加时不发群（默认 false，发一行"今日无新增"）
 *   lookbackHours    回溯小时数，默认 24
 *   minDelta         最小净增件数，低于不报，默认 1
 *   maxItems         每组最多列出条数（超出显示"等N项"），默认 30
 *   prefixBlacklist  SKU 前缀黑名单（如 ["DL"] 过滤虚拟商品）
 *   prefixWhitelist  前缀白名单；非空时只播报这些前缀
 *   skuWhitelist     SKU 精确白名单；非空时优先生效
 *   warehouseFilter  仓库(i_id)白名单；空=全部
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawnSync } = require('child_process');
const { callApi } = require(path.join(__dirname, '..', 'jst_api.js'));

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'inventory-snap');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUR_STATE_FILE = path.join(DATA_DIR, 'purchase-state.json');
const CFG_FILE = path.join(__dirname, 'inventory-push.json');

// 参数清洗：剔除管道传输可能混入的 \r（否则 --dry-run\r 匹配失败会导致测试误发群）
const args = new Set(process.argv.slice(2).map(a => String(a).replace(/\r/g, '')));
const DRY_RUN = args.has('--dry-run');
const BASELINE_ONLY = args.has('--baseline');

function loadConfig() {
    const defaults = {
        pushMode: 'lark',
        chatId: '',
        webhookUrl: '', secret: '',
        silentWhenEmpty: false,
        lookbackHours: 2160, minDelta: 1, maxItems: 30,
        prefixBlacklist: ['DL'], prefixWhitelist: [], skuWhitelist: [],
        warehouseFilter: [],
        lowStock: {
            enabled: true,
            defaultThreshold: 5,
            skuThresholds: {},
            excludeNameKeywords: ['处理品', '邮费'],
        },
        negativeStockAlert: true,
        purchaseAlert: true,
        // 群消息分块开关（报告始终全量落盘，便于随时查看和启用）
        pushSections: { alert: true, purchase: true, increase: true },
    };
    try {
        return Object.assign(defaults, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')));
    } catch (e) {
        console.log('[配置] inventory-push.json 不存在或解析失败，使用默认配置:', e.message);
        return defaults;
    }
}

function fmtTime(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callApiWithRetry(biz, label) {
    const waits = [3000, 6000, 12000, 20000];
    for (let i = 0; ; i++) {
        const r = JSON.parse(await callApi('/open/inventory/query', biz));
        if (r.code === 0) return r;
        if ((r.code === 199 || r.code === 189) && i < waits.length) {
            console.log(`[限流] ${label} code=${r.code}，${waits[i] / 1000}s 后重试（${i + 1}/${waits.length}）`);
            await sleep(waits[i]);
            continue;
        }
        throw new Error(`聚水潭接口错误 code=${r.code} msg=${r.msg}`);
    }
}

async function fetchSegment(segBegin, segEnd) {
    const out = [];
    let page = 1;
    while (page <= 50) {
        const r = await callApiWithRetry({
            page_index: page, page_size: 100,
            modified_begin: segBegin, modified_end: segEnd,
        }, `${segBegin} p${page}`);
        const invs = (r.data && r.data.inventorys) || [];
        out.push(...invs);
        if (!r.data.has_next || invs.length === 0) break;
        page++;
        await sleep(600); // 分页节流
    }
    return out;
}

// 聚水潭限制单次查询间隔 ≤7 天，自动按段切分；同键多段出现时保留 modified 最新者
async function fetchRecentChanges(begin, end) {
    const SEG_MS = 7 * 24 * 3600 * 1000 - 60 * 1000;
    const beginD = new Date(begin.replace(' ', 'T'));
    const endD = new Date(end.replace(' ', 'T'));
    const merged = new Map();
    for (let s = new Date(beginD); s < endD; s = new Date(s.getTime() + SEG_MS + 60 * 1000)) {
        const e = new Date(Math.min(s.getTime() + SEG_MS, endD.getTime()));
        const segBegin = fmtTime(s);
        const segEnd = fmtTime(e);
        const seg = await fetchSegment(segBegin, segEnd);
        console.log(`[拉数] 段 ${segBegin} ~ ${segEnd}：${seg.length} 条`);
        for (const x of seg) {
            const k = keyOf(x);
            const prev = merged.get(k);
            if (!prev || String(x.modified) > String(prev.modified)) merged.set(k, x);
        }
        await sleep(1000); // 分节节流
    }
    return [...merged.values()];
}

function keyOf(x) { return `${x.i_id}||${x.sku_id}`; }

// 口径C：辅料判定（物料仓 WL-* / 名称"物料"开头 / 编码含 WL-）
function isMaterial(x) {
    return String(x.i_id || '').startsWith('WL')
        || String(x.name || '').startsWith('物料')
        || String(x.sku_id || '').includes('WL-');
}

// 断货预警排除：虚拟品（DL-）、邮费链接、处理品等不入预警
function isExcludedForAlert(x, cfg) {
    const name = String(x.name || '');
    const sku = String(x.sku_id || '');
    const ex = (cfg.lowStock && cfg.lowStock.excludeNameKeywords) || ['处理品', '邮费'];
    if (cfg.prefixBlacklist.some(p => sku.startsWith(p))) return true;
    if (ex.some(k => name.includes(k))) return true;
    return false;
}

// 低库存阈值：SKU 专属优先，否则默认
function thresholdFor(sku, cfg) {
    const ls = cfg.lowStock || {};
    const map = ls.skuThresholds || {};
    if (map[sku] !== undefined) return Number(map[sku]);
    return Number(ls.defaultThreshold !== undefined ? ls.defaultThreshold : 5);
}

// ---------- 采购单（生产节点播报数据源） ----------
async function fetchPurchases(begin, end) {
    const out = [];
    let page = 1;
    while (page <= 20) {
        const r = await callApiWithRetry2('/open/purchase/query', {
            page_index: page, page_size: 50,
            modified_begin: begin, modified_end: end,
        });
        const po = (r.data && r.data.datas) || [];
        out.push(...po);
        if (po.length < 50) break;
        page++;
        await sleep(800);
    }
    return out;
}

async function callApiWithRetry2(bizPath, biz) {
    const waits = [3000, 6000, 12000];
    for (let i = 0; ; i++) {
        const r = JSON.parse(await callApi(bizPath, biz));
        if (r.code === 0) return r;
        if ((r.code === 199 || r.code === 189) && i < waits.length) {
            console.log(`[限流] ${bizPath} code=${r.code}，${waits[i] / 1000}s 后重试`);
            await sleep(waits[i]);
            continue;
        }
        throw new Error(`聚水潭接口错误 ${bizPath} code=${r.code} msg=${r.msg}`);
    }
}

// 采购单对比：新增单 / 到货状态变化。返回 {newPOs, progress}
function comparePurchases(current, prevState) {
    const newPOs = [], progress = [];
    for (const po of current) {
        const id = String(po.po_id);
        const prev = prevState[id];
        const summary = {
            po_id: id,
            po_date: po.po_date,
            status: po.status,
            receive_status: po.receive_status || '',
            purchaser: po.purchaser_name || '',
            supplier: po.supplier_id || '',
            items: (po.items || []).map(it => ({
                sku: it.sku_id, qty: Number(it.qty) || 0, i_id: it.i_id,
            })),
            modified: po.modified,
        };
        if (!prev) {
            newPOs.push(summary);
        } else if (prev.receive_status !== summary.receive_status || prev.status !== summary.status) {
            progress.push({ prev, cur: summary });
        }
        prevState[id] = summary;
    }
    return { newPOs, progress };
}

function passFilter(sku, wh, cfg) {
    if (cfg.warehouseFilter.length && !cfg.warehouseFilter.includes(wh)) return false;
    if (cfg.skuWhitelist.length) return cfg.skuWhitelist.includes(sku);
    const pre = String(sku).split('-')[0];
    if (cfg.prefixBlacklist.includes(pre)) return false;
    if (cfg.prefixWhitelist.length && !cfg.prefixWhitelist.includes(pre)) return false;
    return true;
}

function renderGroup(title, icon, items, cfg) {
    if (!items.length) return '';
    const shown = items.slice(0, cfg.maxItems);
    const lines = shown.map((x, i) =>
        `${i + 1}. ${x.name}（${x.sku}）+${x.delta} → 现库存 ${x.after}`);
    if (items.length > shown.length) lines.push(`…另有 ${items.length - shown.length} 项未展开`);
    const total = items.reduce((s, x) => s + x.delta, 0);
    return `${icon} ${title}（${items.length}个SKU / +${total}件）\n${lines.join('\n')}`;
}

function sendViaLark(chatId, text) {
    // 消息经临时文件传入，规避长文本与 shell 转义问题；lark-cli 支持 --text @file
    // 注意：lark-cli 只允许读 当前目录 / /tmp / ~/files 下的文件，故临时文件必须放 /tmp
    const tmp = path.join('/tmp', `chunshan-inv-msg-${Date.now()}.txt`);
    fs.writeFileSync(tmp, text);
    try {
        const r = spawnSync('lark-cli', [
            'im', '+messages-send',
            '--as', 'bot',
            '--chat-id', chatId,
            '--text', `@${tmp}`,
        ], { encoding: 'utf8', timeout: 30000 });
        const out = (r.stdout || '') + (r.stderr || '');
        if (r.status !== 0) throw new Error(`lark-cli exit=${r.status}: ${out.slice(0, 500)}`);
        let ok = true, msg = out;
        try { const j = JSON.parse(out); ok = !!j.ok; msg = JSON.stringify(j).slice(0, 300); } catch { /* 非JSON则原样用 */ }
        if (!ok) throw new Error(`飞书返回失败: ${msg}`);
        console.log('[推送] 机器人发送成功:', msg);
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    }
}

function feishuSign(secret, timestamp) {
    const stringToSign = `${timestamp}\n${secret}`;
    return crypto.createHmac('sha256', stringToSign).update('').digest('base64');
}

function postJson(url, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = JSON.stringify(body);
        const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
            timeout: 15000,
        }, res => {
            let buf = '';
            res.on('data', c => (buf += c));
            res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('webhook timeout')); });
        req.write(data); req.end();
    });
}

(async () => {
    const cfg = loadConfig();
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const now = new Date();
    const end = fmtTime(now);
    const beginD = new Date(now.getTime() - cfg.lookbackHours * 3600 * 1000);
    const begin = fmtTime(beginD);
    const runTag = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

    console.log(`[${end}] 库存新增播报开始，回溯窗口 ${begin} ~ ${end}`);

    const changes = await fetchRecentChanges(begin, end);
    console.log(`[拉数] 窗口内变动记录 ${changes.length} 条`);

    // 载入旧状态
    let state = {};
    let hasBaseline = fs.existsSync(STATE_FILE);
    if (hasBaseline) {
        try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
        catch { state = {}; hasBaseline = false; }
    }

    // diff + 更新状态 + 断货预警收集
    const increases = [];
    const breaches = [];   // 新跌破阈值（上期>线，本期<=线）
    let newKeys = 0;
    for (const x of changes) {
        const k = keyOf(x);
        const qty = Number(x.qty) || 0;
        const prev = state[k];
        if (!prev) {
            newKeys++;
        } else {
            const delta = qty - prev.qty;
            if (delta >= cfg.minDelta && passFilter(x.sku_id, x.i_id, cfg)) {
                increases.push({
                    wh: x.i_id, sku: x.sku_id, name: x.name || '',
                    delta, before: prev.qty, after: qty, modified: x.modified,
                    material: isMaterial(x),
                });
            }
            // 断货：新跌破阈值（含跌破至0/负）
            if (cfg.lowStock && cfg.lowStock.enabled && !isExcludedForAlert(x, cfg)) {
                const th = thresholdFor(x.sku_id, cfg);
                if (prev.qty > th && qty <= th) {
                    breaches.push({ wh: x.i_id, sku: x.sku_id, name: x.name || '', th, before: prev.qty, after: qty });
                }
            }
        }
        state[k] = { qty, name: x.name || '', sku: x.sku_id, wh: x.i_id, modified: x.modified, updated: end };
    }
    breaches.sort((a, b) => a.after - b.after);

    // 负库存：全量扫描当期拉到的所有记录（过滤虚拟品/邮费/处理品）
    let negatives = [];
    if (cfg.negativeStockAlert) {
        negatives = changes
            .filter(x => Number(x.qty) < 0 && !isExcludedForAlert(x, cfg))
            .map(x => ({ wh: x.i_id, sku: x.sku_id, name: x.name || '', qty: Number(x.qty) }))
            .sort((a, b) => a.qty - b.qty);
    }

    const productItems = increases.filter(x => !x.material).sort((a, b) => b.delta - a.delta);
    const materialItems = increases.filter(x => x.material).sort((a, b) => b.delta - a.delta);

    // ---------- 采购单（生产节点） ----------
    let newPOs = [], progress = [], purBaselineOnly = false;
    if (cfg.purchaseAlert) {
        const PUR_DAYS = 7;
        const pBegin = fmtTime(new Date(now.getTime() - PUR_DAYS * 24 * 3600 * 1000));
        let purState = {};
        if (fs.existsSync(PUR_STATE_FILE)) {
            try { purState = JSON.parse(fs.readFileSync(PUR_STATE_FILE, 'utf8')); } catch { purState = {}; }
        }
        const hadPurBaseline = Object.keys(purState).length > 0;
        const pos = await fetchPurchases(pBegin, end);
        console.log(`[采购] 近${PUR_DAYS}天采购单 ${pos.length} 张`);
        const cmp = comparePurchases(pos, purState);
        newPOs = cmp.newPOs;
        progress = cmp.progress;
        if (!hadPurBaseline) purBaselineOnly = true; // 首期只建采购基线
        fs.writeFileSync(PUR_STATE_FILE, JSON.stringify(purState));
    }

    // 持久化新状态 + 本期快照
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    fs.writeFileSync(path.join(DATA_DIR, `snap-${runTag}.json`), JSON.stringify(changes));

    const dateLabel = `${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // ---------- 渲染各块 ----------
    const skuName = sku => {
        for (const v of Object.values(state)) if (v.sku === sku && v.name) return v.name;
        return '';
    };

    function renderAlertBlock() {
        const lines = [];
        if (negatives.length) {
            lines.push(`🚨 负库存预警（超卖，需尽快处理）：`);
            negatives.forEach(x => lines.push(`  · ${x.name}（${x.sku}）${x.qty} 件 [${x.wh}]`));
        }
        if (breaches.length) {
            lines.push(`⚠️ 库存跌破预警线（≤${(cfg.lowStock && cfg.lowStock.defaultThreshold) || 5}件，建议补货）：`);
            breaches.forEach(x => lines.push(`  · ${x.name}（${x.sku}）${x.before} → ${x.after} 件`));
        }
        return lines.length ? lines.join('\n') : '';
    }

    function renderPurchaseBlock() {
        const lines = [];
        if (purBaselineOnly) {
            lines.push(`🏭 采购基线已建立（近7天 ${newPOs.length + progress.length} 张单，下期开始播报采购动态）`);
            return lines.join('\n');
        }
        if (newPOs.length) {
            lines.push(`🏭 新下采购单 ${newPOs.length} 张：`);
            newPOs.slice(0, 10).forEach(po => {
                const items = po.items.map(it => {
                    const n = skuName(it.sku);
                    return `${n ? n + '×' : it.sku + '×'}${it.qty}`;
                }).join('、');
                lines.push(`  · [${po.po_id}] ${items}`);
            });
        }
        if (progress.length) {
            lines.push(`🚚 到货进展变化 ${progress.length} 张：`);
            progress.slice(0, 10).forEach(({ prev, cur }) => {
                const items = cur.items.map(it => {
                    const n = skuName(it.sku);
                    return `${n ? n + '×' : it.sku + '×'}${it.qty}`;
                }).join('、');
                const statusMap = { '': '未到货', 'Part_Received': '部分到货', 'Received': '全部到货' };
                lines.push(`  · [${cur.po_id}] ${items} → ${statusMap[cur.receive_status] || cur.receive_status || cur.status}`);
            });
        }
        return lines.join('\n');
    }

    let text;       // 全量文本（报告落盘用）
    let pushText;   // 群消息文本（按 pushSections 过滤后）
    let suppressPush = false;

    if (!hasBaseline || BASELINE_ONLY) {
        text = `📦 库存播报基线已建立（${dateLabel}）\n状态库共 ${Object.keys(state).length} 个 仓库×SKU 组合，下期开始播报断货预警/采购动态/净增加。`;
        pushText = text;
        suppressPush = true;
        console.log('[基线] 首次运行或指定 --baseline，仅建基线不播报');
    } else {
        const alertBlock = renderAlertBlock();
        const purchaseBlock = renderPurchaseBlock();
        const hasIncrease = productItems.length + materialItems.length > 0;

        if (!alertBlock && !purchaseBlock && !hasIncrease) {
            text = `📦 库存健康播报 · ${dateLabel}\n今日无断货预警、无采购动态、无库存净增加（窗口内变动 ${changes.length} 条）。`;
            if (cfg.silentWhenEmpty) suppressPush = true;
            pushText = text;
        } else {
            const parts = [{ type: 'head', text: `📦 库存健康播报 · ${dateLabel}` }];
            if (alertBlock) parts.push({ type: 'alert', text: alertBlock });
            if (purchaseBlock) parts.push({ type: 'purchase', text: purchaseBlock });
            if (hasIncrease) {
                const pTotal = productItems.reduce((s, x) => s + x.delta, 0);
                const mTotal = materialItems.reduce((s, x) => s + x.delta, 0);
                parts.push({ type: 'increase', text: `📦 库存净增加：成品 ${productItems.length}个SKU/+${pTotal}件，辅料 ${materialItems.length}个SKU/+${mTotal}件` });
                const incBlocks = [
                    renderGroup('成品到货', '🏕', productItems, cfg),
                    renderGroup('辅料到货', '🧵', materialItems, cfg),
                ].filter(Boolean);
                incBlocks.forEach(b => parts.push({ type: 'increase', text: b }));
            }
            // 报告=全量；群消息按 pushSections 过滤
            text = parts.map(p => p.text).join('\n\n');
            const ps = cfg.pushSections || {};
            const allow = { head: true, alert: ps.alert !== false, purchase: ps.purchase !== false, increase: ps.increase !== false };
            pushText = parts.filter(p => allow[p.type]).map(p => p.text).join('\n\n');
        }
    }

    const reportFile = path.join(DATA_DIR, `report-${runTag}.txt`);
    fs.writeFileSync(reportFile, text);
    console.log('\n' + text + '\n');
    console.log(`[报告] ${reportFile}`);

    if (DRY_RUN || BASELINE_ONLY || suppressPush) {
        console.log('[推送] 本次不发群（dry-run/基线/静默规则）');
        return;
    }

    if (cfg.pushMode === 'none') { console.log('[推送] pushMode=none，跳过'); return; }

    if (cfg.pushMode === 'webhook') {
        if (!cfg.webhookUrl) { console.log('[推送] webhookUrl 为空，跳过'); return; }
        const body = { msg_type: 'text', content: { text: pushText } };
        let url = cfg.webhookUrl;
        if (cfg.secret) {
            const ts = Math.floor(now.getTime() / 1000).toString();
            const u = new URL(url);
            u.searchParams.set('timestamp', ts);
            u.searchParams.set('sign', feishuSign(cfg.secret, ts));
            url = u.toString();
        }
        const r = await postJson(url, body);
        console.log('[推送] webhook 返回', r.status, r.body);
        return;
    }

    // 默认：lark 机器人
    if (!cfg.chatId) { console.log('[推送] chatId 为空，跳过（报告已落盘）'); return; }
    if (pushText !== text) console.log('[过滤] 断货/采购块已按 pushSections 关闭，仅播报开启的板块');
    sendViaLark(cfg.chatId, pushText);
})().catch(e => {
    console.error('[致命错误]', e);
    process.exit(1);
});
