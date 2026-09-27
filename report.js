// 問題回報：在背景記錄執行過程的事件與錯誤，產生可以複製、下載或貼到 GitHub 的報告
// 必須比其他程式先載入，才能抓到所有錯誤
(function (global) {
  'use strict';

  const MAX_EVENTS = 300;
  const events = [];
  const counts = {};
  const listeners = [];
  const t0 = performance.now();
  let alertCount = 0; // 上次打開回報視窗之後，累積的警告＋錯誤數

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function clock(d = new Date()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  // level：info（一般）| warn（可自動恢復的異常）| error（錯誤）
  function log(cat, msg, level = 'info') {
    events.push({ time: clock(), rel: (performance.now() - t0) / 1000, cat, msg: String(msg), level });
    if (events.length > MAX_EVENTS) events.shift();
    if (level !== 'info') alertCount++;
    for (const fn of listeners) { try { fn(); } catch {} }
  }

  function count(key) { counts[key] = (counts[key] || 0) + 1; }

  global.addEventListener('error', e => {
    const where = e.filename ? ` @ ${e.filename.split('/').pop()}:${e.lineno}:${e.colno}` : '';
    log('js', (e.message || '未知錯誤') + where, 'error');
  });
  global.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    log('js', '未處理的 Promise 錯誤：' + ((r && (r.stack || r.message)) || r), 'error');
  });
  global.addEventListener('online', () => log('env', '網路恢復連線'));
  global.addEventListener('offline', () => log('env', '網路斷線', 'warn'));

  const MARK = { info: '  ', warn: '⚠ ', error: '✖ ' };
  function formatEvent(e) {
    return `[${e.time} +${e.rel.toFixed(1)}s] ${MARK[e.level]}${e.cat.padEnd(5)} ${e.msg}`;
  }

  async function micPermission() {
    try {
      const p = await navigator.permissions.query({ name: 'microphone' });
      return { granted: '已允許', denied: '已拒絕', prompt: '尚未詢問' }[p.state] || p.state;
    } catch { return '無法查詢'; }
  }

  // 產生報告（env：由主程式提供的目前狀態）
  async function build({ description = '', env = {} } = {}) {
    const lines = [];
    lines.push('語音提詞器 問題回報');
    lines.push('====================');
    lines.push('');
    lines.push('【發生了什麼事】');
    lines.push(description.trim() || '（未填寫）');
    lines.push('');
    lines.push('【環境】');
    const info = Object.assign({
      '回報時間': new Date().toLocaleString('zh-TW', { hour12: false }),
      '網址': location.href,
      '瀏覽器': navigator.userAgent,
      '安全連線': global.isSecureContext ? '是' : '否（麥克風可能無法使用）',
      '網路': navigator.onLine ? '連線中' : '離線',
      '麥克風權限': await micPermission(),
      '頁面已開啟': ((performance.now() - t0) / 1000).toFixed(0) + ' 秒',
    }, env);
    for (const [k, v] of Object.entries(info)) {
      lines.push(`${k}：${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    lines.push('');
    lines.push('【統計】');
    const keys = Object.keys(counts);
    if (keys.length) for (const k of keys.sort()) lines.push(`${k}：${counts[k]} 次`);
    else lines.push('（無）');
    lines.push('');
    lines.push(`【事件紀錄（最近 ${events.length} 筆，⚠ 警告 ✖ 錯誤）】`);
    for (const e of events) lines.push(formatEvent(e));
    return lines.join('\n');
  }

  global.Report = {
    log, count, build, formatEvent,
    recent: n => events.slice(-n),
    get alertCount() { return alertCount; },
    clearAlerts() { alertCount = 0; for (const fn of listeners) { try { fn(); } catch {} } },
    onChange(fn) { listeners.push(fn); },
  };

  log('env', '頁面載入');
})(window);
