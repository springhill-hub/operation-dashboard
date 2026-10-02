// 校验 HTML 内联业务脚本语法（只编译不执行）
const fs = require('fs');
const file = process.argv[2] || 'f:/ai agent/经营看板.html';
const html = fs.readFileSync(file, 'utf8');
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m, idx = 0, errors = 0;
while ((m = re.exec(html))) {
  const attrs = m[1] || '';
  const code = m[2] || '';
  if (/\bsrc=/.test(attrs)) continue;
  if (/id="DATA-JSON"/.test(attrs)) { idx++; continue; }
  idx++;
  if (!code.trim()) continue;
  try {
    new Function(code);
  } catch (e) {
    errors++;
    console.log(`[ERR] inline script #${idx}: ${e.message}`);
  }
}
console.log(errors ? `FAIL: ${errors} syntax error(s)` : 'PASS: all inline scripts compile');
process.exit(errors ? 1 : 0);
