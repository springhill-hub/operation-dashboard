/**
 * 生意参谋「商品-全部」导出xls解析器（天猫销量兜底管线，奇门接口恢复前使用）
 *
 * 用法：
 *   node parse-tmall-sycm.js <导出文件.xls>          解析并生成 tmall_sales_YYYY-MM.json
 *   node parse-tmall-sycm.js <f1.xls> <f2.xls> ...   同月多文件聚合成一个 JSON（支持月内多日/多段MTD导出）
 *   node parse-tmall-sycm.js                         自动扫描 f:/ai agent/tmall-inbox/ 下最新文件（单文件，月度任务用）
 *
 * 输入文件特征（2026-09样本确认）：BIFF .xls；前4行空；表头行含"货号/支付件数/支付金额/成功退款金额"；
 *   整月导出：统计日期显示月末但指标为整月累计（月份以文件名 2026-09-01_2026-09-30 为准）；
 *   单日导出（2026-10样本）：统计日期=当天，文件名 XXXX-10-01_2026-10-01；
 *   同一货号可能多行（重复上架/多商品ID），按货号聚合；货号为"-"或邮费补差链接剔除。
 *
 * 多文件聚合规则：必须同月；禁止「整月文件 + 月内片段」混用（防双算，直接报错）；
 *   同(商品ID,统计日期)行跨文件重复时去重并告警。输出 coverage{dateFrom,dateTo,days,partial}：
 *   partial=true 表示月至今(MTD)片段，build-domestic 仅在周期覆盖该区间时注入并标注MTD。
 *
 * 口径（王泉斐 2026-10-01 确认）：天猫货号 = 库存SKU，1:1直接映射，输出 skuSales {SKU:支付件数}。
 *   tmall-spu-map.json 仅作可选覆盖（个别货号需挂到别的SKU或按颜色分摊时才建，见文件_doc）。
 *   支付件数口径（毛销量，生意参谋不提供退款件数，成功退款金额仅金额）。
 */
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const ROOT = 'f:/ai agent';
const INBOX = path.join(ROOT, 'tmall-inbox');
const NON_SKU = /邮费|补差价|补差链接|处理品|放心购|快递.*消毒|test|^\s*$/i;

const num = v => { const n = parseFloat(String(v ?? '').replace(/[, \u00a0]/g, '')); return isNaN(n) ? 0 : n; };
const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateStrOf = v => v instanceof Date ? fmtDate(v) : String(v ?? '').slice(0, 10);

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i].map(x => String(x ?? '').trim());
    if (r.includes('货号') && (r.includes('支付件数') || r.includes('支付子订单数'))) {
      const col = name => r.findIndex(h => h === name);
      return { row: i, col };
    }
  }
  throw new Error('未找到表头（需包含"货号"+"支付件数"），请确认是生意参谋「商品-全部」导出文件');
}

function spanFromFilename(file) {
  const m = /(\d{4})-(\d{2})-(\d{2})_(\d{4})-(\d{2})-(\d{2})/.exec(path.basename(file));
  if (!m) return null;
  const dateFrom = `${m[1]}-${m[2]}-${m[3]}`, dateTo = `${m[4]}-${m[5]}-${m[6]}`;
  if (m[1] !== m[4] || m[2] !== m[5]) {
    console.warn(`  [警告] 文件名跨月 ${dateFrom}_${dateTo}，本管线按月生成，取起始月 ${m[1]}-${m[2]}`);
  }
  return { month: `${m[1]}-${m[2]}`, dateFrom, dateTo };
}

