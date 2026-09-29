// 一次性脚本：把T1+T2拉到的SKU明细合并进 operation_data.json
// 运行：node "f:\ai agent\deploy\inject-sku.js"
const fs = require('fs');
const path = 'f:/ai agent/operation_data.json';
const DATA = JSON.parse(fs.readFileSync(path, 'utf8'));

// 统一字段：{msku, name, qty, net, cost(负), platformFee(负), profit, margin, pct}
function amzSKUs(rows, totalGp){
  return rows.map(r => ({
    msku: r.msku,
    name: '',
    qty: r.qty,
    net: r.net,
    cost: r.cost,
    platformFee: +(r.commission + r.fbaDeliv + r.storage + r.ads).toFixed(2),
    profit: r.gp,
    margin: +r.margin.toFixed(2),
    pct: totalGp > 0 ? +(r.gp / totalGp * 100).toFixed(2) : 0
  }));
}
function stSKUs(rows, totalProfit){
  return rows.map(r => ({
    msku: r.msku,
    name: r.productName || '',
    qty: r.qty,
    net: r.net,
    cost: r.productCost,
    platformFee: r.platformFeeTotal,
    profit: r.profit,
    margin: +r.margin.toFixed(2),
    pct: totalProfit > 0 ? +(r.profit / totalProfit * 100).toFixed(2) : 0
  }));
}

