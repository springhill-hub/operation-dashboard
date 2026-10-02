// 无浏览器渲染验证：mock DOM 后执行看板内联脚本，逐 tab 调 render()，断言不抛错 + 关键内容
const fs = require('fs');

function makeEl(store, id) {
  const node = {
    id, style: {}, dataset: {}, value: '',
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    setAttribute(){}, getAttribute(){ return null; }, appendChild(){}, removeChild(){},
    addEventListener(){}, removeEventListener(){}, querySelector(){ return makeEl(store); },
    querySelectorAll(){ return []; }, focus(){}, click(){},
  };
  return node;
}

function run(file, periods, asserts) {
  console.log('\n=== ' + file + ' ===');
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [];
  let dataJson = '';
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc=/.test(m[1])) continue;
    if (/id="DATA-JSON"/.test(m[1])) { dataJson = m[2]; continue; }
    if (m[2].trim()) scripts.push(m[2]);
  }
  const byId = {};
  const documentMock = {
    getElementById(id){ return (byId[id] ||= makeEl(byId, id)); },
    querySelector(){ return makeEl(byId); },
    querySelectorAll(){ return []; },
    addEventListener(){}, createElement(){ return makeEl(byId); },
    documentElement: makeEl(byId), body: makeEl(byId),
  };
  documentMock.getElementById('DATA-JSON').textContent = dataJson;
  const sandbox = {
    document: documentMock, window: {}, location: {}, navigator: { userAgent: 'node' },
    requestAnimationFrame(){}, cancelAnimationFrame(){}, localStorage: { getItem(){return null;}, setItem(){}, removeItem(){} },
    setTimeout, clearTimeout, console, Math, Date, JSON, Number, String, Array, Object, parseFloat, parseInt, isNaN,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const code = scripts.join('\n;\n') +
    '\n;globalThis.__render = (typeof render==="function"?render:null);' +
    '\n;globalThis.__DATA = (typeof DATA!=="undefined"?DATA:null);';
  const fn = new Function(...Object.keys(sandbox), code);
  let initErr = null;
  try { fn(...Object.values(sandbox)); } catch (e) { initErr = e; }
  if (initErr) { console.log('  [FAIL] 脚本初始化抛错:', initErr.message); return false; }
  console.log('  [OK] 脚本初始化（默认tab渲染）未抛错');
  let ok = true;
  for (const p of periods) {
    const panel = documentMock.getElementById('panel');
    panel.innerHTML = '';
    try { sandbox.__render(p); } catch (e) {
      console.log(`  [FAIL] render('${p}') 抛错:`, e.message); ok = false; continue;
    }
    const out = panel.innerHTML || '';
    if (!out) { console.log(`  [FAIL] render('${p}') 产出为空`); ok = false; continue; }
    console.log(`  [OK] render('${p}') 产出 ${out.length} 字符`);
    for (const token of (asserts[p] || [])) {
      const hit = out.includes(token);
      if (!hit) { console.log(`    [MISS] 未找到: ${token}`); ok = false; }
      else console.log(`    [HIT] ${token}`);
    }
    const bad = ['NaN','undefined','[object Object]','null%'].filter(b => out.includes(b));
    if (bad.length) { console.log(`    [WARN] render('${p}') 含异常字样: ${bad.join(', ')}`); }
  }
  return ok;
}

const CB = process.argv[2] || 'f:/ai agent/deploy/index.html';
const DM = process.argv[3] || 'f:/ai agent/deploy/domestic.html';
let allOk = true;
allOk &= run(CB, ['today','week','month','lastMonth'], {
  today: ['853,985','日亚 44 单','已结算','待结算','下单口径','结算毛利 ÷ 结算销售额'],
  lastMonth: ['12,530,113','892','日亚 887 单','已结算','结算毛利 ÷ 结算销售额'],
});
allOk &= run(DM, ['today','week','month','lastMonth'], {
  today: ['¥1,375'],
  lastMonth: ['¥337,757','¥502,730','轩辕','天猫/淘宝'],
});
console.log('\n' + (allOk ? 'ALL RENDER CHECKS PASS' : 'SOME CHECKS FAILED'));
process.exit(allOk ? 0 : 1);
