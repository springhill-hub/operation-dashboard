/* ============================================================
 * 春山户外 · 跨渠道统一商品成本库（v1.0 · 2026-10-06）
 * ------------------------------------------------------------
 * 原则（王泉斐确认）：所有店铺 SKU 与日亚同货同编码，商品成本一致。
 * 统一以「日亚 MSKU 单位采购成本(JPY)」为基准，各渠道按外管局
 * 中间价折算店铺币种。负号约定：单位成本为负值（与各 build 一致）。
 *
 * 数据源优先级：
 *   ① jp-msku-cost.json — 领星 MSKU利润报表 年初至今全量 cgUnitPrice
 *      （pull-msku-cost.js 每日刷新；采购成本，未含头程）
 *   ② operation_data.json 日亚 skuDetail cost/qty（近期有销售兜底）
 *   ③ msku-cost.json Shopee 结算静态成本（THB/MYR 折 JPY，最后兜底）
 *
 * 别名（ALIAS / COUPANG_PID_ALIAS）为人工确认映射，新增必须留痕。
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const num = v => Number(v) || 0;

const STRIP = ['-FBA1', '-FBA', '-FBM1', '-FBM', '-NEW', '-ATZ', '-DP', '-JP'];
function normKey(s) {
  let k = String(s || '').toUpperCase().replace(/\+/g, '-');
  let prev;
  do {
    prev = k;
    for (const suf of STRIP) if (k.endsWith(suf)) k = k.slice(0, -suf.length);
  } while (k !== prev);
  return k;
}

// 内部编码差异别名（key/value 均会归一化后比较）
const ALIAS = {
  'BEL-CFZ-IGTB': 'BEL-CFZ-E-IGTB',   // 碳纤维长方形IGT延长桌（日亚马甲 BEL-CFZ-E+IGTB）
  'LDL-CQ4P-E2.0': 'LDL-CQ4P-E',      // 蓬莱4P充气主帐 2.0 命名差异
  'BEL-HYSL-E': 'CS-HYSL-JP',         // 幻影IGT桌SOLO（Shopee编码 BEL-HYSL-E）
  'TC-MNBL-Y': 'CS-MNGHBL-JP',        // mini观火壁炉
  'CS-HYZ-PJ-0.5MBX2': 'CS-0.5MB',    // 幻影IGT 0.5单元相思木板*2
};

// Coupang 平台商品ID（领星未映射内部SKU的数字ID行）→ 日亚MSKU
// 依据：Coupang韩文商品名与日亚中文品名一对一（2026-10-06 确认）
const COUPANG_PID_ALIAS = {
  '96103821797': 'CS-CHL',   // 미니 장작 난로 향로 실버 = MINI-柴火炉银色
  '96103407408': 'M183',     // 봉래 2P 텐트 면 모델 블랙 2인용 = 双人棉布蓬莱黑
};

function loadJpyCostMap(D) {
  const map = {};
  const put = (k, v) => {
    if (k == null || v == null || !isFinite(v)) return;
    const nk = normKey(k);
    if (map[nk] == null) map[nk] = v;
  };

  // ① 全量主表（正值 → 存负值）
  try {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'jp-msku-cost.json'), 'utf8')).unitCostJpy || {};
    for (const [k, v] of Object.entries(m)) {
      const u = num(v && v.unit);
      if (u > 0) put(k, -u);
    }
  } catch (e) { /* 主表缺失时用兜底 */ }

  // ② 近期日亚 skuDetail（cost 为负）
  for (const p of ['lastMonth', 'month', 'week', 'today']) {
    const a = D[p] && D[p].amazonJP;
    if (!a || !Array.isArray(a.skuDetail)) continue;
    for (const r of a.skuDetail) {
      if (!r.msku || !r.qty || !r.cost) continue;
      put(r.msku, num(r.cost) / num(r.qty));
    }
  }

  // ③ Shopee 静态成本折 JPY
  const R = num(D.meta && D.meta.jpyRate);
  const fx = (D.meta && D.meta.fx) || {};
  try {
    const sc = JSON.parse(fs.readFileSync(path.join(__dirname, 'msku-cost.json'), 'utf8')).unitCost || {};
    for (const ccy of ['THB', 'MYR']) {
      const cnyPer = ccy === 'THB' ? num(fx.thbCny) : num(fx.myrCny);
      if (!cnyPer || !R) continue;
      for (const [k, v] of Object.entries(sc[ccy] || {})) {
        if (num(v) !== 0) put(k, -Math.abs(num(v)) * cnyPer / R);
      }
    }
  } catch (e) { /* 无静态表跳过 */ }

  // 别名补点
  for (const [from, to] of Object.entries(ALIAS)) {
    const a = normKey(from), b = normKey(to);
    if (map[a] == null && map[b] != null) map[a] = map[b];
  }
  return map;
}

// JPY 单位成本(负) → 店铺币种单位成本(负)；汇率取 meta.fx（外管局中间价）
function toCcy(jpyUnit, ccy, D) {
  const R = num(D.meta && D.meta.jpyRate);
  const fx = (D.meta && D.meta.fx) || {};
  const cnyPer = { JPY: 1, KRW: num(fx.krwCny), THB: num(fx.thbCny), MYR: num(fx.myrCny) }[ccy];
  if (!R || !cnyPer) return null;
  if (ccy === 'JPY') return jpyUnit;
  return jpyUnit * R / cnyPer;  // CNY = JPY×R；本币 = CNY / 本币兑CNY
}

module.exports = { normKey, loadJpyCostMap, toCcy, ALIAS, COUPANG_PID_ALIAS };
