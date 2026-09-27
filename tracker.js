// 語音追蹤核心：把「聽到的字」對齊到「稿子」上的位置
// 1. 中文以「字」為單位、英文以「詞」為單位切 token
// 2. 用局部對齊 (Smith-Waterman) 做模糊匹配：念錯、換詞、漏字都能容忍
// 3. 對「離目前位置很遠」的跳躍要求更高的匹配分數：可跳段、可回頭、脫稿時安靜等待
(function (global) {
  'use strict';

  // 繁→簡 常用字對照（兩邊都正規化成同一種寫法，避免辨識結果和稿子繁簡不同）
  const TS_PAIRS = (
    '們们個个說说這这來来時时會会為为對对過过還还後后從从於于與与開开關关麼么樣样點点裡里裏里讓让當当經经現现發发應应實实動动學学機机體体長长問问間间見见覺觉將将頭头氣气種种無无著着講讲話话語语聲声爾尔國国東东車车門门電电書书寫写聽听讀读認认識识請请謝谢錯错給给馬马媽妈買买賣卖錢钱貴贵萬万億亿幾几條条歲岁題题業业產产場场報报導导紅红綠绿藍蓝黃黄飛飞鳥鸟魚鱼龍龙風风雲云陽阳陰阴華华夢梦歡欢樂乐愛爱戲戏視视頻频螢萤圖图畫画質质環环設设備备軟软腦脑網网絡络線线據据標标準准確确選选擇择單单雙双價价訂订閱阅費费購购課课區区鏡镜攝摄錄录製制輯辑盤盘濾滤燒烧調调節节顏颜專专裝装變变臉脸預预覽览驗验談谈論论則则師师傳传統统處处壓压縮缩詞词記记憶忆習习慣惯狀状態态繼继續续輕轻靜静隨随帶带腳脚遠远邊边進进達达連连務务員员參参數数權权較较輸输贏赢雜杂難难簡简啟启蘋苹張张樓楼號号碼码劇剧團团園园圓圆麗丽齊齐歷历曆历滿满漢汉誰谁該该義义並并趕赶緊紧絕绝優优級级夠够誤误謂谓試试評评獎奖勵励戰战爭争總总結结貼贴陸陆輪轮擊击顯显塊块廣广驚惊幫帮係系誌志紀纪際际隊队陣阵險险擁拥護护舊旧麵面鐘钟錶表髮发臺台鬆松餘余範范獨独積积極极織织職职詳详細细營营銷销廳厅聯联盡尽燈灯眾众衛卫獲获頁页項项順顺須须領领願愿類类飯饭館馆驅驱賽赛贊赞資资賺赚貨货費费負负責责敗败財财規规親亲觀观計计訊讯訪访證证詢询護护譯译議议迴回週周遊游運运遲迟鄉乡醫医釋释針针鐵铁銀银鍵键閃闪閉闭雖虽雞鸡離离韓韩響响頂顶頓顿額额飄飘養养髒脏鬧闹麥麦嗎吗嚴严圍围壞坏殼壳爛烂獻献畢毕異异療疗礎础禮礼穩稳窮穷競竞筆笔簽签糧粮紙纸終终組组絲丝維维緒绪練练縣县績绩繪绘罰罚聞闻聖圣興兴舉举藝艺蘭兰蟲虫術术補补複复訴诉詩诗誠诚豐丰貓猫趨趋蹤踪跡迹載载輛辆輩辈辦办農农郵邮鄰邻鋼钢鎖锁鏈链陳陈隱隐靈灵韻韵顧顾飲饮駕驾騎骑鬥斗鮮鲜齡龄創创別别劃划動动勞劳勢势勝胜協协卻却厲厉吳吴喪丧嘗尝嚇吓堅坚夥伙奮奋婦妇孫孙寬宽審审屆届層层島岛幣币幹干彈弹彎弯復复徵征憂忧懷怀戀恋戶户掃扫掛挂採采換换揮挥損损搖摇擔担擴扩擺摆敵敌斷断暫暂曉晓楊杨構构槍枪樹树橋桥檢检櫃柜歐欧歸归殺杀毀毁決决況况淚泪淨净淺浅測测濟济溫温滅灭漸渐潔洁澤泽濕湿灣湾災灾烏乌煙烟煩烦熱热牆墙疊叠瘋疯監监稱称竊窃籠笼糾纠約约納纳紛纷純纯綜综編编緣缘繞绕繩绳羅罗聰聪脫脱膚肤臨临葉叶蓋盖蘇苏虛虚襲袭訓训託托許许註注誇夸誘诱諸诸謎谜譽誉讚赞豬猪貫贯賀贺賴赖贈赠軍军軌轨輔辅轉转辭辞邏逻遺遗適适錦锦鎮镇閒闲闆板闊阔隻只霧雾頌颂顆颗飽饱餅饼鬱郁鹽盐儘尽儀仪僅仅傷伤傑杰償偿儲储兒儿內内兩两冊册凍冻劉刘剛刚匯汇厭厌嘆叹寧宁寶宝尋寻屬属庫库廢废廠厂徑径憑凭懸悬擠挤擬拟攤摊棄弃業业樸朴橫横檔档殘残沒没漲涨滾滚潛潜瀏浏灑洒爐炉牽牵猶犹獅狮畝亩癢痒睏困碩硕礙碍稅税窩窝簾帘繫系縱纵纖纤羨羡膽胆艙舱蓮莲薦荐藥药虧亏衝冲褲裤觸触詐诈誕诞諾诺謊谎謹谨譜谱豈岂貢贡貸贷賓宾賞赏輝辉辯辩遞递遷迁醬酱鈔钞銳锐鍋锅鑰钥閣阁闖闯颱台餓饿駛驶騙骗騰腾驕骄鬍胡鯨鲸鴿鸽鵝鹅齣出'
  );
  const T2S = {};
  for (let i = 0; i + 1 < TS_PAIRS.length; i += 2) T2S[TS_PAIRS[i]] = TS_PAIRS[i + 1];

  // 同音/近形常見誤辨，統一成同一個字
  const ALIAS = { '妳': '你', '祂': '他', '牠': '它', '她': '他', '哪': '那', '嘛': '吗', '麽': '么', '甚': '什', '啦': '了', '喔': '哦', '噢': '哦', '唷': '哟' };
  const DIGITS = '零一二三四五六七八九';

  const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
  const WORD = /[\p{L}\p{N}]/u;

  function normChar(c) {
    if (c >= '0' && c <= '9') return DIGITS[c.charCodeAt(0) - 48];
    c = T2S[c] || c;
    return ALIAS[c] || c;
  }

  function normWord(w) {
    return w.toLowerCase().replace(/[’']/g, '');
  }

  // 把一段文字切成 [{text, start, end, norm}]，norm 為 null 代表標點/空白（不參與比對）
  function segment(text) {
    const out = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (CJK.test(c)) {
        out.push({ text: c, start: i, end: i + 1, norm: normChar(c) });
        i++;
      } else if (WORD.test(c)) {
        let j = i + 1;
        while (j < n && !CJK.test(text[j]) && (WORD.test(text[j]) || ((text[j] === "'" || text[j] === '’') && j + 1 < n && WORD.test(text[j + 1])))) j++;
        const w = text.slice(i, j);
        // 純數字逐位拆開，方便和「二零二五」之類對上
        if (/^\d+$/.test(w)) {
          for (let k = 0; k < w.length; k++) out.push({ text: w[k], start: i + k, end: i + k + 1, norm: normChar(w[k]) });
        } else {
          out.push({ text: w, start: i, end: j, norm: normWord(w) });
        }
        i = j;
      } else {
        let j = i + 1;
        while (j < n && !CJK.test(text[j]) && !WORD.test(text[j])) j++;
        out.push({ text: text.slice(i, j), start: i, end: j, norm: null });
        i = j;
      }
    }
    return out;
  }

  function tokenize(text) {
    return segment(text).filter(s => s.norm !== null).map(s => s.norm);
  }

  function sim(a, b) {
    if (a === b) return 2;
    // 英文詞：前綴相近給部分分
    if (a.length > 3 && b.length > 3 && a.slice(0, 4) === b.slice(0, 4)) return 1;
    return -1.5;
  }

  const GAP = 1;

  /**
   * 在稿子中找到「剛剛說的話」最可能結束的位置
   * @param {string[]} script  稿子 token
   * @param {string[]} query   最近聽到的 token（取尾端若干個）
   * @param {number} cursor    目前位置（下一個尚未念的 token index）
   * @returns {{pos:number, score:number}|null}  pos = 新的 cursor
   */
  function locate(script, query, cursor, opts) {
    opts = opts || {};
    const m = query.length;
    const n = script.length;
    if (m < 2 || n === 0) return null;

    const nearBack = opts.nearBack ?? 4;       // 允許往回微調的範圍
    const nearAhead = opts.nearAhead ?? 30;    // 視為「正常往前」的範圍
    const nearMin = opts.nearMin ?? 4;         // 附近：至少約 2 個字對上
    const farMin = opts.farMin ?? 10;          // 跳躍：至少約 5~6 個字連續對上

    let prev = new Float32Array(m + 1);
    let cur = new Float32Array(m + 1);
    let best = null;

    for (let j = 1; j <= n; j++) {
      cur[0] = 0;
      const t = script[j - 1];
      for (let i = 1; i <= m; i++) {
        let h = prev[i - 1] + sim(query[i - 1], t);
        const up = prev[i] - GAP;   // 稿子多了字（使用者漏念）
        const left = cur[i - 1] - GAP; // 使用者多說了字
        if (up > h) h = up;
        if (left > h) h = left;
        cur[i] = h > 0 ? h : 0;
      }
      const score = cur[m];
      // 對齊必須以「最新聽到的字」結尾，且結尾在稿子的字上真的對到
      if (score > 0 && sim(query[m - 1], t) > 0) {
        const pos = j; // 念完第 j 個 token → cursor 移到 j
        const d = pos - cursor;
        const near = d >= -nearBack && d <= nearAhead;
        const need = near ? nearMin : farMin;
        if (score >= need) {
          // 距離懲罰：越遠越難跳，往回比往前更難
          let penalty = 0;
          if (d > nearAhead) penalty = 1 + (d - nearAhead) * 0.01;
          else if (d < -nearBack) penalty = 2 + (-d) * 0.015;
          else penalty = Math.abs(d) * 0.02;
          const adj = score - penalty;
          if (!best || adj > best.adj) best = { pos, score, adj };
        }
      }
      const tmp = prev; prev = cur; cur = tmp;
    }
    return best;
  }

  function detectLang(text) {
    const kana = (text.match(/[぀-ヿ]/g) || []).length;
    const hangul = (text.match(/[가-힯]/g) || []).length;
    const han = (text.match(/[一-鿿]/g) || []).length;
    const latin = (text.match(/[a-zA-Z]/g) || []).length;
    if (kana > 5) return 'ja-JP';
    if (hangul > 5) return 'ko-KR';
    if (han > latin / 4) {
      // 繁簡判斷：看繁體字多還是簡體字多
      // 「台出面回只表」這類字既是某些字的簡體，本身也是常用繁體字，不能當成簡體的證據
      const SHARED = '台只里干面系出松表板胡采回周余志御困托注游制征郁后云范准划朴丑斗';
      let t = 0, s = 0;
      const simp = new Set(Object.values(T2S).filter(c => !SHARED.includes(c)));
      for (const c of text) { if (T2S[c]) t++; else if (simp.has(c)) s++; }
      return s > t ? 'zh-CN' : 'zh-TW';
    }
    return 'en-US';
  }

  const api = { segment, tokenize, locate, detectLang, normChar };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Tracker = api;
})(typeof window !== 'undefined' ? window : globalThis);
