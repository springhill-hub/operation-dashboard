/* ============================================================
 * 库存看板部署脚本（本地/云端通用）
 * ------------------------------------------------------------
 * 本地（Windows）: 模板=f:/ai agent/库存看板.html，数据=f:/ai agent/inventory_data.json
 * 云端（/opt/chunshan）: 模板=deploy/inventory.html（仓库内自替换DATA-JSON块）
 * 数据注入后可选 --push 自动 git commit/push（云端定时任务用）
 * 运行：node deploy-inventory.js [--push]
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = process.env.CS_ROOT || (process.platform === 'win32' ? 'f:/ai agent' : '/opt/chunshan');
const DEPLOY_DIR = path.join(ROOT, 'deploy');
const DATA_JSON = path.join(ROOT, 'inventory_data.json');
const LOCAL_SRC = path.join(ROOT, '库存看板.html');
// 本地用源模板；云端源模板不入库，用仓库内 inventory.html 自替换（UI更新随git pull同步）
const SOURCE_HTML = fs.existsSync(LOCAL_SRC) ? LOCAL_SRC : path.join(DEPLOY_DIR, 'inventory.html');
const PUSH = process.argv.includes('--push');

console.log('模板: ' + SOURCE_HTML);

// 读取数据
const D = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8'));
const dataStr = JSON.stringify(D, null, 2);

// 读取HTML
let html = fs.readFileSync(SOURCE_HTML, 'utf8');

// 替换 DATA-JSON
const startTag = '<script id="DATA-JSON" type="application/json">';
const startIdx = html.indexOf(startTag);
if (startIdx < 0) throw new Error('找不到 DATA-JSON 标签');
const contentStart = startIdx + startTag.length;
const endIdx = html.indexOf('</script>', contentStart);
html = html.slice(0, contentStart) + '\n' + dataStr + '\n' + html.slice(endIdx);

// 写回源文件（云端源与产物同文件，等价幂等）
fs.writeFileSync(SOURCE_HTML, html, 'utf8');
console.log('[OK] 源文件已更新: ' + SOURCE_HTML);

// 写入 deploy 目录
fs.writeFileSync(path.join(DEPLOY_DIR, 'inventory.html'), html, 'utf8');
console.log('[OK] inventory.html 已生成');

if (!PUSH) {
  console.log('\n部署文件就绪，请手动 git push 到 GitHub Pages（或加 --push 自动推送）');
  return;
}

// ---------- 自动 git 提交推送（云端） ----------
const sh = cmd => execSync(cmd, { cwd: DEPLOY_DIR, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
try { sh('git config user.name >/dev/null 2>&1 || git config user.name "chunshan-bot"'); } catch (e) {}
try { sh('git config user.email >/dev/null 2>&1 || git config user.email "bot@chunshan.local"'); } catch (e) {}
sh('git add inventory.html');
try {
  sh('git diff --cached --quiet');
  console.log('[GIT] inventory.html 无变化，跳过提交');
} catch (e) {
  const today = new Date().toISOString().slice(0, 10);
  sh(`git commit -m "库存看板刷新 ${today}"`);
  // 服务器工作区可能有其他脚本的未提交改动，rebase失败时自动stash
  try {
    sh('git pull --rebase origin main');
  } catch (e) {
    sh('git stash push -m "deploy-inventory-auto"');
    sh('git pull --rebase origin main');
    try { sh('git stash pop'); } catch (e2) { console.log('  [WARN] stash pop冲突，已保留在stash中'); }
  }
  sh('git push origin main');
  console.log('[GIT] 已提交并推送 origin main');
}
