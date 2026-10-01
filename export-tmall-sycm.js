/**
 * 生意参谋「商品-全部/商品排行」自动导出（天猫销量兜底管线，奇门恢复前使用）
 *
 * 用法：
 *   node export-tmall-sycm.js              导出上个月（自动按当前日期推算）
 *   node export-tmall-sycm.js 2026-09      导出指定月份
 *   node export-tmall-sycm.js 2026-09 --no-parse   只下载不解析
 *
 * 机制：Edge持久化登录目录，首次运行需人工扫码一次；之后免登录。
 *   全程同一浏览器上下文下载（避免cookie迁移导致拿到HTML登录页）；
 *   落盘后强制校验OLE/ZIP文件头，拒绝HTML伪文件；下载完成自动串联 parse-tmall-sycm.js。
 *   出现滑块/验证码时暂停等人工完成，绝不自动破解。
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = 'f:/ai agent';
const INBOX = path.join(ROOT, 'tmall-inbox');
const PROFILE = path.join(INBOX, '.browser-profile');
const LOG = path.join(INBOX, 'export-tmall.log');
fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n', 'utf8');
}

function monthRange(arg) {
  let y, m;
  if (/^\d{4}-\d{2}$/.test(arg || '')) { [y, m] = arg.split('-').map(Number); }
  else {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    y = d.getFullYear(); m = d.getMonth() + 1;
  }
  const last = new Date(y, m, 0).getDate();
  const mm = String(m).padStart(2, '0');
  return { tag: `${y}-${mm}`, start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 页面是否处于登录/验证状态
async function loginState(page) {
  const u = page.url();
  if (/login\.taobao|passport\.taobao|i\.taobao\.com\/\w*login/i.test(u)) return 'login';
  const hit = await page.evaluate(() => {
    const t = document.body ? document.body.innerText.slice(0, 3000) : '';
    if (/请按住滑块|滑动验证|安全验证|点击.*验证/.test(t)) return 'slider';
    if (/扫码登录|二维码登录|请登录|登录后查看/.test(t)) return 'login';
    const qr = document.querySelector('iframe[src*="login"], #J_QRCodeImg, .qr-form, .nc-container');
    return qr ? 'login' : '';
  }).catch(() => '');
  return hit;
}

// 点击"下载/导出"按钮（文本匹配，容错多版本DOM）
async function clickDownload(page) {
  const handles = await page.evaluateHandle(() => {
    const nodes = [...document.querySelectorAll('button,a,span,div')];
    return nodes.filter(el => {
      const txt = (el.innerText || '').trim();
      if (!txt || txt.length > 8) return false;
      if (!/^(下载|导出|下载数据|导出数据)$/.test(txt)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).map(el => {
      // 取最近的可点击祖先
      let p = el;
      for (let i = 0; i < 3 && p; i++) {
        if (/button|a/i.test(p.tagName) || p.getAttribute('role') === 'button') break;
        p = p.parentElement;
      }
      (p || el).setAttribute('data-sycm-dl', '1');
      return true;
    });
  });
  await handles.dispose();
  const btn = page.locator('[data-sycm-dl="1"]').first();
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await btn.click({ timeout: 15000 });
  log('已点击下载按钮');
}

// 处理可能出现的确认弹窗（最多检查几轮）
async function confirmDialogs(page) {
  for (let i = 0; i < 5; i++) {
    await sleep(1200);
    const clicked = await page.evaluate(() => {
      const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const label = e => (e.innerText || '').trim();
      const sels = ['.ant-modal-footer button.ant-btn-primary', '.next-dialog-btn-primary',
        '[class*="modal"] [class*="primary"]', '[class*="dialog"] [class*="primary"]', '[class*="Modal"] button'];
      for (const s of sels) {
        const b = [...document.querySelectorAll(s)].find(e => visible(e) && /确定|确认|下载|导出/.test(label(e)));
        if (b) { b.click(); return label(b); }
      }
      // role=dialog 兜底
      const dlg = document.querySelector('[role="dialog"]:not([style*="display: none"])');
      if (dlg) {
        const b = [...dlg.querySelectorAll('button,a')].find(e => visible(e) && /确定|确认|下载/.test(label(e)));
        if (b) { b.click(); return label(b); }
      }
      return '';
    }).catch(() => '');
    if (!clicked) {
      // 再看是否有"全量下载/下载全部数据"单选项需要勾
      const picked = await page.evaluate(() => {
        const el = [...document.querySelectorAll('label,span,div')].find(e =>
          /下载全部|全量下载|全部数据|下载当前条件/.test((e.innerText||'')) && e.getBoundingClientRect().width > 0);
        if (el) { el.click(); return true; } return false;
      }).catch(() => false);
      if (!picked) break;
      log('弹窗中选择了"全部数据"选项');
      continue;
    }
    log(`弹窗已确认：${clicked}`);
  }
}

function validOfficeFile(p) {
  if (!fs.existsSync(p)) return '文件不存在';
  const size = fs.statSync(p).size;
  if (size < 3000) return `文件过小(${size}B)`;
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(8);
  fs.readSync(fd, buf, 0, 8, 0);
  fs.closeSync(fd);
  const hex = buf.toString('hex').toUpperCase();
  const head = buf.toString('utf8');
  if (hex.startsWith('D0CF11E0')) return '';           // xls OLE2
  if (hex.startsWith('504B0304')) return '';           // xlsx zip
  if (/^\s*<(!DOCTYPE|html|HEAD)/i.test(head)) return '内容是HTML（登录页/风控页），非Excel';
  return `文件头异常: ${hex.slice(0, 8)}`;
}

(async () => {
  const arg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
  const noParse = process.argv.includes('--no-parse');
  const { tag, start, end } = monthRange(arg);
  const url = `https://sycm.taobao.com/cc/item_rank?dateRange=${start}%7C${end}&dateType=month`;
  log(`==== 导出 ${tag} ====`);
  log(`目标页: ${url}`);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  ctx.setDefaultTimeout(20000);
  const page = ctx.pages()[0] || await ctx.newPage();

  // 全局下载捕获（含弹窗/新页触发的情况）
  let download = null;
  ctx.on('download', d => { if (!download) download = d; });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);

    // 1) 登录/验证：人工处理，最长等6分钟
    let state = await loginState(page);
    if (state) {
      log(state === 'slider' ? '检测到滑块验证 → 请在浏览器中手动完成' : '未登录 → 请用【生意参谋只读子账号】扫码登录');
      const t0 = Date.now();
      while (Date.now() - t0 < 360000) {
        await sleep(3000);
        const s = await loginState(page);
        if (!s && /sycm\.taobao\.com\/cc\/item_rank/.test(page.url())) break;
      }
      state = await loginState(page);
      if (state) throw new Error('等待登录超时（6分钟），下次运行会继续复用登录态');
      log('登录成功');
      // 登录后可能回首页，重新打开目标月
      if (!/\/cc\/item_rank/.test(page.url())) await page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(4000);
    }

    // 2) 等数据表格加载
    log('等待报表数据加载…');
    await page.waitForSelector('table tbody tr, .ant-table-tbody tr, [class*="Rank"] tr, [class*="rank"] tr',
      { timeout: 60000 }).catch(() => log('[警告] 未识别到表格行，仍尝试点下载'));
    await sleep(2000);

    // 3) 点下载 → 处理弹窗 → 等下载完成
    await clickDownload(page);
    await confirmDialogs(page);
    log('等待浏览器下载（最多3分钟）…');
    const t1 = Date.now();
    while (!download && Date.now() - t1 < 180000) {
      // 中途冒出滑块 → 人工处理
      if (await loginState(page) === 'slider') log('检测到滑块 → 请手动完成，下载将继续等待');
      await sleep(2000);
    }
    if (!download) throw new Error('3分钟内未捕获到下载文件（可能弹窗结构变化或被风控）');

    const suggested = download.suggestedFilename() || `sycm_${tag}.xls`;
    const safeName = `sycm_${tag}_${suggested}`.replace(/[\\/:*?"<>|]/g, '_');
    const outPath = path.join(INBOX, safeName);
    await download.saveAs(outPath);
    log(`已保存: ${outPath} (${fs.statSync(outPath).size} B)`);

    // 4) 文件头硬校验
    const bad = validOfficeFile(outPath);
    if (bad) throw new Error(`文件校验失败：${bad}`);
    log('文件校验通过（Excel格式）');

    // 5) 自动解析
    if (!noParse) {
      log('串联解析器…');
      const r = spawnSync('node', [path.join(__dirname, 'parse-tmall-sycm.js'), outPath], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('解析器返回非0，请查看上方输出');
    }
    log('==== 全部完成 ====');
  } catch (e) {
    log(`[失败] ${e.message}`);
    // 失败时保留现场：截图+URL，便于排查
    try {
      await page.screenshot({ path: path.join(INBOX, `error_${tag}.png`), fullPage: false });
      log(`现场截图: ${path.join(INBOX, `error_${tag}.png`)} | 当前URL: ${page.url()}`);
    } catch (_) {}
    process.exitCode = 1;
  } finally {
    await sleep(2000);
    await ctx.close();
  }
})();
