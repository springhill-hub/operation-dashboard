/**
 * 生意参谋「商品-全部」导出xls解析器（天猫销量兜底管线，奇门接口恢复前使用）
 *
 * 用法：
 *   node parse-tmall-sycm.js <导出文件.xls>          解析并生成 tmall_sales_YYYY-MM.json
 *   node parse-tmall-sycm.js                         自动扫描 f:/ai agent/tmall-inbox/ 下最新文件
 *
 * 输入文件特征（2026-09样本确认）：BIFF .xls；前4行空；表头行含"货号/支付件数/支付金额/成功退款金额"；
 *   统计日期显示月末但指标为整月累计（月份以文件名 2026-09-01_2026-09-30 为准）；
 *   同一货号可能多行（重复上架/多商品ID），按货号聚合；货号为"-"或邮费补差链接剔除。
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

function monthFromFilename(file) {
  const m = /(\d{4})-(\d{2})-\d{2}_(\d{4})-(\d{2})-\d{2}/.exec(path.basename(file));
  if (m && (m[1] !== m[3] || m[2] !== m[4])) {
    console.warn(`  [警告] 文件名跨月 ${m[0]}，本管线按月生成，取起始月 ${m[1]}-${m[2]}`);
  }
  return m ? `${m[1]}-${m[2]}` : null;
}

function parse(file) {
  const month = monthFromFilename(file) || (() => {
    throw new Error('文件名未识别出月份（应为 生意参谋...2026-09-01_2026-09-30.xls 格式）');
  })();
  const wb = XLSX.readFile(file, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const { row: hr, col } = findHeader(rows);
  const C = {
    date: col('统计日期'), id: col('商品ID'), name: col('商品名称'), code: col('货号'),
    type: col('商品类型'), status: col('商品状态'),
    orderQty: col('下单件数'), payQty: col('支付件数'), payAmt: col('支付金额'), refundAmt: col('成功退款金额'),
  };
  if (C.code < 0 || C.payQty < 0) throw new Error('缺少关键列：货号/支付件数');

  const agg = new Map();
  const excluded = [];
  let rawRows = 0;
  for (const r of rows.slice(hr + 1)) {
    const name = String(r[C.name] ?? '').trim();
    const code0 = String(r[C.code] ?? '').trim();
    if (!name && !code0) continue;
    rawRows++;
    // 非卖链接/无货号行：记录剔除，不进结果
    if (!code0 || code0 === '-' || NON_SKU.test(code0 + ' ' + name)) {
      const q = num(r[C.payQty]);
      if (q > 0) excluded.push({ code: code0 || '-', name, qty: q });
      continue;
    }
    if (!agg.has(code0)) {
      agg.set(code0, { code: code0, name, itemIds: [], type: String(r[C.type] ?? ''), status: String(r[C.status] ?? ''),
        orderQty: 0, payQty: 0, payAmt: 0, refundAmt: 0 });
    }
    const a = agg.get(code0);
    if (r[C.id] !== '' && !a.itemIds.includes(String(r[C.id]))) a.itemIds.push(String(r[C.id]));
    if (name && name.length > a.name.length) a.name = name;
    if (r[C.status]) a.status = String(r[C.status]);
    a.orderQty += num(r[C.orderQty]);
    a.payQty += num(r[C.payQty]);
    a.payAmt += num(r[C.payAmt]);
    a.refundAmt += num(r[C.refundAmt]);
  }
  const items = [...agg.values()].map(a => ({ ...a,
    orderQty: Math.round(a.orderQty), payQty: Math.round(a.payQty),
    payAmt: Math.round(a.payAmt * 100) / 100, refundAmt: Math.round(a.refundAmt * 100) / 100,
  })).sort((x, y) => y.payQty - x.payQty);
  const out = {
    platform: '天猫(生意参谋)', month, caliber: '商品(SPU/货号)维度·支付件数·整月支付口径（非净销量，奇门恢复后停用）',
    sourceFile: path.basename(file), generatedAt: new Date().toISOString().slice(0, 10),
    rawRows, excludedRows: excluded.length,
    totalPayQty: items.reduce((s, a) => s + a.payQty, 0),
    totalPayAmt: Math.round(items.reduce((s, a) => s + a.payAmt, 0) * 100) / 100,
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
  let file = process.argv[2];
  if (!file) {
    if (!fs.existsSync(INBOX)) throw new Error(`未传文件且收件目录不存在：${INBOX}`);
    const list = fs.readdirSync(INBOX).filter(f => /\.xlsx?$/i.test(f)).map(f => ({ f, t: fs.statSync(path.join(INBOX, f)).mtimeMs }));
    if (!list.length) throw new Error(`收件目录无xls文件：${INBOX}`);
    file = path.join(INBOX, list.sort((a, b) => b.t - a.t)[0].f);
  }
  console.log(`解析：${file}`);
  const { month, out } = parse(file);
  const { skuSales, applied } = buildSkuSales(out);
  out.skuSales = skuSales;
  out.skuCount = Object.keys(skuSales).length;
  const outPath = path.join(ROOT, `tmall_sales_${month}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n月份 ${month} | 数据行 ${out.rawRows}，剔除非卖链接 ${out.excludedRows} 行（${out.excluded.reduce((s, e) => s + e.qty, 0)}件）`);
  console.log(`货号=SKU ${out.skuCount} 个 | 支付件数合计 ${out.totalPayQty} | 支付金额 ¥${out.totalPayAmt}`);
  if (applied.length) console.log(`应用可选覆盖 ${applied.length} 条：${applied.join('；')}`);
  console.log(`输出：${outPath}`);
})().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
