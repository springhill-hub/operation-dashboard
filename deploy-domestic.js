/* ============================================================
 * 春山户外 · 国内经营看板部署脚本（方案A · v1.0）
 * ------------------------------------------------------------
 * 将国内看板以独立路径部署到现有 operation-dashboard 仓库：
 *   Step1 校验 domestic_data.json
 *   Step2 读 国内经营看板.html（已由 embed-domestic.js 内嵌数据）
 *         → domestic-widget.html（含meta，飞书用）
 *         → domestic.html（去meta，GitHub Pages 独立路径）
 *   Step3 git add/commit/push → springhill-hub/operation-dashboard
 *   Step4 飞书独立文档 html5-block 更新（需配置 LARK_DOC_ID）
 * 运行：node deploy-domestic.js [--skipGit] [--skipLark] [--rebuild]
 *   --rebuild: 部署前先跑 build-domestic.js + embed-domestic.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = new Set(process.argv.slice(2));
const SKIP_GIT = args.has('--skipGit');
const SKIP_LARK = args.has('--skipLark');
const REBUILD = args.has('--rebuild');

const ROOT = 'f:/ai agent';
const DEPLOY = path.join(ROOT, 'deploy');
const SRC_HTML = path.join(ROOT, '国内经营看板.html');
const DATA_JSON = path.join(ROOT, 'domestic_data.json');
const WIDGET = path.join(DEPLOY, 'domestic-widget.html');
const PAGES = path.join(DEPLOY, 'domestic.html');
const LARK_CLI = 'C:/Users/DCKJ/.trae-cn/plugins/trae-remote-official/lark/1.0.5/bin/lark-cli.exe';

// 飞书独立文档配置（首次需创建文档后填入；留空则跳过并提示）
const LARK_DOC_ID = process.env.DOMESTIC_LARK_DOC_ID || '';

const GIT_FILES = [
  'domestic.html', 'domestic-widget.html',
  'build-domestic.js', 'embed-domestic.js',
  'smoke-domestic.js', 'check-domestic-syntax.js',
  'deploy-domestic.js',
];

const step = m => console.log(`\n[STEP] ${m}`);
const ok = m => console.log(`  [OK] ${m}`);
const info = m => console.log(`  [..] ${m}`);
const sh = (cmd, allowFail) => {
  try { return execSync(cmd, { cwd: DEPLOY, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (e) {
    if (allowFail) return (e.stdout || '').trim();
    console.error(`  [ERR] ${cmd}\n${e.stderr || e.message}`);
    process.exit(1);
  }
};

(async () => {
  const t0 = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  console.log('========================================');
  console.log(`  国内经营看板部署 · ${today}`);
  console.log('========================================');

  // --rebuild: 先拉数再内嵌
  if (REBUILD) {
    step('0/4 rebuild（build-domestic + embed-domestic）');
    sh(`node "${path.join(DEPLOY, 'build-domestic.js')}" --days=60`);
    sh(`node "${path.join(DEPLOY, 'embed-domestic.js')}"`);
    ok('数据已重建并内嵌');
  }

  // Step1 校验 JSON
  step('1/4 校验 domestic_data.json');
  const raw = fs.readFileSync(DATA_JSON, 'utf8');
  const data = JSON.parse(raw);
  ok(`JSON有效，generatedAt=${data.meta.generatedAt}，reconcile=${data.meta.reconcile}`);

  // Step2 生成部署文件
  step('2/4 生成 domestic.html + domestic-widget.html');
  let html = fs.readFileSync(SRC_HTML, 'utf8');
  // widget：原样（含meta）
  fs.writeFileSync(WIDGET, html, 'utf8');
  ok('domestic-widget.html（含meta，飞书用）');
  // pages：去掉3个meta标签
  const pagesHtml = html
    .replace(/^<meta name="use-iframe" content="true">\r?\n/m, '')
    .replace(/^<meta name="html-box-height-mode" content="auto">\r?\n/m, '')
    .replace(/^<meta name="description" content="[^"]*">\r?\n/m, '');
  fs.writeFileSync(PAGES, pagesHtml, 'utf8');
  ok('domestic.html（GitHub Pages版，去meta）');

  // Step3 git
  if (SKIP_GIT) {
    step('3/4 [跳过] git push（--skipGit）');
  } else {
    step('3/4 git 提交并推送 operation-dashboard（独立路径）');
    sh(`git add ${GIT_FILES.map(f => `"${f}"`).join(' ')}`);
    const staged = sh('git diff --cached --name-only', true);
    if (!staged) {
      ok('无变更，跳过 commit/push');
    } else {
      info(`staged: ${staged.replace(/\n/g, ', ')}`);
      sh(`git commit -m "国内经营看板 ${today}"`);
      sh('git push origin main');
      ok('推送完成');
    }
  }

  // Step4 飞书
  if (SKIP_LARK) {
    step('4/4 [跳过] 飞书更新（--skipLark）');
  } else if (!LARK_DOC_ID) {
    step('4/4 [跳过] 飞书更新（未配置 DOMESTIC_LARK_DOC_ID）');
    info('创建独立飞书文档后，设置环境变量 $env:DOMESTIC_LARK_DOC_ID="docId" 再跑本脚本');
  } else {
    step('4/4 更新飞书独立文档 html5-block');
    if (!fs.existsSync(LARK_CLI)) { console.error('lark-cli 不存在'); process.exit(1); }
    // 动态定位 html5-block id
    const fetchOut = sh(`"${LARK_CLI}" docs +fetch --doc ${LARK_DOC_ID} --detail with-ids --as user`, true);
    const m = `${fetchOut}`.match(/<html5-block[^>]*id=\\?"([A-Za-z0-9]+)\\?"/);
    if (!m) {
      // 文档无 html5-block → 新建块
      info('文档中无 html5-block，尝试 append 创建');
      sh(`"${LARK_CLI}" docs +update --doc ${LARK_DOC_ID} --command block_insert_after --content "<html5-block path='@./domestic-widget.html'/>" --reference-map "@./reference-map.json" --as user`);
    } else {
      const blockId = m[1];
      info(`html5-block id=${blockId}`);
      sh(`"${LARK_CLI}" docs +update --doc ${LARK_DOC_ID} --command block_replace --block-id ${blockId} --content "<html5-block path='@./domestic-widget.html'/>" --reference-map "@./reference-map.json" --as user`);
    }
    ok('飞书独立文档已更新');
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n========================================');
  console.log(`  部署完成 · ${secs}s`);
  console.log('========================================');
  console.log(`  GitHub Pages：https://springhill-hub.github.io/operation-dashboard/domestic.html`);
  if (LARK_DOC_ID) console.log(`  飞书文档：https://scnnkf4b8hxl.feishu.cn/docx/${LARK_DOC_ID}`);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
