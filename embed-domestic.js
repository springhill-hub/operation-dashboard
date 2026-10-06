/* 将 domestic_data.json 内嵌到 国内经营看板.html 的 DATA-JSON 块（v2：不依赖尾部紧邻） */
const fs = require('fs');
const path = require('path');
const ROOT = process.env.CS_ROOT || 'f:/ai agent';
const HTMLP = path.join(ROOT, '国内经营看板.html');
const DATAP = path.join(ROOT, 'domestic_data.json');
const html = fs.readFileSync(HTMLP, 'utf8');
const compact = JSON.stringify(JSON.parse(fs.readFileSync(DATAP, 'utf8')));
const openTag = '<script id="DATA-JSON" type="application/json">';
const closeTag = '</script>';
const i0 = html.indexOf(openTag);
if (i0 < 0) { console.error('open tag not found'); process.exit(1); }
const i1 = html.indexOf(closeTag, i0);
if (i1 < 0) { console.error('close tag not found'); process.exit(1); }
const out = html.slice(0, i0 + openTag.length) + '\n' + compact + '\n' + html.slice(i1);
fs.writeFileSync(HTMLP, out, 'utf8');
console.log('embedded, size=' + (out.length / 1024).toFixed(1) + ' KB');