// === T1: 亚马逊 ===
const t1 = {
  today: {
    amazonJP: [
      {"msku":"QZ-P8BR-KGMU","qty":37,"net":332967,"cost":-141302.74,"commission":-62049,"fbaDeliv":0,"storage":0,"ads":-5172,"gp":157371.26,"margin":47.26},
      {"msku":"LDL-XYCQZ-V-FBA","qty":1,"net":106363,"cost":-36158.3,"commission":-13385,"fbaDeliv":0,"storage":-0.02,"ads":-1523.76,"gp":65813.92,"margin":61.88},
      {"msku":"LDL-XYCQZ-E-FBA","qty":1,"net":106363,"cost":-36158.3,"commission":-13385,"fbaDeliv":0,"storage":-85.12,"ads":-1523.76,"gp":65720.31,"margin":61.79},
      {"msku":"SP-0.5ZML","qty":10,"net":77712,"cost":-43286.62,"commission":-9780,"fbaDeliv":0,"storage":0,"ads":-1826,"gp":30508.38,"margin":39.26},
      {"msku":"LDL-CQ4P-E-FBA","qty":1,"net":49091,"cost":-18176.62,"commission":-6177,"fbaDeliv":0,"storage":-30.89,"ads":-4082,"gp":25475.4,"margin":51.89},
      {"msku":"BEL-CFZ-E+IGTB","qty":6,"net":57924,"cost":-32059.81,"commission":-10794,"fbaDeliv":0,"storage":0,"ads":0,"gp":20800.19,"margin":35.91},
      {"msku":"LDL-XYCQZ-HJDBE","qty":2,"net":22092,"cost":-8243.95,"commission":-2780,"fbaDeliv":0,"storage":0,"ads":-316.48,"gp":12935.57,"margin":58.55},
      {"msku":"LDL-CQ4P-E-DP-FBA","qty":1,"net":21271,"cost":-9089.48,"commission":-2677,"fbaDeliv":0,"storage":-62.4,"ads":0,"gp":11539.88,"margin":54.25},
      {"msku":"BEL-GBY-Z-FBA","qty":1,"net":10228,"cost":0,"commission":-1250,"fbaDeliv":-472,"storage":0,"ads":0,"gp":9517,"margin":93.05},
      {"msku":"LDL-XYCQZTM-E","qty":1,"net":16200,"cost":-9624.99,"commission":-2039,"fbaDeliv":0,"storage":0,"ads":0,"gp":6138.01,"margin":37.89},
      {"msku":"LDL-XYCQZ-ZPDD","qty":2,"net":9206,"cost":-3710.95,"commission":-1158,"fbaDeliv":0,"storage":0,"ads":0,"gp":5247.05,"margin":57},
      {"msku":"CS-MNGHBL-JP","qty":4,"net":15968,"cost":-7971.5,"commission":-2900,"fbaDeliv":0,"storage":0,"ads":-1994,"gp":4682.5,"margin":29.32},
      {"msku":"SL-TBZ-Y","qty":1,"net":4566,"cost":-1416.27,"commission":-558,"fbaDeliv":0,"storage":0,"ads":0,"gp":3042.73,"margin":66.64},
      {"msku":"BEL-FSYLY-E-FBA","qty":2,"net":10798,"cost":-7210.52,"commission":-2012,"fbaDeliv":0,"storage":0,"ads":0,"gp":2643.48,"margin":24.48},
      {"msku":"BEL-SFZ-E","qty":1,"net":6217,"cost":-3147.26,"commission":-1159,"fbaDeliv":0,"storage":0,"ads":0,"gp":2525.74,"margin":40.63},
      {"msku":"CS-HYZYS-FBM","qty":1,"net":3517,"cost":-1188.44,"commission":-655,"fbaDeliv":0,"storage":0,"ads":0,"gp":2021.56,"margin":57.48},
      {"msku":"BEL-XKZ-E","qty":1,"net":7200,"cost":-3325.77,"commission":-880,"fbaDeliv":0,"storage":0,"ads":-1896,"gp":1810.23,"margin":25.14},
      {"msku":"SL-YLY-H-FBA","qty":1,"net":5399,"cost":-2677.52,"commission":-1006,"fbaDeliv":-472,"storage":-20.9,"ads":0,"gp":1754.49,"margin":32.5},
      {"msku":"CS-KL-WS","qty":1,"net":2218,"cost":-800.91,"commission":-279,"fbaDeliv":0,"storage":0,"ads":0,"gp":1357.09,"margin":61.19},
      {"msku":"LDL-QZTZ-WS","qty":1,"net":2168,"cost":-850.23,"commission":-273,"fbaDeliv":0,"storage":0,"ads":0,"gp":1258.77,"margin":58.06}
    ],
    amazonUS: [
      {"msku":"amzn.gr.CS-PL1P-S-9gBaKllsuN4VrQrHI-B-LN","qty":0,"net":0,"cost":0,"commission":0,"fbaDeliv":0,"storage":-0.01,"ads":0,"gp":-0.01,"margin":0},
      {"msku":"CSPL-2 Person Tent-Black","qty":0,"net":0,"cost":0,"commission":0,"fbaDeliv":0,"storage":-0.05,"ads":0,"gp":-0.06,"margin":0}
    ]
  },
  month: {
    amazonJP: [
      {"msku":"QZ-P8BR-KGMU","qty":155,"net":1395506,"cost":-591943.9,"commission":-260057,"fbaDeliv":0,"storage":0,"ads":-23740.62,"gp":657391,"margin":47.11},
      {"msku":"LDL-XYCQZ-E-FBA","qty":8,"net":863300,"cost":-397741.3,"commission":-108639,"fbaDeliv":0,"storage":-2383.05,"ads":-6140.63,"gp":421070.58,"margin":48.77},
      {"msku":"LDL-CQ4P-E-FBA","qty":9,"net":407451,"cost":-163589.59,"commission":-51273,"fbaDeliv":0,"storage":-864.83,"ads":-7782.15,"gp":223680.52,"margin":54.9},
      {"msku":"LDL-XYCQZ-V-FBA","qty":4,"net":428806,"cost":-216949.8,"commission":-53962,"fbaDeliv":0,"storage":-0.1,"ads":-2617.92,"gp":194704.18,"margin":45.41},
      {"msku":"SL-LL2.0-QE-FBA","qty":16,"net":248720,"cost":-73392.31,"commission":-46352,"fbaDeliv":-335,"storage":-184.75,"ads":0,"gp":151026.02,"margin":60.72},
      {"msku":"CS-CQQZ-B-FBA","qty":4,"net":306405,"cost":-155484.21,"commission":-38557,"fbaDeliv":0,"storage":-6416.66,"ads":-3105.68,"gp":132500.84,"margin":43.24},
      {"msku":"SL-FXL3.0-Y","qty":57,"net":270508,"cost":-126245.19,"commission":-34035,"fbaDeliv":0,"storage":0,"ads":0,"gp":132347.81,"margin":48.93},
      {"msku":"BEL-CFZ-E+IGTB","qty":32,"net":308930,"cost":-170985.66,"commission":-57568,"fbaDeliv":0,"storage":0,"ads":0,"gp":110418.4,"margin":35.74},
      {"msku":"SP-PL4P-B-JP","qty":16,"net":387472,"cost":-246754.85,"commission":-48768,"fbaDeliv":-12496,"storage":-1896.23,"ads":-9518.04,"gp":104410.61,"margin":26.95},
      {"msku":"NEW-ZRKSL-SNB","qty":20,"net":188850,"cost":-76962.34,"commission":-23765,"fbaDeliv":0,"storage":0,"ads":-8175.27,"gp":98412.79,"margin":52.11},
      {"msku":"SL-TBZ-Y","qty":30,"net":136978,"cost":-42488.06,"commission":-25237,"fbaDeliv":0,"storage":0,"ads":0,"gp":82783.94,"margin":60.44},
      {"msku":"SP-0.5ZML-FBA","qty":39,"net":305125,"cost":-168817.81,"commission":-38397,"fbaDeliv":-26325,"storage":-3529.25,"ads":-5609.89,"gp":81615.33,"margin":26.75},
      {"msku":"LDL-CQ4P-E-DP-FBA","qty":6,"net":132540,"cost":-54536.91,"commission":-16680,"fbaDeliv":0,"storage":-1747.13,"ads":0,"gp":72508.22,"margin":54.71},
      {"msku":"LDL-CQ4P-E-FBM","qty":2,"net":98182,"cost":-36353.24,"commission":-12354,"fbaDeliv":0,"storage":0,"ads":0,"gp":59182.76,"margin":60.28},
      {"msku":"LDL-TZTM-E-FBA","qty":6,"net":85368,"cost":-31284.74,"commission":-10740,"fbaDeliv":0,"storage":-0.02,"ads":0,"gp":51785.24,"margin":60.66},
      {"msku":"SP-PL4P-G-JP-FBM","qty":6,"net":145304,"cost":-87089.95,"commission":-18288,"fbaDeliv":0,"storage":0,"ads":-2881.9,"gp":51413.15,"margin":35.38},
      {"msku":"CS-CQQZ-AG-FBA1","qty":3,"net":220905,"cost":-155484.21,"commission":-27798,"fbaDeliv":0,"storage":-3975.14,"ads":-3105.68,"gp":50502.55,"margin":22.86},
      {"msku":"LDL-CQZTM-E","qty":5,"net":71995,"cost":-21255.77,"commission":-9060,"fbaDeliv":0,"storage":0,"ads":0,"gp":48799.23,"margin":67.78},
      {"msku":"LDL-XYCQZ-E-NEW","qty":1,"net":85910,"cost":-36158.3,"commission":-10811,"fbaDeliv":0,"storage":0,"ads":-1094.16,"gp":45421.54,"margin":52.87},
      {"msku":"CS-MNGHBL-JP-FBA","qty":39,"net":157082,"cost":-75729.27,"commission":-28530,"fbaDeliv":-18408,"storage":-2200.7,"ads":-6845.33,"gp":44386.69,"margin":28.26}
    ],
    amazonUS: [
      {"msku":"CS-YLJJY-S-US","qty":1,"net":17.73,"cost":-8.94,"commission":-2.94,"fbaDeliv":-4.76,"storage":-0.06,"ads":0,"gp":5.23,"margin":29.5},
      {"msku":"amzn.gr.CS-CHL-S-US-oLz-oMdIZu9oHA3Yk-VG","qty":0,"net":0,"cost":0,"commission":0,"fbaDeliv":0,"storage":-0.01,"ads":0,"gp":-7.25,"margin":0},
      {"msku":"amzn.gr.CSPL-2_Person_Tent-Bla-gfBMWU-LN","qty":0,"net":0,"cost":0,"commission":0,"fbaDeliv":0,"storage":-0.09,"ads":0,"gp":-7.27,"margin":0},
      {"msku":"amzn.gr.CS-PL1P-S-9gBaKllsuN4VrQrHI-B-LN","qty":1,"net":5.6,"cost":0,"commission":-0.9,"fbaDeliv":-11.84,"storage":-0.22,"ads":0,"gp":-14.17,"margin":-253.04},
      {"msku":"CSPL-2 Person Tent-Black","qty":0,"net":0,"cost":0,"commission":0,"fbaDeliv":0,"storage":-1.51,"ads":0,"gp":-149.69,"margin":0}
    ]
  }
};

