/* ============================================================
 * 春山户外经营看板 · 每日刷新部署脚本（Node 跨平台版 v1.0 · 2026-10-06）
 * ------------------------------------------------------------
 * 从 deploy-dashboard.ps1 1:1 移植，供 Linux 云服务器定时任务使用；
 * Windows 本地仍可继续使用原 PS1 脚本，两者行为等价。
 *
 * 流程：
 *   1) 校验 operation_data.json
 *   2) 内嵌 JSON 到 经营看板.html
 *      → 回写源文件 + widget.html（含meta，飞书用）
 *      → index.html（去meta，GitHub Pages）
 *      → dashboard.html（同数据，保留导航栏壳）
 *   3) git add/commit/push → springhill-hub/operation-dashboard
 *   4) lark-cli 更新飞书外盘文档 html5-block，并回验数据日期
 *
 * 运行：node deploy-dashboard.js [--Date=2026-10-06] [--CommitMessage=x]
 *                                [--skipGit] [--skipLark]
 * 环境：CS_ROOT（项目根目录，默认 f:/ai agent）、LARK_CLI_BIN（默认 lark-cli）
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const opt = (k, def) => {
  const hit = argv.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const DateArg = opt('Date', TODAY);
const CommitMessage = opt('CommitMessage', '');
const SKIP_GIT = has('--skipGit');
const SKIP_LARK = has('--skipLark');

// ---------- 路径常量 ----------
const ROOT = process.env.CS_ROOT || 'f:/ai agent';
const DEPLOY = path.join(ROOT, 'deploy');
const SourceHtml = path.join(ROOT, '经营看板.html');
const DataJson = path.join(ROOT, 'operation_data.json');
const WidgetHtml = path.join(DEPLOY, 'widget.html');
const IndexHtml = path.join(DEPLOY, 'index.html');
const DashboardHtml = path.join(DEPLOY, 'dashboard.html');
const LarkCli = process.env.LARK_CLI_BIN || (process.platform === 'win32'
  ? 'C:/Users/DCKJ/.trae-cn/plugins/trae-remote-official/lark/1.0.5/bin/lark-cli.exe'
  : 'lark-cli');

const LarkDocId = process.env.LARK_DOC_ID || 'HLvidGwVroPZRxxjngdclO2SnQb';
const PagesUrl = 'https://springhill-hub.github.io/operation-dashboard/';
const LarkDocUrl = 'https://scnnkf4b8hxl.feishu.cn/docx/HLvidGwVroPZRxxjngdclO2SnQb';

const GIT_FILES = ['index.html', 'widget.html', 'dashboard.html', 'deploy-dashboard.js',
  'daily-refresh.sh', 'portal.html', 'build-crossborder.js', 'build-shopee.js',
  'build-msku-cost.js', 'build-rakuten.js', 'build-coupang.js',
  'pull-coupang.js', 'pull-shopee.js', 'pull-platform-orders.js', 'pull-msku-cost.js',
  'cost-lib.js',
  'msku-cost.json', 'jp-msku-cost.json', '.gitignore', 'operation_data.json'];

const step = m => console.log(`\n[STEP] ${m}`);
const ok = m => console.log(`  [OK] ${m}`);
const info = m => console.log(`  [..] ${m}`);
const die = (s, d) => { console.error(`  [ERR] ${s} 失败：${d}`); console.error(`\n========== 部署中止（${s}）==========`); process.exit(1); };

function run(cmd, args, allowFail) {
  try {
    return execFileSync(cmd, args, { cwd: DEPLOY, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 }).trim();
  } catch (e) {
    if (allowFail) return ((e.stdout || '') + '\n' + (e.stderr || '')).trim();
    die('命令执行', `${cmd} ${args.join(' ')}\n${(e.stderr || e.stdout || e.message)}`);
  }
}

// lark-cli 调用：返回 {code, out}，不因非零退出直接终止
function lark(args, allowFail) {
  try {
    const out = execFileSync(LarkCli, args, { cwd: DEPLOY, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 });
    return { code: 0, out };
  } catch (e) {
    const out = ((e.stdout || '') + '\n' + (e.stderr || '')).trim();
    if (allowFail) return { code: e.status || 1, out };
    throw new Error(out || e.message);
  }
}

function larkError(out) {
  if (!/"ok"\s*:\s*false/.test(out)) return null;
  const subtype = (out.match(/"subtype"\s*:\s*"([^"]+)"/) || [])[1] || '';
  const message = (out.match(/"message"\s*:\s*"([^"]+)"/) || [])[1] || '';
  if (subtype === 'not_configured') {
    return '飞书凭据未配置（config/not_configured）。请在服务器执行 lark-cli auth login 完成用户授权。';
  }
  return `lark-cli 返回错误(${subtype})：${message}`;
}

const start = Date.now();
console.log('========================================');
console.log(`  春山户外经营看板 · 每日刷新部署 · ${DateArg}`);
console.log(`  ROOT=${ROOT}`);
console.log('========================================');

// ---------- Step 1: 校验数据 ----------
step('1/4 校验数据源 operation_data.json');
if (!fs.existsSync(DataJson)) die('Step1-数据校验', `文件不存在：${DataJson}`);
let rawJson, dataObj;
try {
  rawJson = fs.readFileSync(DataJson, 'utf8');
  dataObj = JSON.parse(rawJson);
} catch (e) { die('Step1-数据校验', `JSON解析失败：${e.message}`); }
const genAt = dataObj.meta && dataObj.meta.generatedAt;
ok(`JSON有效，generatedAt=${genAt}`);

// ---------- Step 2: 内嵌 ----------
step('2/4 内嵌JSON到HTML（经营看板.html + widget.html + index.html + dashboard.html）');
if (!fs.existsSync(SourceHtml)) die('Step2-HTML模板', `源文件不存在：${SourceHtml}`);
const htmlTemplate = fs.readFileSync(SourceHtml, 'utf8');
const compactJson = JSON.stringify(dataObj);
const startTag = '<script id="DATA-JSON" type="application/json">';
const endTag = '</script>';

function embed(tpl, label) {
  const s = tpl.indexOf(startTag);
  if (s < 0) die(`Step2-${label}`, '未找到 DATA-JSON script 开始标签');
  const e = tpl.indexOf(endTag, s);
  if (e < 0) die(`Step2-${label}`, '未找到 DATA-JSON script 结束标签');
  return tpl.slice(0, s + startTag.length) + '\n' + compactJson + '\n' + tpl.slice(e);
}
function applyTabDates(h) {
  const todayDate = dataObj.today.date;
  const short = r => String(r || '').replace(/^\d{4}-(\d{2}-\d{2}) ~ \d{4}-(\d{2}-\d{2})$/, '$1 ~ $2');
  const weekShort = short(dataObj.week.range);
  const monthShort = short(dataObj.month.range);
  const rep = (id, v) => {
    h = h.replace(new RegExp('(<div class="d" id="' + id + '">)[^<]*(</div>)'), '$1' + v + '$2');
  };
  rep('tabD-today', todayDate);
  rep('tabD-week', weekShort);
  rep('tabD-month', monthShort);
  info(`tab日期: today=${todayDate} week=${weekShort} month=${monthShort}（${labelGlobal}）`);
  return h;
}
let labelGlobal = '源模板';
let newHtml = embed(htmlTemplate, 'HTML替换');
labelGlobal = '经营看板';
newHtml = applyTabDates(newHtml);
fs.writeFileSync(SourceHtml, newHtml, 'utf8');
ok('经营看板.html 源文件已同步更新');
fs.writeFileSync(WidgetHtml, newHtml, 'utf8');
ok('widget.html 已生成（含meta，飞书用）');

let indexContent = newHtml
  .replace(/^<meta name="use-iframe" content="true">\r?\n/m, '')
  .replace(/^<meta name="html-box-height-mode" content="auto">\r?\n/m, '')
  .replace(/^<meta name="description" content="[^"]*">\r?\n/m, '');
fs.writeFileSync(IndexHtml, indexContent, 'utf8');
ok('index.html 已生成（GitHub Pages版，去meta）');

if (!fs.existsSync(DashboardHtml)) die('Step2-HTML模板', `文件不存在：${DashboardHtml}`);
let dashHtml = embed(fs.readFileSync(DashboardHtml, 'utf8'), 'dashboard替换');
labelGlobal = 'dashboard';
dashHtml = applyTabDates(dashHtml);
fs.writeFileSync(DashboardHtml, dashHtml, 'utf8');
ok('dashboard.html 已内嵌最新数据（保留导航栏壳）');

// ---------- Step 3: git ----------
if (SKIP_GIT) {
  step('3/4 [跳过] git push（--skipGit）');
} else {
  step('3/4 git 提交并推送 GitHub Pages');
  // operation_data.json 工作副本在 ROOT，纳入仓库供 GitHub Actions 读取（乐天成本参考）
  fs.copyFileSync(DataJson, path.join(DEPLOY, 'operation_data.json'));
  run('git', ['add', ...GIT_FILES]);
  const staged = run('git', ['diff', '--cached', '--name-only'], true);
  if (!staged) {
    ok('数据无变化，跳过 commit/push');
  } else {
    info('staged: ' + staged.replace(/\n/g, ', '));
    const msg = CommitMessage || `每日刷新 ${DateArg}`;
    run('git', ['commit', '-m', msg]);
    run('git', ['push', 'origin', 'main']);
    ok('推送完成');
  }
}

// ---------- Step 4: 飞书 ----------
if (SKIP_LARK) {
  step('4/4 [跳过] 飞书文档更新（--skipLark）');
} else {
  step('4/4 更新飞书文档 html5-block');
  const maxAttempts = 3;
  let done = false, lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts && !done; attempt++) {
    try {
      if (attempt > 1) { info(`第 ${attempt} 次重试（等待15s）`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000); }
      info('fetch 文档定位当前 html5-block id');
      const f = lark(['docs', '+fetch', '--doc', LarkDocId, '--detail', 'with-ids', '--as', 'user'], true);
      const ce = larkError(f.out);
      if (ce) throw new Error(ce);
      const mm = f.out.match(/<html5-block[^>]*id=\\?"([A-Za-z0-9]+)\\?"/);
      if (!mm) throw new Error('fetch 成功但未匹配到 html5-block（文档结构可能被改动），请人工检查飞书文档');
      const curBlockId = mm[1];
      info(`当前 html5-block id=${curBlockId}`);
      const u = lark(['docs', '+update', '--doc', LarkDocId, '--command', 'block_replace',
        '--block-id', curBlockId,
        '--content', "<html5-block path='@./widget.html'/>",
        '--reference-map', '@./reference-map.json', '--as', 'user'], true);
      const ue = larkError(u.out);
      if (u.code !== 0 || ue) throw new Error(ue || u.out.slice(-500));
      ok('飞书文档 html5-block 已更新');
      done = true;
    } catch (e) {
      lastErr = e.message;
      if (/not_configured/.test(lastErr)) break;
      if (attempt === maxAttempts) break;
      info('本轮失败：' + lastErr);
    }
  }
  if (!done) die('Step4-lark', `重试 ${maxAttempts} 次仍失败：${lastErr}`);

  // 4.3 回验：重新 fetch，确认 block 内数据日期为本次日期
  info('回验 block 内数据日期...');
  const v = lark(['docs', '+fetch', '--doc', LarkDocId, '--detail', 'with-ids', '--as', 'user'], true);
  const ve = larkError(v.out);
  if (ve) die('Step4-lark回验', ve);
  const rel = (v.out.match(/"path"\s*:\s*"(@doc-fetch-resources\/[^"]+)"/) || [])[1];
  const vDate = (() => {
    // 优先从落盘资源文件读；找不到则直接在 fetch 输出中匹配
    if (rel) {
      for (const base of [DEPLOY, ROOT]) {
        const p = path.join(base, rel.replace(/^@/, ''));
        if (fs.existsSync(p)) {
          const h = fs.readFileSync(p, 'utf8');
          const m = h.match(/"today"\s*:\s*\{[^}]*?"date"\s*:\s*"([^"]+)"/);
          if (m) return m[1];
        }
      }
    }
    const m = v.out.match(/"today"\s*:\s*\{[^}]*?"date"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  })();
  const expectDate = dataObj.today.date;
  if (vDate !== expectDate) {
    die('Step4-lark回验', `block 内 today=${vDate}，期望 ${expectDate}（block_replace 可能未生效或CDN缓存，需人工排查）`);
  }
  ok(`回验通过：飞书 block 内 today=${vDate}（与 operation_data.json 一致）`);
}

console.log('\n========================================');
console.log(`  部署完成 ｜ 耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`);
console.log('========================================');
console.log(`  GitHub Pages：${PagesUrl}`);
console.log(`  飞书文档：  ${LarkDocUrl}`);
process.exit(0);