function monthEndOf(month) {
  const [y, mo] = month.split('-').map(Number);
  const d = new Date(y, mo, 0); // 本地时间：第(mo+1)月第0天 = mo月最后一天
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parse(files) {
  files = Array.isArray(files) ? files : [files];
  const spans = files.map(f => ({ f, span: spanFromFilename(f) || (() => {
    throw new Error('文件名未识别出日期（应为 生意参谋...2026-09-01_2026-09-30.xls 格式）');
  })() }));
  const month = spans[0].span.month;
  if (spans.some(s => s.span.month !== month)) {
    throw new Error(`多文件必须同月：${spans.map(s => `${path.basename(s.f)}(${s.span.month})`).join('，')}`);
  }
  // 防双算：整月文件不得与月内片段混用
  const monthEnd = monthEndOf(month);
  const fullMonth = spans.filter(s => s.span.dateFrom === `${month}-01` && s.span.dateTo === monthEnd);
  if (files.length > 1 && fullMonth.length) {
    throw new Error('检测到整月导出文件与月内片段同时存在，混用会双算；请只保留整月文件或只保留日/段文件');
  }

  const agg = new Map();
  const excluded = [];
  const dailyMap = new Map();           // date -> 指标
  const seenRowKeys = new Set();        // (商品ID|统计日期) 跨文件去重
  let rawRows = 0, dedupRows = 0;

  for (const { f } of spans) {
    const wb = XLSX.readFile(f, { cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const { row: hr, col } = findHeader(rows);
    const C = {
      date: col('统计日期'), id: col('商品ID'), name: col('商品名称'), code: col('货号'),
      type: col('商品类型'), status: col('商品状态'),
      orderQty: col('下单件数'), payQty: col('支付件数'), payAmt: col('支付金额'), refundAmt: col('成功退款金额'),
      buyers: col('支付买家数'),
    };
    if (C.code < 0 || C.payQty < 0) throw new Error(`缺少关键列：货号/支付件数（${path.basename(f)}）`);
    for (const r of rows.slice(hr + 1)) {
      const name = String(r[C.name] ?? '').trim();
      const code0 = String(r[C.code] ?? '').trim();
      if (!name && !code0) continue;
      rawRows++;
      // 跨文件去重：同一商品ID同一天的行只计一次（无ID时用 货号|名称|日期）
      const dateStr = C.date >= 0 ? dateStrOf(r[C.date]) : spanFromFilename(f).dateTo;
      const rowKey = `${String(r[C.id] || `${code0}|${name}`)}@${dateStr}`;
      if (seenRowKeys.has(rowKey)) { dedupRows++; continue; }
      seenRowKeys.add(rowKey);
      const dAdd = (k, v) => { const d = dailyMap.get(dateStr) || { orderQty: 0, payQty: 0, payAmt: 0, refundAmt: 0, buyers: 0 }; d[k] += v; dailyMap.set(dateStr, d); };
      // 非卖链接/无货号行：记录剔除，不进结果
      if (!code0 || code0 === '-' || NON_SKU.test(code0 + ' ' + name)) {
        const q = num(r[C.payQty]);
        if (q > 0) excluded.push({ code: code0 || '-', name, qty: q });
        dAdd('payQty', q);
        continue;
      }
      if (!agg.has(code0)) {
        agg.set(code0, { code: code0, name, itemIds: [], type: String(r[C.type] ?? ''), status: String(r[C.status] ?? ''),
          orderQty: 0, payQty: 0, payAmt: 0, refundAmt: 0, buyers: 0 });
      }
      const a = agg.get(code0);
      if (r[C.id] !== '' && !a.itemIds.includes(String(r[C.id]))) a.itemIds.push(String(r[C.id]));
      if (name && name.length > a.name.length) a.name = name;
      if (r[C.status]) a.status = String(r[C.status]);
      const oq = num(r[C.orderQty]), pq = num(r[C.payQty]), pa = num(r[C.payAmt]), ra = num(r[C.refundAmt]), bn = num(r[C.buyers]);
      a.orderQty += oq; a.payQty += pq; a.payAmt += pa; a.refundAmt += ra; a.buyers += bn;
      dAdd('orderQty', oq); dAdd('payQty', pq); dAdd('payAmt', pa); dAdd('refundAmt', ra); dAdd('buyers', bn);
    }
  }
  if (dedupRows > 0) console.warn(`  [警告] 跨文件重复行 ${dedupRows} 行已去重（同商品ID+统计日期）`);

  const items = [...agg.values()].map(a => ({ ...a,
    orderQty: Math.round(a.orderQty), payQty: Math.round(a.payQty),
    payAmt: Math.round(a.payAmt * 100) / 100, refundAmt: Math.round(a.refundAmt * 100) / 100,
  })).sort((x, y) => y.payQty - x.payQty);
  const daily = [...dailyMap.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([date, v]) => ({ date, orderQty: Math.round(v.orderQty), payQty: Math.round(v.payQty),
      payAmt: Math.round(v.payAmt * 100) / 100, refundAmt: Math.round(v.refundAmt * 100) / 100, buyers: Math.round(v.buyers) }));
  // coverage：以文件名日期跨度为准（整月文件行内日期只显示月末，不能按行日期计数）
  const dateFrom = spans.map(s => s.span.dateFrom).sort()[0];
  const dateTo = spans.map(s => s.span.dateTo).sort().pop();
  const partial = !(dateFrom === `${month}-01` && dateTo === monthEnd);
  const out = {
    platform: '天猫(生意参谋)', month,
    caliber: partial
      ? `商品(SPU/货号)维度·支付件数·月至今(MTD)支付口径 ${dateFrom}~${dateTo}（非整月、非净销量，整月导出后覆盖）`
      : '商品(SPU/货号)维度·支付件数·整月支付口径（非净销量，奇门恢复后停用）',
    coverage: { dateFrom, dateTo, days: Math.round((new Date(dateTo) - new Date(dateFrom)) / 86400e3) + 1, partial },
    sourceFile: path.basename(spans[0].f),
    sourceFiles: spans.map(s => path.basename(s.f)),
    generatedAt: new Date().toISOString().slice(0, 10),
    rawRows, dedupRows, excludedRows: excluded.length,
    totalPayQty: items.reduce((s, a) => s + a.payQty, 0),
    totalPayAmt: Math.round(items.reduce((s, a) => s + a.payAmt, 0) * 100) / 100,
    totalRefundAmt: Math.round(items.reduce((s, a) => s + a.refundAmt, 0) * 100) / 100,
    totalBuyers: items.reduce((s, a) => s + a.buyers, 0), // 商品维度购买人次加总（同买家买多品会重复，仅近似订单数）
    daily,
    excluded, items,
  };
  return { month, out };
}

/**
 * 可选覆盖文件 f:/ai agent/tmall-spu-map.json（默认货号=SKU 1:1，无需此文件）。
 * 仅当个别货号需改挂或按颜色分摊时手工维护：
 *   { "mappings": { "CS-XYCQZ": {"sku":"LDL-XYCQZ-E"},
 *                   "BEL-FSYLY": {"skus":["BEL-FSYLY-Z","BEL-FSYLY-E"],"weights":[0.7,0.3]} } }
 * weights 不填则均摊；分摊件数四舍五入并把误差补给最大权重项，保证总量守恒。
 */
const MAP_PATH = path.join(ROOT, 'tmall-spu-map.json');
function loadOverride() {
  if (!fs.existsSync(MAP_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')).mappings || {}; }
  catch (e) { console.warn(`  [警告] ${MAP_PATH} 解析失败，忽略覆盖：${e.message}`); return {}; }
}

/** 货号1:1落SKU，应用可选覆盖；返回 {skuSales, overrides} */
function buildSkuSales(out) {
  const ov = loadOverride();
  const skuSales = {};
  const add = (sku, qty) => { skuSales[sku] = (skuSales[sku] || 0) + qty; };
  const applied = [];
  for (const it of out.items) {
    if (it.payQty <= 0) continue;
    const m = ov[it.code];
    if (m && m.skus && m.skus.length) {
      const w = m.weights && m.weights.length === m.skus.length ? m.weights : m.skus.map(() => 1 / m.skus.length);
      const sum = w.reduce((a, b) => a + b, 0) || 1;
      const alloc = m.skus.map((s, i) => ({ s, q: Math.floor(it.payQty * w[i] / sum) }));
      let rest = it.payQty - alloc.reduce((a, x) => a + x.q, 0);
      // 余数按权重降序补1，保证总量守恒
      alloc.sort((a, b) => (w[m.skus.indexOf(b.s)] - w[m.skus.indexOf(a.s)])).forEach((x, i) => { if (i < rest) x.q++; });
      alloc.forEach(x => add(x.s, x.q));
      applied.push(`${it.code}→[${m.skus.join('/')}]`);
    } else if (m && m.sku && m.sku !== it.code) {
      add(m.sku, it.payQty);
      applied.push(`${it.code}→${m.sku}`);
    } else {
      add(it.code, it.payQty); // 默认1:1
    }
  }
  return { skuSales, applied };
}

// ===== 主入口 =====
(async () => {
  let files = process.argv.slice(2);
  if (!files.length) {
    if (!fs.existsSync(INBOX)) throw new Error(`未传文件且收件目录不存在：${INBOX}`);
    const list = fs.readdirSync(INBOX).filter(f => /\.xlsx?$/i.test(f)).map(f => ({ f, t: fs.statSync(path.join(INBOX, f)).mtimeMs }));
    if (!list.length) throw new Error(`收件目录无xls文件：${INBOX}`);
    // 月度任务：保持单文件行为（取最新一个），多文件聚合必须显式传参以防整月/日文件混用
    files = [path.join(INBOX, list.sort((a, b) => b.t - a.t)[0].f)];
  }
  console.log(`解析：${files.length} 个文件${files.length > 1 ? '（聚合模式）' : ''}`);
  files.forEach(f => console.log(`  - ${f}`));
  const { month, out } = parse(files);
  const { skuSales, applied } = buildSkuSales(out);
  out.skuSales = skuSales;
  out.skuCount = Object.keys(skuSales).length;
  const outPath = path.join(ROOT, `tmall_sales_${month}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  const tag = out.coverage.partial ? `MTD ${out.coverage.dateFrom}~${out.coverage.dateTo}（${out.coverage.days}天/片段）` : '整月';
  console.log(`\n月份 ${month} [${tag}] | 数据行 ${out.rawRows}${out.dedupRows ? `，去重 ${out.dedupRows} 行` : ''}，剔除非卖链接 ${out.excludedRows} 行（${out.excluded.reduce((s, e) => s + e.qty, 0)}件）`);
  console.log(`货号=SKU ${out.skuCount} 个 | 支付件数合计 ${out.totalPayQty} | 支付金额 ¥${out.totalPayAmt} | 成功退款 ¥${out.totalRefundAmt}`);
  if (out.daily.length) {
    console.log('每日支付金额：');
    out.daily.forEach(d => console.log(`  ${d.date}  件数=${String(d.payQty).padStart(4)}  支付¥${String(d.payAmt).padStart(10)}  退款¥${String(d.refundAmt).padStart(9)}  买家=${d.buyers}`));
  }
  if (applied.length) console.log(`应用可选覆盖 ${applied.length} 条：${applied.join('；')}`);
  console.log(`输出：${outPath}`);
})().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
