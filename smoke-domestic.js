/* 国内看板渲染冒烟测试 v2：new Function 隔离作用域运行页面JS */
const fs = require('fs');
const html = fs.readFileSync('f:/ai agent/国内经营看板.html', 'utf8');
const jsonMatch = html.match(/<script id="DATA-JSON" type="application\/json">([\s\S]*?)<\/script>/);
const pageJs = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(c => c.includes('render('));

let panelHTML = '';
const elStore = {};
function makeEl(id) {
  return {
    id, textContent: '',
    set innerHTML(v) { if (id === 'panel') panelHTML = v; }, get innerHTML() { return ''; },
    dataset: {}, style: {}, classList: { add(){}, remove(){}, toggle(){} },
    addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
  };
}
const documentStub = {
  getElementById: id => (elStore[id] = elStore[id] || makeEl(id)),
  querySelectorAll: () => [],
  addEventListener() {},
};
let rafCount = 0;
const rafStub = fn => { if (++rafCount < 50) fn(performance.now() + 1000); };
const realNow = performance.now.bind(performance);
const perfStub = () => realNow() + 1000;

const fn = new Function('document', 'requestAnimationFrame', 'performance', pageJs);
elStore['DATA-JSON'] = makeEl('DATA-JSON');
elStore['DATA-JSON'].textContent = jsonMatch[1];
const debugPre = `const __op = JSON.parse.bind(JSON); JSON.parse = s => { const r = __op(s); console.log('[debug] parse len=', s && s.length, 'keys=', r && Object.keys(r).join(',')); return r; };\n`;
new Function('document', 'requestAnimationFrame', 'performance', debugPre + pageJs)(documentStub, rafStub, perfStub);

// 追加 month 渲染验证（模拟点击Tab）
const savePanel = panelHTML;
panelHTML = '';
new Function('document', 'requestAnimationFrame', 'performance', debugPre + pageJs + '\nrender("month");')(documentStub, rafStub, perfStub);
const monthChecks = [
  ['月度支付GMV=589066.13', panelHTML.includes('data-val="589066.13"')],
  ['月度净销售=527470.39', panelHTML.includes('data-val="527470.39"')],
  ['月度订单795', panelHTML.includes('data-val="795"')],
  ['月度客单价=663.48', panelHTML.includes('data-val="663.48"')],
  ['趋势图bar-grp', panelHTML.includes('bar-grp')],
];
let mok = true;
for (const [name, pass] of monthChecks) { console.log((pass ? 'PASS' : 'FAIL') + '  ' + name); if (!pass) mok = false; }
panelHTML = savePanel;


const monthGmv = fmtCheck();
function fmtCheck() {
  const d = JSON.parse(jsonMatch[1]);
  return d.month.totals.gmv;
}
const checks = [
  ['KPI支付GMV data-val(今日)=4203.5', panelHTML.includes('data-val="4203.5"')],
  ['KPI净销售 data-val(今日)=4202.5', panelHTML.includes('data-val="4202.5"')],
  ['渠道芯片-抖音', panelHTML.includes('抖音')],
  ['渠道芯片-线下/分销', panelHTML.includes('线下/分销')],
  ['店铺-抖音春山户外', panelHTML.includes('「抖音」春山户外')],
  ['SKU表', panelHTML.includes('动销SKU TOP20')],
  ['口径说明-渠道缺口', panelHTML.includes('天猫/淘宝/京东/微店/拼多多')],
  ['环形图circle', panelHTML.includes('<circle')],
  ['表格行数>3', (panelHTML.match(/<tr>/g) || []).length >= 4],
  ['退款率标注', panelHTML.includes('退款率')],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? 'PASS' : 'FAIL') + '  ' + name); if (!pass) ok = false; }
ok = ok && mok;
console.log('data-vals:', [...panelHTML.matchAll(/data-val="([^"]+)"/g)].map(m => m[1]).join(', '));
console.log('panelHTML size:', (panelHTML.length / 1024).toFixed(1), 'KB ｜ raf calls:', rafCount, '｜ month.gmv:', monthGmv);
process.exit(ok ? 0 : 1);
