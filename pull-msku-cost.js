/* ============================================================
 * 春山户外 · 日亚 MSKU 单位成本主表拉取（v1.0 · 2026-10-06）
 * ------------------------------------------------------------
 * 数据源：领星 get_profit_report_msku（sid=3118 日亚）
 *   取年初至昨日全量 MSKU 的 cgUnitPrice（JPY 单位采购成本，
 *   正值、未含头程），写入 jp-msku-cost.json 供 cost-lib 使用。
 * 失败不抛致命：保留旧文件（每日调度由调用方决定是否阻断）。
 * 运行：CS_ROOT=/opt/chunshan node pull-msku-cost.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const { callTool } = require(path.join(__dirname, '..', 'lx_api.js'));

const OUTP = path.join(__dirname, 'jp-msku-cost.json');
const num = v => Number(v) || 0;

(async () => {
  const end = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const start = end.slice(0, 4) + '-01-01';

  const records = [];
  for (let offset = 0; ; offset += 200) {
    const r = await callTool('action', { toolId: 'get_profit_report_msku', params: {
      startDate: start, endDate: end, isMonthly: false,
      length: 200, offset,
      sortField: 'totalSalesQuantity', sortType: 'desc',
    } });
    const d = r && r.data && r.data.data;
    if (!d || !Array.isArray(d.records)) throw new Error('返回结构异常: ' + JSON.stringify(r).slice(0, 200));
    records.push(...d.records);
    if (records.length >= num(d.total) || d.records.length === 0) break;
    if (offset > 5000) break; // 安全上限
  }

  const unitCostJpy = {};
  let zeroCost = 0;
  for (const x of records) {
    if (!x.msku) continue;
    const u = Math.abs(num(x.cgUnitPrice));
    if (u > 0) unitCostJpy[x.msku] = { unit: Math.round(u * 100) / 100, qty: num(x.totalSalesQuantity) };
    else zeroCost++;
  }

  const out = {
    version: '1.0',
    generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    range: [start, end],
    source: 'lingxing get_profit_report_msku sid=3118(日亚) cgUnitPrice；JPY单位采购成本(正值,未含头程)',
    mskuCount: Object.keys(unitCostJpy).length,
    zeroCostMsku: zeroCost,
    unitCostJpy,
  };
  fs.writeFileSync(OUTP, JSON.stringify(out, null, 2));
  console.log('[OK] jp-msku-cost.json: ' + Object.keys(unitCostJpy).length + ' msku（零成本跳过 ' + zeroCost + '），区间 ' + start + '~' + end);
})().catch(e => {
  console.error('[ERR] pull-msku-cost: ' + e.message);
  if (fs.existsSync(OUTP)) console.error('       保留旧主表: ' + OUTP);
  process.exit(1); // 调用方决定是否阻断（daily-refresh 记录失败但继续）
});
