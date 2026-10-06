/* ============================================================
 * 春山户外 · 韩国 Coupang 自动拉数（固化版 v1.0 · 2026-10-06）
 * ------------------------------------------------------------
 * 数据源：领星 MCP platform_v2_page_list（X-Mcp-Key，无需IP白名单）
 *   店铺 sid=110719712118729216（韩国Coupang）
 *   resultType 1=销量(件) 3=销售额(KRW)
 * 一次拉取 [min(月初,T-7), T-1] 全量分页，落 coupang-raw/：
 *   volume_{start}_{end}.json / sales_{start}_{end}.json
 * 聚合由 build-coupang.js 完成（取目录下最新一对）。
 * 运行：node pull-coupang.js [--anchor=YYYY-MM-DD]
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

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ANCHOR = argv.anchor ? new Date(argv.anchor + 'T12:00:00') : new Date();
const T1 = new Date(ANCHOR); T1.setDate(T1.getDate() - 1);
const MS = new Date(ANCHOR.getFullYear(), ANCHOR.getMonth(), 1);
const WS = new Date(ANCHOR); WS.setDate(WS.getDate() - 7);
const RANGE_START = WS < MS ? WS : MS;   // 与 build-coupang 三周期下限对齐
const START = argv.start || iso(RANGE_START);
const END   = argv.end   || iso(T1);
const SID = '110719712118729216';
const RAWDIR = path.join(__dirname, 'coupang-raw');

async function pullOne(resultType) {
  let pageNum = 1, fetched = 0, totalRows = Infinity;
  const rows = [];
  while (fetched < totalRows) {
    const r = await callTool('action', {
      toolId: 'platform_v2_page_list',
      params: {
        sids: [SID], searchType: 3, dataType: '3',
        start: START, end: END, dateUnit: '4',
        resultType: String(resultType), pageNum, pageSize: 200, currencyCode: '',
      },
    });
    const dd = r && r.data && r.data.data ? r.data.data : null;
    if (!dd || !Array.isArray(dd.statisticsList)) {
      throw new Error('platform_v2 rt=' + resultType + ' p' + pageNum + ': ' + JSON.stringify(r).slice(0, 200));
    }
    totalRows = Number(dd.count) || 0;
    rows.push(...dd.statisticsList);
    fetched += dd.statisticsList.length;
    pageNum++;
    if (!dd.statisticsList.length) break;
  }
  return { count: totalRows, statisticsList: rows };
}

(async () => {
  console.log('====================================================');
  console.log(' Coupang pull | ' + START + ' ~ ' + END);
  console.log('====================================================');
  if (!fs.existsSync(RAWDIR)) fs.mkdirSync(RAWDIR, { recursive: true });
  for (const [rt, label] of [['1', 'volume'], ['3', 'sales']]) {
    const data = await pullOne(rt);
    const f = path.join(RAWDIR, label + '_' + START + '_' + END + '.json');
    fs.writeFileSync(f, JSON.stringify(data, null, 1), 'utf8');
    console.log(label + ': ' + data.statisticsList.length + ' rows / count=' + data.count + ' -> ' + path.basename(f));
  }
  console.log('DONE');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
