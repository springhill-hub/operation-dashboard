/* ============================================================
 * 春山户外 · Shopee 账单自动拉数（固化版 v1.0 · 2026-10-06）
 * ------------------------------------------------------------
 * 数据源：领星 MCP（X-Mcp-Key，无需IP白名单）
 *   finance_shopee_income_list       账单收入明细（回款口径，按结算时间）
 *   finance_finance_shopee_adjustment 账单调整明细
 * 站点：TH / MY；length=200 分页至 list 为空。
 *
 * 输出（build-shopee.js 直接消费）：
 *   {rawDir}/{TH|MY}_income_{offset}.txt   内层业务JSON {totalSum,list,totalCount}
 *   {rawDir}/adjustment.json                {totalSum,list,totalCount}
 *
 * 运行：node pull-shopee.js --period=today --start=2026-10-05 --end=2026-10-05 \
 *         --rawDir=/opt/chunshan/deploy/shopee-raw/today
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const { callTool } = require(path.join(__dirname, '..', 'lx_api.js'));

const argv = {};
process.argv.slice(2).forEach(a => {
  if (!a.startsWith('--')) return;
  const i = a.indexOf('=');
  const k = a.slice(2, i < 0 ? undefined : i);
  argv[k] = i < 0 ? true : a.slice(i + 1);
});
if (!argv.period || !argv.start || !argv.end) {
  console.error('用法: node pull-shopee.js --period=today --start=YYYY-MM-DD --end=YYYY-MM-DD [--rawDir=...]');
  process.exit(1);
}
const PERIOD = argv.period;
const START = argv.start, END = argv.end;
const RAWDIR = argv.rawDir
  ? path.resolve(argv.rawDir)
  : path.join(__dirname, 'shopee-raw', PERIOD);
const SITES = ['TH', 'MY'];

async function action(toolId, params) {
  const r = await callTool('action', { toolId, params });
  const dd = r && r.data && r.data.data ? r.data.data : null;
  if (!dd) throw new Error(toolId + ' 无数据层: ' + JSON.stringify(r).slice(0, 200));
  return dd; // {totalSum, list, totalCount}
}

// 清空旧 raw（防跨期残留）
if (fs.existsSync(RAWDIR)) fs.rmSync(RAWDIR, { recursive: true, force: true });
fs.mkdirSync(RAWDIR, { recursive: true });

(async () => {
  console.log('====================================================');
  console.log(' Shopee pull | ' + PERIOD + ' | ' + START + ' ~ ' + END);
  console.log('====================================================');

  // ---------- adjustment（两站合并为一个文件，按行内 site 区分） ----------
  const adjAll = { totalSum: { amount: 0, totalCount: 0 }, list: [], totalCount: 0 };
  for (const site of SITES) {
    const d = await action('finance_finance_shopee_adjustment', {
      sites: [site], startDate: START, endDate: END, length: 200, offset: 0,
    });
    adjAll.list.push(...(d.list || []));
    adjAll.totalCount += Number(d.totalCount) || 0;
    console.log('adjustment ' + site + ': ' + (d.list || []).length + ' 条');
  }
  fs.writeFileSync(path.join(RAWDIR, 'adjustment.json'), JSON.stringify(adjAll, null, 1), 'utf8');

  // ---------- income 分页（每站 offset 0,200,...） ----------
  for (const site of SITES) {
    let offset = 0, pages = 0;
    while (true) {
      const d = await action('finance_shopee_income_list', {
        sites: [site], startDate: START, endDate: END, length: 200, offset,
      });
      const list = d.list || [];
      const f = path.join(RAWDIR, site + '_income_' + offset + '.txt');
      fs.writeFileSync(f, JSON.stringify(d, null, 1), 'utf8');
      pages++;
      console.log('income ' + site + ' @' + offset + ': ' + list.length + ' 条 / totalCount=' + d.totalCount);
      if (!list.length) break;
      offset += 200;
      if (offset >= (Number(d.totalCount) || 0)) break;
      if (pages > 50) throw new Error('分页超过50页，异常中断防死循环');
    }
  }
  console.log('DONE -> ' + RAWDIR);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
