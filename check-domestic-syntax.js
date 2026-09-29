/* 校验国内看板内联JS语法：提取最后一个 <script> 内容用 new Function 检查语法（不执行DOM操作） */
const fs = require('fs');
const html = fs.readFileSync('f:/ai agent/国内经营看板.html', 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)];
let ok = true;
scripts.forEach((m, i) => {
  const code = m[1];
  if (!code.trim()) return;
  try { new Function(code); console.log(`script#${i} syntax OK (${code.length} chars)`); }
  catch (e) { ok = false; console.error(`script#${i} SYNTAX ERROR: ${e.message}`); }
});
process.exit(ok ? 0 : 1);
