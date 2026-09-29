/* ============================================================
 * 春山户外 · Shopee 静态 MSKU 成本表生成脚本（固化版 v1.1）
 * ------------------------------------------------------------
 * 用途：提取每个 MSKU 的「真实单位成本」（店铺原币，负值），生成
 *       msku-cost.json，供 build-shopee.js 在利润报表尚未出
 *       （滞后7-10天）时提前估算真实成本，使真实毛利提速至结算当日。
 *
 * 数据源（优先级）：
 *   ① shopee-raw/{SITE}_profit_msku.txt — 领星 finance_settlement_profit_list
 *      summaryField=3（MSKU维度），sids 指定店铺，全量行（主源，覆盖全）
 *   ② operation_data.json 的 skuDetail — cost/qty（补充源）
 *
 * 非交互 / 路径以脚本目录锚定 / 仅读写约定文件。
 * 运行：node build-msku-cost.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const DATAP = 'f:/ai agent/operation_data.json';
const RAWDIR = path.join(__dirname, 'shopee-raw');
const OUTP  = path.join(__dirname, 'msku-cost.json');

const num = v => Number(v) || 0;
const r4  = v => Math.round(num(v) * 10000) / 10000;

// {ccy: {msku: [{unit, qty, source}]}}
const samples = {};
const addSample = (ccy, msku, unit, qty, source) => {
  if (!ccy || !msku || !qty) return;
  samples[ccy] = samples[ccy] || {};
  (samples[ccy][msku] = samples[ccy][msku] || []).push({ unit: r4(unit), qty, source });
};

// ---------- ① 全量 MSKU 利润原始文件 ----------
for (const f of fs.readdirSync(RAWDIR)) {
  const mm = f.match(/^(TH|MY)_profit_msku\.txt$/);
  if (!mm) continue;
  const ccy = mm[1] === 'TH' ? 'THB' : 'MYR';
  let s = fs.readFileSync(path.join(RAWDIR, f), 'utf8').trim();
  s = s.slice('The MCP server responded with:'.length).trim();
  const d = JSON.parse(JSON.parse(s)[0].text).data.data;
  for (const r of d.dataList) {
    if (!r.msku || !r.salesVolume) continue;
    addSample(ccy, r.msku, num(r.productCost) / num(r.salesVolume), num(r.salesVolume), 'profit_msku');
  }
}

// ---------- ② operation_data skuDetail（补充） ----------
const D = JSON.parse(fs.readFileSync(DATAP, 'utf8'));
for (const p of ['today', 'week', 'month', 'yesterday', 'lastWeek', 'lastMonth']) {
  const st = D[p] && D[p].settlement;
  if (!st) continue;
  for (const [name, s] of Object.entries(st)) {
    if (!String(name).includes('shopee') || !Array.isArray(s.skuDetail)) continue;
    for (const r of s.skuDetail) {
      if (!r.msku || !r.qty) continue;
      addSample(s.currency, r.msku, num(r.cost) / num(r.qty), num(r.qty), 'skuDetail:' + p);
    }
  }
}

// ---------- 每个 MSKU：取数量加权单位成本；样本分歧>5% 标注 ----------
const unitCost = {}, detail = {};
for (const [ccy, map] of Object.entries(samples)) {
  unitCost[ccy] = {}; detail[ccy] = {};
  for (const [msku, arr] of Object.entries(map)) {
    const tq = arr.reduce((s, a) => s + a.qty, 0);
    const weighted = r4(arr.reduce((s, a) => s + a.unit * a.qty, 0) / tq);
    const spread = Math.max(...arr.map(a => a.unit)) - Math.min(...arr.map(a => a.unit));
    const warn = spread / Math.abs(weighted) > 0.05;
    unitCost[ccy][msku] = weighted;
    detail[ccy][msku] = { samples: arr, spread: r4(spread), note: warn ? '样本分歧>5%，需人工核对' : 'ok' };
  }
}

const counts = Object.fromEntries(Object.entries(unitCost).map(([c, m]) => [c, Object.keys(m).length]));
const out = {
  version: '1.1',
  generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  source: {
    primary: 'shopee-raw/{SITE}_profit_msku.txt（finance_settlement_profit_list, summaryField=3, sids指定店铺）',
    supplement: DATAP + ' skuDetail：unitCost = cost / qty',
    note: '单位成本为店铺原币负值，含采购成本、未含头程；取值为数量加权'
  },
  mskuCount: counts,
  unitCost,
  detail,
  usage: 'build-shopee.js: staticProductCost = Σ settledQty(msku) × unitCost[ccy][msku]；未知MSKU计入unknownMskus，覆盖率见运行日志',
  maintenance: '每月利润报表出全后重跑本脚本更新；采购调价后以财务确认成本手工修正对应MSKU'
};

fs.writeFileSync(OUTP, JSON.stringify(out, null, 2), 'utf8');
console.log('written: ' + OUTP);
console.log('MSKU counts: ' + JSON.stringify(counts));
for (const [c, m] of Object.entries(detail)) {
  const warn = Object.entries(m).filter(([, v]) => v.note !== 'ok');
  console.log(c + ': ' + Object.keys(m).length + ' msku, warnings=' + warn.length);
  warn.slice(0, 10).forEach(([k, v]) => console.log('  [!] ' + k + ' ' + v.note));
}
