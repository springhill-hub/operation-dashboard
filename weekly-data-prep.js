#!/usr/bin/env node
// ============================================================
// 春山户外 · 周度经营策划数据准备（weekly-data-prep.ps1 的跨平台 Node 版）
// ------------------------------------------------------------
// 设计运行时点：每周一 08:30 日报刷新成功后，由 daily-refresh.sh 调用。
//   此时 operation_data.json 的 week=T-7~T-1 恰为「上周一~周日」完整自然周。
// 输入：$CS_ROOT/operation_data.json（外盘 lastWeek/week）
//       $CS_ROOT/domestic_data.json（内盘 lastWeek/week）
//       deploy/inventory-data.json 的 alerts（可选；当前无此文件，alerts 为空）
// 输出：deploy/weekly-data.json + deploy/weekly-prompt.txt（weekly.html 线上消费）
// 参数：--weekStart=YYYY-MM-DD  指定周一；--no-git 不提交推送（验证用）
// ============================================================
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = process.env.CS_ROOT || (process.platform === 'win32' ? 'f:/ai agent' : '/opt/chunshan');
const DEPLOY = path.join(ROOT, 'deploy');

// ---------- 参数 ----------
const argWS = process.argv.find(a => a.startsWith('--weekStart='));
const NO_GIT = process.argv.includes('--no-git');
let weekStart = argWS ? argWS.split('=')[1] : '';