// === T2: 独立站+Shopee泰马 ===
const t2 = {
  today: {
    "独立站-日本": [
      {"msku":"50527587598511","name":"蓬莱4p充气帐篷2.0棉布款【黑色】","qty":1,"net":68400,"productCost":-24532.21,"platformFeeTotal":0,"profit":43867.79,"margin":64.13},
      {"msku":"46474377035951","name":"祝融取暖器【银色套装】","qty":4,"net":42640,"productCost":-18823.45,"platformFeeTotal":0,"profit":23816.55,"margin":55.85},
      {"msku":"45455399354543","name":"","qty":2,"net":14629,"productCost":0,"platformFeeTotal":0,"profit":14629,"margin":100},
      {"msku":"47385106612399","name":"Mini观火灯炉【银色】","qty":2,"net":18620,"productCost":-5942.22,"platformFeeTotal":0,"profit":12677.78,"margin":68.09},
      {"msku":"47138317861039","name":"轩辕充气帐篷黑胶顶布【黑色】","qty":1,"net":12150,"productCost":-4121.98,"platformFeeTotal":0,"profit":8028.02,"margin":66.07},
      {"msku":"46474377068719","name":"祝融取暖器黑色","qty":1,"net":11520,"productCost":-3922.34,"platformFeeTotal":0,"profit":7597.66,"margin":65.95},
      {"msku":"45455327461551","name":"幻影IGT-A套装","qty":1,"net":12488,"productCost":-7039.07,"platformFeeTotal":0,"profit":5448.93,"margin":43.63},
      {"msku":"45915346141359","name":"春山0.5单元IGT桌面炉","qty":1,"net":8100,"productCost":-4328.66,"platformFeeTotal":0,"profit":3771.34,"margin":46.56},
      {"msku":"47070815092911","name":"侧面板单块-幻影IGT配件","qty":1,"net":3059,"productCost":-1007.59,"platformFeeTotal":0,"profit":2051.41,"margin":67.06},
      {"msku":"46744701206703","name":"琉璃观火灯炉2.0原装灯芯2条装","qty":1,"net":1600,"productCost":-204.34,"platformFeeTotal":0,"profit":1395.66,"margin":87.23},
      {"msku":"46503780417711","name":"增高专用腿*4支","qty":1,"net":2099,"productCost":-1080.4,"platformFeeTotal":0,"profit":1018.6,"margin":48.53}
    ],
    "独立站-国际": [],
    "泰国shopee": [],
    "马来shopee": []
  },
  month: {
    "独立站-日本": [
      {"msku":"46474377035951","name":"祝融取暖器【银色套装】","qty":15,"net":157320,"productCost":-70587.95,"platformFeeTotal":0,"profit":86732.05,"margin":55.13},
      {"msku":"46597961875631","name":"","qty":1,"net":77400,"productCost":0,"platformFeeTotal":0,"profit":77400,"margin":100},
      {"msku":"47455317229743","name":"Mini柴火炉3.0【银色】","qty":18,"net":93960,"productCost":-39866.9,"platformFeeTotal":0,"profit":54093.1,"margin":57.57},
      {"msku":"50527587598511","name":"蓬莱4p充气帐篷2.0棉布款【黑色】","qty":1,"net":68400,"productCost":-24532.21,"platformFeeTotal":0,"profit":43867.79,"margin":64.13},
      {"msku":"46393797804207","name":"春山蓬莱4P庇护所棉布款黑色","qty":1,"net":62820,"productCost":-20760.2,"platformFeeTotal":0,"profit":42059.8,"margin":66.95},
      {"msku":"47111132446895","name":"","qty":1,"net":32425,"productCost":0,"platformFeeTotal":0,"profit":32425,"margin":100},
      {"msku":"45455399354543","name":"","qty":4,"net":28489,"productCost":0,"platformFeeTotal":0,"profit":28489,"margin":100},
      {"msku":"47410213028015","name":"伏羲拓展帐内帐","qty":4,"net":45520,"productCost":-19400.3,"platformFeeTotal":0,"profit":26119.7,"margin":57.38},
      {"msku":"46678410592431","name":"琉璃观火灯炉2.0【枪灰色+黑胡桃木】","qty":2,"net":34199,"productCost":-9174.04,"platformFeeTotal":0,"profit":25024.96,"margin":73.17},
      {"msku":"47410212962479","name":"伏羲拓展帐【黑色】","qty":2,"net":41420,"productCost":-20128.39,"platformFeeTotal":0,"profit":21291.61,"margin":51.4},
      {"msku":"47404985483439","name":"轩辕充气隧道帐篷拓展天幕【黑色】","qty":2,"net":39100,"productCost":-19249.98,"platformFeeTotal":0,"profit":19850.02,"margin":50.77},
      {"msku":"47138317861039","name":"轩辕充气帐篷黑胶顶布【黑色】","qty":2,"net":25150,"productCost":-8243.95,"platformFeeTotal":0,"profit":16906.05,"margin":67.22},
      {"msku":"47127123394735","name":"轩辕充气隧道帐篷内帐","qty":2,"net":27901,"productCost":-11085.88,"platformFeeTotal":0,"profit":16815.12,"margin":60.27},
      {"msku":"46602925998255","name":"蓬莱4P庇护所充气帐篷内帐","qty":2,"net":23940,"productCost":-7210.52,"platformFeeTotal":0,"profit":16729.48,"margin":69.88},
      {"msku":"46325894840495","name":"拓展帐-棉布款【黑色】","qty":1,"net":26820,"productCost":-11132.86,"platformFeeTotal":0,"profit":15687.14,"margin":58.49},
      {"msku":"47127123329199","name":"春山轩辕充气隧道帐篷TPU门【黑色】","qty":2,"net":24300,"productCost":-9329.05,"platformFeeTotal":0,"profit":14970.95,"margin":61.61},
      {"msku":"46413005848751","name":"伏羲充气球帐主帐半挂内帐","qty":1,"net":19089,"productCost":-5155.41,"platformFeeTotal":0,"profit":13933.59,"margin":72.99},
      {"msku":"46678002827439","name":"伏羲拓展天幕【黑色】","qty":1,"net":17599,"productCost":-4251.15,"platformFeeTotal":0,"profit":13347.85,"margin":75.84},
      {"msku":"47385106612399","name":"Mini观火灯炉【银色】","qty":2,"net":18620,"productCost":-5942.22,"platformFeeTotal":0,"profit":12677.78,"margin":68.09},
      {"msku":"45455327461551","name":"幻影IGT-A套装","qty":2,"net":24975,"productCost":-14078.13,"platformFeeTotal":0,"profit":10896.87,"margin":43.63}
    ],
    "独立站-国际": [
      {"msku":"LDL-PL4P-MV","name":"蓬莱4P庇护所棉布款【军绿】","qty":1,"net":339,"productCost":-130.24,"platformFeeTotal":0,"profit":208.76,"margin":61.58},
      {"msku":"SL-ZML0.5-Y","name":"","qty":2,"net":181.94,"productCost":0,"platformFeeTotal":0,"profit":181.94,"margin":100},
      {"msku":"CS-2DPL-E","name":"双人棉布蓬莱黑","qty":1,"net":132.59,"productCost":-53.78,"platformFeeTotal":0,"profit":78.81,"margin":59.44},
      {"msku":"BEL-CFZ-E-ATZ","name":"金乌碳纤维长方桌【A套装】","qty":1,"net":81.46,"productCost":-28.62,"platformFeeTotal":0,"profit":52.84,"margin":64.87},
      {"msku":"TC-CHLX-Y","name":"MINI-柴火炉银色","qty":1,"net":26.54,"productCost":-5.15,"platformFeeTotal":0,"profit":21.39,"margin":80.61},
      {"msku":"TC-CHLX-E","name":"迷你柴火炉黑色","qty":1,"net":26,"productCost":-5.91,"platformFeeTotal":0,"profit":20.09,"margin":77.27}
    ],
    "泰国shopee": [
      {"msku":"BEL-FSYLY-E","name":"扶桑碳纤维月亮椅【黑色】","qty":38,"net":65501,"productCost":-28549.75,"platformFeeTotal":-20904.91,"profit":14245.52,"margin":21.75},
      {"msku":"BH-ZRKSL-Y","name":"祝融卡式炉【银色】","qty":39,"net":68944.32,"productCost":-26991.34,"platformFeeTotal":-21399.36,"profit":12308.94,"margin":17.85},
      {"msku":"SL-BTJ-E","name":"","qty":10,"net":17397.41,"productCost":0,"platformFeeTotal":-5638.42,"profit":9915.94,"margin":57},
      {"msku":"SL-BTJ-E+CS-BT-HS-G","name":"银色寒霜冰桶","qty":7,"net":19083.13,"productCost":-3671.14,"platformFeeTotal":-6363.34,"profit":8950.13,"margin":46.9},
      {"msku":"LDL-MGCQZ-E-DP","name":"伏羲充气球帐【黑色】","qty":1,"net":24782,"productCost":-8100.44,"platformFeeTotal":-7850,"profit":8518.35,"margin":34.37},
      {"msku":"LDL-XYCQZ-E-DP","name":"轩辕充气隧道帐篷【黑色顶配】","qty":1,"net":23902,"productCost":-7535.12,"platformFeeTotal":-7577,"profit":7465.35,"margin":31.23},
      {"msku":"LDL-XYCQZ-V","name":"轩辕充气隧道帐篷【军绿色顶配】","qty":1,"net":21810,"productCost":-7535.12,"platformFeeTotal":-7005,"profit":7269.88,"margin":33.33},
      {"msku":"LDL-ZSSF-E","name":"毕方战术沙发【黑色】","qty":10,"net":35507,"productCost":-15217.07,"platformFeeTotal":-11901,"profit":7030.68,"margin":19.8},
      {"msku":"CS-PL-1R-V","name":"单人棉布蓬莱绿","qty":15,"net":43449.78,"productCost":-20740.54,"platformFeeTotal":-14056.76,"profit":6709.18,"margin":15.44},
      {"msku":"SL-YLY-WS","name":"春山摇光月亮椅【网纱款】","qty":29,"net":37719.48,"productCost":-17742.65,"platformFeeTotal":-12286.22,"profit":6452.24,"margin":17.11},
      {"msku":"SL-BTJ-E+CS-BT-HS-H","name":"黑色寒霜冰桶","qty":5,"net":13518.48,"productCost":-2676.08,"platformFeeTotal":-4482.41,"profit":6321.99,"margin":46.77},
      {"msku":"CS-PL-1R-WZ-V","name":"单人蓬莱外帐-绿色","qty":12,"net":20932.72,"productCost":-7224.32,"platformFeeTotal":-6905.32,"profit":6071.27,"margin":29},
      {"msku":"JT-XJC-E","name":"战术行军床【黑色】","qty":13,"net":36511.98,"productCost":-18261.47,"platformFeeTotal":-11935.49,"profit":5244.76,"margin":14.36},
      {"msku":"TC-HYSL-E","name":"春山幻影IGT桌SOLO","qty":9,"net":21931,"productCost":-9669.13,"platformFeeTotal":-7268,"profit":4710.87,"margin":21.48},
      {"msku":"CS-PL-1R-E","name":"单人棉布蓬莱黑","qty":10,"net":28315.15,"productCost":-13827.03,"platformFeeTotal":-9210.48,"profit":4398.38,"margin":15.53},
      {"msku":"SL-BTJ-E","name":"冰桶架【黑色】","qty":16,"net":25043.85,"productCost":-10313.74,"platformFeeTotal":-8259.97,"profit":4360.42,"margin":17.41},
      {"msku":"CS-PL-1R-WZ-E","name":"蓬莱1P外帐【黑色】","qty":9,"net":15462.62,"productCost":-5792.67,"platformFeeTotal":-4997.98,"profit":4126.12,"margin":26.68},
      {"msku":"YS-DBT-G","name":"3.8L寒霜冰桶【灰色】","qty":16,"net":25085.51,"productCost":-10673.98,"platformFeeTotal":-7421.28,"profit":4105.64,"margin":16.37},
      {"msku":"LDL-CQ4P-V","name":"蓬莱4P充气帐篷主帐2.0【军绿色】","qty":2,"net":18023,"productCost":-7683.42,"platformFeeTotal":-5735,"profit":3925.58,"margin":21.78},
      {"msku":"SL-YLY-H","name":"春山摇光月亮椅","qty":26,"net":30138,"productCost":-14507.37,"platformFeeTotal":-9805,"profit":3839.98,"margin":12.74}
    ],
    "马来shopee": [
      {"msku":"LDL-CQ4P-E","name":"蓬莱4P充气帐篷主帐2.0【黑色】","qty":14,"net":12310.71,"productCost":-6603.3,"platformFeeTotal":-3712.68,"profit":1539.26,"margin":12.5},
      {"msku":"LDL-CQ4P-V","name":"蓬莱4P充气帐篷主帐2.0【军绿色】","qty":3,"net":3727.11,"productCost":-1414.99,"platformFeeTotal":-1115.35,"profit":1195.24,"margin":32.07},
      {"msku":"SL-BTJ-E","name":"","qty":8,"net":1934.3,"productCost":0,"platformFeeTotal":-797.25,"profit":965.53,"margin":49.92},
      {"msku":"YS-DBT-Y","name":"3.8L寒霜冰桶【银色】","qty":9,"net":1836.64,"productCost":-689.56,"platformFeeTotal":-589.17,"profit":514.67,"margin":28.02},
      {"msku":"LDL-CQ4PTZ-V","name":"蓬莱4P充气帐篷拓展前厅2.0【军绿色】","qty":3,"net":1823.39,"productCost":-758.97,"platformFeeTotal":-551.72,"profit":511.4,"margin":28.05},
      {"msku":"SL-BTJ-E","name":"冰桶架【黑色】","qty":14,"net":2357.88,"productCost":-1107.98,"platformFeeTotal":-749.22,"profit":452.26,"margin":19.18},
      {"msku":"SL-BTJ-E+CS-BT-HS-H","name":"黑色寒霜冰桶","qty":2,"net":765,"productCost":-131.42,"platformFeeTotal":-250.58,"profit":367.19,"margin":48},
      {"msku":"CS-HYZ-TZ-A","name":"幻影IGT-A套装","qty":5,"net":1766.55,"productCost":-900.48,"platformFeeTotal":-520.07,"profit":325.76,"margin":18.44},
      {"msku":"LDL-4P-NE","name":"春山蓬莱4P庇护所2.0黑色","qty":1,"net":997.34,"productCost":-371.37,"platformFeeTotal":-301.14,"profit":324.39,"margin":32.53},
      {"msku":"LDL-ZSSF-V","name":"毕方战术沙发【军绿】","qty":2,"net":975.55,"productCost":-374.86,"platformFeeTotal":-296.04,"profit":284.59,"margin":29.17},
      {"msku":"JT-XJC-E","name":"战术行军床【黑色】","qty":3,"net":1153.3,"productCost":-517.39,"platformFeeTotal":-342.54,"profit":274.89,"margin":23.83},
      {"msku":"LDL-4P-NV","name":"春山蓬莱4P庇护所2.0军绿色","qty":1,"net":938.05,"productCost":-371.37,"platformFeeTotal":-274.59,"profit":256.39,"margin":27.33},
      {"msku":"JT-XJC-V","name":"战术行军床军绿色","qty":2,"net":848,"productCost":-344.93,"platformFeeTotal":-250.35,"profit":252.18,"margin":29.74},
      {"msku":"LDL-ZSSF-E","name":"毕方战术沙发【黑色】","qty":6,"net":2010,"productCost":-1120.96,"platformFeeTotal":-625.41,"profit":249.83,"margin":12.43},
      {"msku":"SL-DBTT-H","name":"战术冰桶套3.8L【黑色】","qty":11,"net":560.96,"productCost":-155.53,"platformFeeTotal":-189.4,"profit":200.44,"margin":35.73},
      {"msku":"YS-DBT-Y","name":"3.8L寒霜冰桶【银色】","qty":2,"net":446.64,"productCost":-153.24,"platformFeeTotal":-129.45,"profit":158.69,"margin":35.53},
      {"msku":"SL-YLY-WS","name":"春山摇光月亮椅【网纱款】","qty":5,"net":831.5,"productCost":-375.58,"platformFeeTotal":-268.64,"profit":155.87,"margin":18.75},
      {"msku":"CS-BT-HS-Y","name":"银色寒霜冰桶","qty":3,"net":490.67,"productCost":-193.17,"platformFeeTotal":-144.79,"profit":139.58,"margin":28.45},
      {"msku":"BEL-TXW-TMGE","name":"春山碳纤维天幕杆","qty":4,"net":587.9,"productCost":-202.87,"platformFeeTotal":-198.87,"profit":134.02,"margin":22.8},
      {"msku":"SL-XKP","name":"Mini黑金烤盘【黑色】","qty":4,"net":319.85,"productCost":-101.68,"platformFeeTotal":-90.79,"profit":123.02,"margin":38.46}
    ]
  }
};

