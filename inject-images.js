// 一次性脚本：把97个MSKU主图URL注入 operation_data.json 各 skuDetail 的 img 字段
const fs = require('fs');
const path = 'f:/ai agent/operation_data.json';
const DATA = JSON.parse(fs.readFileSync(path, 'utf8'));

const IMAGES = {
  "QZ-P8BR-KGMU":"https://m.media-amazon.com/images/I/61I+QV39VeL._SL500_.jpg",
  "LDL-XYCQZ-V-FBA":"https://m.media-amazon.com/images/I/81LEW+QfAfL._SL500_.jpg",
  "LDL-XYCQZ-E-FBA":"https://m.media-amazon.com/images/I/71VniaXZWxL._SL500_.jpg",
  "SP-0.5ZML":"https://m.media-amazon.com/images/I/6159XNHqMJL._SL500_.jpg",
  "LDL-CQ4P-E-FBA":"https://m.media-amazon.com/images/I/61Ii0b-fjsL._SL500_.jpg",
  "BEL-CFZ-E+IGTB":"https://m.media-amazon.com/images/I/71G6djgr0FL._SL500_.jpg",
  "LDL-XYCQZ-HJDBE":"https://m.media-amazon.com/images/I/51QQHjD-PJL._SL500_.jpg",
  "LDL-CQ4P-E-DP-FBA":"https://m.media-amazon.com/images/I/51x3dTfSHwL._SL500_.jpg",
  "BEL-GBY-Z-FBA":"https://m.media-amazon.com/images/I/716WE5i32jL._SL500_.jpg",
  "LDL-XYCQZTM-E":"https://m.media-amazon.com/images/I/51oHHmynmLL._SL500_.jpg",
  "LDL-XYCQZ-ZPDD":"https://m.media-amazon.com/images/I/61GngX9tHbL._SL500_.jpg",
  "CS-MNGHBL-JP":"https://m.media-amazon.com/images/I/61swEuWL59L._SL500_.jpg",
  "SL-TBZ-Y":"https://m.media-amazon.com/images/I/617QzAPH46L._SL500_.jpg",
  "BEL-FSYLY-E-FBA":"https://m.media-amazon.com/images/I/71TBDuraNoL._SL500_.jpg",
  "BEL-SFZ-E":"https://m.media-amazon.com/images/I/61+xt8H5uqL._SL500_.jpg",
  "CS-HYZYS-FBM":"https://m.media-amazon.com/images/I/61SrEwJyauL._SL500_.jpg",
  "BEL-XKZ-E":"https://m.media-amazon.com/images/I/51sXS29SY0L._SL500_.jpg",
  "SL-YLY-H-FBA":"https://m.media-amazon.com/images/I/61SPwT17+JL._SL500_.jpg",
  "CS-KL-WS":"https://m.media-amazon.com/images/I/51AfOf78PfL._SL500_.jpg",
  "LDL-QZTZ-WS":"https://m.media-amazon.com/images/I/51faAGM28WL._SL500_.jpg",
  "amzn.gr.CS-PL1P-S-9gBaKllsuN4VrQrHI-B-LN":"https://m.media-amazon.com/images/I/51V8Bhrov1L._SL500_.jpg",
  "CSPL-2 Person Tent-Black":"https://m.media-amazon.com/images/I/51V8Bhrov1L._SL500_.jpg",
  "50527587598511":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/2.0_4P.jpg?v=1790232442",
  "46474377035951":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/0_53c53553-11e8-48f4-829c-4e4f5f4a334c.jpg?v=1760001204",
  "45455399354543":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/12_67a2d07e-6f26-422d-83cf-565b73a3f715.jpg?v=1770109283",
  "47385106612399":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/5_d0b0490d-05a1-4708-a9b1-14c04510524d.jpg?v=1787381341",
  "47138317861039":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/793f2be0497180835439f35e2d5914ce.jpg?v=1783068449",
  "46474377068719":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/14_392ffc29-e09b-41b0-9f0c-2b519f52a4d8.jpg?v=1768960312",
  "45455327461551":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/a9ac9f12242079fc7b7236ae75dd192b.jpg?v=1766114092",
  "45915346141359":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/0.5.jpg?v=1762585406",
  "47070815092911":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/778a789ab391f36fb6863e09d6df6dfc.png?v=1781681041",
  "46744701206703":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/1_387e961f-9eb3-4aef-82a3-d2a90e2522cb.jpg?v=1773468401",
  "46503780417711":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/2_3b81ad22-be8c-4205-8c30-4af44b5bf095.jpg?v=1769831702",
  "SL-LL2.0-QE-FBA":"https://m.media-amazon.com/images/I/51r0KN9l-9L._SL500_.jpg",
  "CS-CQQZ-B-FBA":"https://m.media-amazon.com/images/I/41FULt5isbL._SL500_.jpg",
  "SL-FXL3.0-Y":"https://m.media-amazon.com/images/I/61xkZRS7S1L._SL500_.jpg",
  "SP-PL4P-B-JP":"https://m.media-amazon.com/images/I/51+iv6XhllL._SL500_.jpg",
  "NEW-ZRKSL-SNB":"https://m.media-amazon.com/images/I/6166AXGmE7L._SL500_.jpg",
  "SP-0.5ZML-FBA":"https://m.media-amazon.com/images/I/6159XNHqMJL._SL500_.jpg",
  "LDL-CQ4P-E-FBM":"https://m.media-amazon.com/images/I/61Ii0b-fjsL._SL500_.jpg",
  "LDL-TZTM-E-FBA":"https://m.media-amazon.com/images/I/41ipm5udqiL._SL500_.jpg",
  "SP-PL4P-G-JP-FBM":"https://m.media-amazon.com/images/I/51cOFVD8pqL._SL500_.jpg",
  "CS-CQQZ-AG-FBA1":"https://m.media-amazon.com/images/I/915C7+e6jiL._SL500_.jpg",
  "LDL-CQZTM-E":"https://m.media-amazon.com/images/I/51X+4N8pqKL._SL500_.jpg",
  "LDL-XYCQZ-E-NEW":"https://m.media-amazon.com/images/I/31066n+uewL._SL500_.jpg",
  "CS-MNGHBL-JP-FBA":"https://m.media-amazon.com/images/I/61swEuWL59L._SL500_.jpg",
  "CS-YLJJY-S-US":"https://m.media-amazon.com/images/I/613VIIITEZL._SL500_.jpg",
  "amzn.gr.CS-CHL-S-US-oLz-oMdIZu9oHA3Yk-VG":"https://m.media-amazon.com/images/I/61xGFH8lv9L._SL500_.jpg",
  "amzn.gr.CSPL-2_Person_Tent-Bla-gfBMWU-LN":"https://m.media-amazon.com/images/I/51V8Bhrov1L._SL500_.jpg",
  "46597961875631":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/2_8ba6b773-55a3-469b-8978-2cbdfce20c6a.jpg?v=1772267223",
  "47455317229743":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/9_b8aa463c-070c-4f4c-804b-2fc6935e1df5.jpg?v=1788769575",
  "46393797804207":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/1_03908981-7be9-4fb3-8629-c33021dfef16.jpg?v=1765613662",
  "47111132446895":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/6_41e8257b-4dba-484a-8fc6-f65a89cbc10d.jpg?v=1782203941",
  "47410213028015":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/size_c7ae0c43-59c6-48c9-9897-58385b81a4ab.jpg?v=1787898650",
  "46678410592431":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/9_38ff916b-db24-4a61-b7c4-ddf64af9bb03.jpg?v=1773468650",
  "47410212962479":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/size.jpg?v=1787898647",
  "47404985483439":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/411ba4d52e83f09b10948fdec23946d2.jpg?v=1787815285",
  "47127123394735":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/5824e546985e79c861dd7f50f453d528.jpg?v=1782803804",
  "46602925998255":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/13-1.jpg?v=1783665287",
  "46325894840495":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/1_398cde38-0545-4bed-bfd8-956ed0666431.jpg?v=1753165530",
  "47127123329199":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/TPU_d82f2cc0-0ad5-47c5-8045-6861958fd882.jpg?v=1782803759",
  "46413005848751":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/2_8275bc85-f222-484e-8945-f07a8296fd27.jpg?v=1766471238",
  "46678002827439":"https://cdn.shopify.com/s/files/1/0702/6920/6703/files/2_aab4a3de-5dc4-4fb1-9e7a-c394fed6790d.jpg?v=1773454369",
  "BEL-FSYLY-E":"https://m.media-amazon.com/images/I/71TBDuraNoL._SL500_.jpg",
  "BH-ZRKSL-Y":"https://m.media-amazon.com/images/I/61Evs-RjzSL._SL500_.jpg",
  "SL-BTJ-E":"https://m.media-amazon.com/images/I/615wzy0VxbL._SL500_.jpg",
  "LDL-MGCQZ-E-DP":"https://cf.shopee.co.th/file/cn-11134207-820l4-mplzxhvqwz6730",
  "LDL-XYCQZ-E-DP":"https://cf.shopee.co.th/file/cn-11134207-820l4-msnkqjvil98g3f",
  "LDL-XYCQZ-V":"https://m.media-amazon.com/images/I/81LEW+QfAfL._SL500_.jpg",
  "LDL-ZSSF-E":"https://m.media-amazon.com/images/I/71xAnZxCCeL._SL500_.jpg",
  "CS-PL-1R-V":"https://cf.shopee.co.th/file/cn-11134207-820l4-mp4uucjy0bgg26",
  "SL-YLY-WS":"https://m.media-amazon.com/images/I/61pRT0D8SxL._SL500_.jpg",
  "CS-PL-1R-WZ-V":"https://cf.shopee.co.th/file/cn-11134207-820l4-moqf08oouznl1e",
  "JT-XJC-E":"https://cf.shopee.co.th/file/cn-11134207-820l4-mr5lw2igvcat9",
  "CS-PL-1R-E":"https://cf.shopee.co.th/file/cn-11134207-820l4-mp4uuhj7jimkdd",
  "CS-PL-1R-WZ-E":"https://cf.shopee.co.th/file/cn-11134207-820l4-moqf0c32054x39",
  "YS-DBT-G":"https://m.media-amazon.com/images/I/51+lwNb81IL._SL500_.jpg",
  "LDL-CQ4P-V":"https://m.media-amazon.com/images/I/914NSr+a3VL._SL500_.jpg",
  "SL-YLY-H":"https://m.media-amazon.com/images/I/61SPwT17+JL._SL500_.jpg",
  "LDL-CQ4P-E":"https://m.media-amazon.com/images/I/91Z3Hb-4KTL._SL500_.jpg",
  "YS-DBT-Y":"https://m.media-amazon.com/images/I/51kw3iTu4-L._SL500_.jpg",
  "LDL-CQ4PTZ-V":"https://cf.shopee.com.my/file/cn-11134207-820l4-mtgfewwmcvere6",
  "CS-HYZ-TZ-A":"https://cf.shopee.co.th/file/cn-11134207-7ras8-m81r8krs6t5p53",
  "LDL-4P-NE":"https://cf.shopee.co.th/file/cn-11134207-820l4-me8cwut20g7587",
  "LDL-ZSSF-V":"https://m.media-amazon.com/images/I/61sh9xXyQa9L._SL500_.jpg",
  "LDL-4P-NV":"https://cf.shopee.co.th/file/cn-11134207-820l4-megnfy91auwxd4",
  "JT-XJC-V":"https://cf.shopee.co.th/file/cn-11134207-820l4-mr5lw5ppmg3r6b",
  "SL-DBTT-H":"https://m.media-amazon.com/images/I/615wzy0VxbL._SL500_.jpg",
  "CS-BT-HS-Y":"https://cf.shopee.com.my/file/cn-11134207-820l4-mt38uazaij9ea5",
  "BEL-TXW-TMGE":"https://cf.shopee.co.th/file/cn-11134207-820l4-msgqmxfpjuvcce",
  "SL-XKP":"https://cf.shopee.com.my/file/cn-11134207-7ras8-m82utvocw7ted7",
  "LDL-PL4P-MV":"https://m.media-amazon.com/images/I/618T+KqXu7L._SL500_.jpg",
  "SL-ZML0.5-Y":"https://cdn.shopify.com/s/files/1/0874/8751/2857/files/mini_d3971a64-7bd7-4b17-9d47-3d19f3e2dba3.jpg?v=1759980601",
  "CS-2DPL-E":"https://cdn.shopify.com/s/files/1/0874/8751/2857/files/5_59bfc6b4-a9ba-4a2d-8cc4-a717139faeab.jpg?v=1742551324",
  "BEL-CFZ-E-ATZ":"https://m.media-amazon.com/images/I/71FPBluOoNL._SL500_.jpg",
  "TC-CHLX-Y":"https://cdn.shopify.com/s/files/1/0874/8751/2857/files/d749e78770e6779348c0400c9f62739a.jpg?v=1742551456",
  "TC-CHLX-E":"https://cdn.shopify.com/s/files/1/0874/8751/2857/files/fb070d070321eedb6085c21399e32beb.jpg?v=1742551456"
};

let count = 0, withImg = 0;
function apply(list){
  for(const r of list){
    count++;
    if(IMAGES[r.msku]){ r.img = IMAGES[r.msku]; withImg++; }
  }
}
for(const p of ['today','month']){
  apply(DATA[p].amazonJP.skuDetail||[]);
  apply(DATA[p].amazonUS.skuDetail||[]);
  for(const k of Object.keys(DATA[p].settlement||{})) apply(DATA[p].settlement[k].skuDetail||[]);
}

fs.writeFileSync(path, JSON.stringify(DATA,null,2),'utf8');
console.log('✅ 图片字段注入完成');
console.log('   扫描SKU行数:',count,' 含图:',withImg);