// ---------- 日期工具 ----------
const pad2 = n => String(n).padStart(2, '0');
function fmt(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// 计算上周一~上周日（与 ps1 相同：周一=0 历）
if (!weekStart) {
  const now = new Date();
  const daysSinceMonday = (now.getDay() + 6) % 7; // 周一=0
  const lastMonday = new Date(now);
  lastMonday.setDate(now.getDate() - daysSinceMonday - 7);
  weekStart = fmt(lastMonday);
}
const startDate = new Date(weekStart + 'T00:00:00');
const endDate = new Date(startDate);
endDate.setDate(startDate.getDate() + 6);
const weekEnd = fmt(endDate);
console.log(`拉取周数据: ${weekStart} ~ ${weekEnd}`);

// ---------- 读数 ----------
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const op = readJSON(path.join(ROOT, 'operation_data.json'));
const dom = readJSON(path.join(ROOT, 'domestic_data.json'));
const { lastWeek, week } = op;
const { lastWeek: domLastWeek, week: domWeek } = dom;

// 环比：保留 1 位小数；任一值缺失为 null（与 ps1 一致）
const wow = (cur, prev) => (prev && cur) ? Math.round((cur - prev) / prev * 1000) / 10 : null;
// null 安全拼接（ps1 中 null 渲染为空串）
const v0 = x => (x === null || x === undefined) ? '' : x;

// ---------- 汇总结构 ----------
const weekly = {
  weekStart,
  weekEnd,
  generatedAt: nowStamp(),
  crossborder: { lastWeek, week, channels: {} },
  domestic: { lastWeek: domLastWeek, week: domWeek, channels: {} },
  topSkus: [],
  alerts: []
};

// ---------- 外盘：settlement 各渠道 ----------
if (lastWeek && lastWeek.settlement) {
  for (const [name, lw] of Object.entries(lastWeek.settlement)) {
    const w = (week.settlement && week.settlement[name]) || null;
    weekly.crossborder.channels[name] = {
      lastWeek: { net: lw.net, profit: lw.profit, margin: lw.margin, qty: lw.qty },
      week: w ? { net: w.net, profit: w.profit, margin: w.margin, qty: w.qty }
              : { net: null, profit: null, margin: null, qty: null },
      wowNet: wow(w && w.net, lw.net),
      wowProfit: wow(w && w.profit, lw.profit)
    };
  }
}

// ---------- 外盘：日亚单独（与 ps1 相同，key=日本-亚马逊，后写覆盖同名） ----------
if (lastWeek && lastWeek.amazonJP) {
  const jpLw = lastWeek.amazonJP;
  const jpW = week.amazonJP || {};
  weekly.crossborder.channels['日本-亚马逊'] = {
    lastWeek: { net: jpLw.net, profit: jpLw.gp, margin: jpLw.margin, qty: jpLw.qty, orders: jpLw.orders },
    week: { net: jpW.net, profit: jpW.gp, margin: jpW.margin, qty: jpW.qty, orders: jpW.orders },
    wowNet: wow(jpW.net, jpLw.net),
    wowProfit: wow(jpW.gp, jpLw.gp)
  };
}

// ---------- 内盘：各渠道 ----------
if (domLastWeek && domLastWeek.channels) {
  for (const [name, lw] of Object.entries(domLastWeek.channels)) {
    const w = (domWeek.channels && domWeek.channels[name]) || {};
    weekly.domestic.channels[name] = {
      lastWeek: { net: lw.net, profit: lw.profit, margin: lw.margin, orders: lw.orders },
      week: { net: w.net, profit: w.profit, margin: w.margin, orders: w.orders },
      wowNet: wow(w.net, lw.net),
      wowProfit: wow(w.profit, lw.profit)
    };
  }
}

// ---------- TOP 10 利润 SKU ----------
const allSkus = [];
if (week.amazonJP && Array.isArray(week.amazonJP.skuDetail)) {
  for (const s of week.amazonJP.skuDetail) {
    if (s.profit && s.profit > 0) {
      allSkus.push({ msku: s.msku, name: s.name, platform: '日亚', qty: s.qty, net: s.net, profit: s.profit, margin: s.margin });
    }
  }
}
const rakuten = week.settlement && week.settlement['日本-乐天'];
if (rakuten && Array.isArray(rakuten.skuDetail)) {
  for (const s of rakuten.skuDetail) {
    if (s.profit && s.profit > 0) {
      allSkus.push({ msku: s.msku, name: s.name, platform: '乐天', qty: s.qty, net: s.net, profit: s.profit, margin: s.margin });
    }
  }
}
weekly.topSkus = allSkus.sort((a, b) => b.profit - a.profit).slice(0, 10);

// ---------- 库存预警（软对接：文件缺失/无 alerts 则为空，与历史实际行为一致） ----------
try {
  const inv = readJSON(path.join(DEPLOY, 'inventory-data.json'));
  if (Array.isArray(inv.alerts)) weekly.alerts = inv.alerts;
} catch (e) { /* 无文件：alerts 留空 */ }

// ---------- 写 weekly-data.json ----------
fs.writeFileSync(path.join(DEPLOY, 'weekly-data.json'), JSON.stringify(weekly, null, 2), 'utf8');
console.log(`✅ weekly-data.json 已生成: ${weekly.topSkus.length} 个TOP SKU, ${weekly.alerts.length} 条预警`);

// ---------- 生成策划提示文本（模板与 ps1 一致） ----------
let prompt = `【春山户外 · 周度经营策划请求】
周区间: ${weekStart} ~ ${weekEnd}

## 数据摘要
### 外盘（环比上周）`;
for (const [name, c] of Object.entries(weekly.crossborder.channels)) {
  prompt += `\n- ${name}: 净销售额 ${v0(c.week.net)} (环比 ${v0(c.wowNet)}%), 毛利 ${v0(c.week.profit)} (环比 ${v0(c.wowProfit)}%), 毛利率 ${v0(c.week.margin)}%`;
}
prompt += `\n\n### 内盘（环比上周）`;
for (const [name, c] of Object.entries(weekly.domestic.channels)) {
  prompt += `\n- ${name}: 净销售额 ${v0(c.week.net)} (环比 ${v0(c.wowNet)}%), 毛利 ${v0(c.week.profit)} (环比 ${v0(c.wowProfit)}%), 毛利率 ${v0(c.week.margin)}%`;
}
prompt += `\n\n### TOP 10 利润 SKU`;
for (const s of weekly.topSkus) {
  prompt += `\n- [${s.platform}] ${s.name}: 销量 ${s.qty}, 净销售额 ${s.net}, 毛利 ${s.profit}, 毛利率 ${s.margin}%`;
}
prompt += `\n\n### 库存预警`;
for (const a of weekly.alerts) {
  prompt += `\n- ${a.message}`;
}
prompt += `

## 任务
请基于以上数据，生成本周（${weekStart} 起）经营策划方案：
1. 【高利润产品聚焦】分析 TOP SKU 的共性（品类/价格带/平台），建议主推资源分配
2. 【增量机会】识别环比下滑渠道的原因，提出 2-3 个可落地的增量活动（促销/内容/新品）
3. 【库存协同】结合预警 SKU，建议补货或清仓节奏
4. 【平台策略】针对各平台特性（日亚精细化/乐天促销/ Coupang 物流/Shopee 价格敏感/内盘内容电商），给出差异化建议
5. 【本周必干】列出 5 项可执行动作，标注负责渠道和预期效果

输出格式：Markdown，可直接粘贴到 weekly.html 的策划方案区。
`;

fs.writeFileSync(path.join(DEPLOY, 'weekly-prompt.txt'), prompt, 'utf8');
console.log('✅ weekly-prompt.txt 已生成（可复制给AI生成详细方案）');

// ---------- git 提交推送（weekly.html 从 Pages fetch 这两个文件） ----------
if (NO_GIT) {
  console.log('[--no-git] 跳过 git 提交推送');
  process.exit(0);
}
try {
  const baseEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  execSync('git add weekly-data.json weekly-prompt.txt', { cwd: DEPLOY, env: baseEnv, stdio: 'ignore' });
  let hasChanges = false;
  try {
    execSync('git diff --cached --quiet', { cwd: DEPLOY, env: baseEnv, stdio: 'ignore' });
  } catch (e) { hasChanges = true; } // exit 1 = 有暂存变更
  if (!hasChanges) {
    console.log('[GIT] weekly 文件无变化，跳过提交');
    process.exit(0);
  }
  execSync(`git commit -m "周报备数 ${weekStart}"`, { cwd: DEPLOY, env: baseEnv, stdio: 'inherit' });
  execSync('git pull --rebase origin main', { cwd: DEPLOY, env: baseEnv, stdio: 'inherit' });
  execSync('git push origin main', { cwd: DEPLOY, env: baseEnv, stdio: 'inherit' });
  console.log('[GIT] weekly-data.json / weekly-prompt.txt 已推送 Pages');
} catch (e) {
  console.error('[ERR] weekly git 提交推送失败（文件已本地生成，可手动补推送）:', e.message);
  process.exit(1);
}