// === 注入 skuDetail ===
// today
DATA.today.amazonJP.skuDetail = amzSKUs(t1.today.amazonJP, DATA.today.amazonJP.gp);
DATA.today.amazonUS.skuDetail = amzSKUs(t1.today.amazonUS, DATA.today.amazonUS.gp);
for(const k of Object.keys(t2.today)){
  if(DATA.today.settlement[k]){
    DATA.today.settlement[k].skuDetail = stSKUs(t2.today[k], DATA.today.settlement[k].profit);
  }
}
// month
DATA.month.amazonJP.skuDetail = amzSKUs(t1.month.amazonJP, DATA.month.amazonJP.gp);
DATA.month.amazonUS.skuDetail = amzSKUs(t1.month.amazonUS, DATA.month.amazonUS.gp);
for(const k of Object.keys(t2.month)){
  if(DATA.month.settlement[k]){
    DATA.month.settlement[k].skuDetail = stSKUs(t2.month[k], DATA.month.settlement[k].profit);
  }
}
// week / yesterday / lastWeek / lastMonth / lastYearSep: 不加skuDetail，UI 显示"暂无"

fs.writeFileSync(path, JSON.stringify(DATA, null, 2), 'utf8');
console.log('✅ SKU明细已注入 operation_data.json');
console.log('   today.amazonJP.skuDetail:', DATA.today.amazonJP.skuDetail.length, '条');
console.log('   today.amazonUS.skuDetail:', DATA.today.amazonUS.skuDetail.length, '条');
console.log('   today.settlement[独立站-日本].skuDetail:', DATA.today.settlement['独立站-日本'].skuDetail.length, '条');
console.log('   month.amazonJP.skuDetail:', DATA.month.amazonJP.skuDetail.length, '条');
console.log('   month.amazonUS.skuDetail:', DATA.month.amazonUS.skuDetail.length, '条');
console.log('   month.settlement[独立站-日本].skuDetail:', DATA.month.settlement['独立站-日本'].skuDetail.length, '条');
console.log('   month.settlement[独立站-国际].skuDetail:', DATA.month.settlement['独立站-国际'].skuDetail.length, '条');
console.log('   month.settlement[泰国shopee].skuDetail:', DATA.month.settlement['泰国shopee'].skuDetail.length, '条');
console.log('   month.settlement[马来shopee].skuDetail:', DATA.month.settlement['马来shopee'].skuDetail.length, '条');
