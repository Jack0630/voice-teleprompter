(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  const SAMPLE = `# 開場
大家好，歡迎使用這個語音提詞器。
它會跟著你說話的速度往下捲動，你說快它就快，你說慢它就慢，你停下來它也會停下來。

# 說錯了也不怕
就算你念錯了幾個字，或者臨時換了一個說法，它也會靠上下文找到你現在念到哪一行。
如果你想回頭重講一段，直接從那一段開始念，它會自動跳回去。
想跳過中間幾行，也可以直接念後面的內容。
如果你即興脫稿講一段，它會安靜地等你回來。

# 眼神貼近鏡頭
提詞的區域放在畫面最上方，也就是最靠近鏡頭的位置。
你正在念的那一行會盡量停在上方。當你卡住停下來的時候，還沒念的內容會被輕輕地提到更靠近鏡頭的地方。

# 小技巧
長按畫面任何地方，就可以回到編輯頁修改稿子。
開錄之前，記得先對著提詞器把稿子完整念一遍，把繞口的地方全部改順。`;

  const APP_VERSION = '1.3.0';
  const SETTINGS_VERSION = 2;
  const DEFAULTS = {
    script: SAMPLE, mode: 'voice', lang: 'zh-TW',
    fontSize: 52, lineHeight: 1.5, width: 80, bandSize: 45, speed: 60,
    camera: false, mirror: false, showHeard: true,
    v: SETTINGS_VERSION,
  };
  const STORE_KEY = 'voice-teleprompter-v1';

  function load() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch {}
    // 舊版預設是「自動偵測」，升級時改成中文（台灣）；之後使用者自己選的就不動
    if ((saved.v || 1) < 2 && saved.lang === 'auto') saved.lang = 'zh-TW';
    saved.v = SETTINGS_VERSION;
    return Object.assign({}, DEFAULTS, saved);
  }
  let saveT;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch {} }, 300);
  }

  const S = load();

  // ---------- DOM ----------
  const editor = $('#editor'), prompter = $('#prompter');
  const ta = $('#script'), track = $('#track'), band = $('#band'), marker = $('#marker');
  const bar = $('#bar'), heardEl = $('#heard'), statusEl = $('#status');
  const cam = $('#cam'), btnPlay = $('#btnPlay'), btnRec = $('#btnRec'), recTime = $('#recTime');

  // ---------- 稿子狀態 ----------
  let tokens = [], tokEls = [], tokSrc = [], tops = [], chapters = [];
  let renderedKey = '';
  let cursor = 0, painted = 0;
  let lineH = 78;

  // ---------- 捲動狀態 ----------
  let y = 0, playing = false, lastT = 0;
  let manualUntil = 0;       // 使用者手動拖曳期間，暫停自動對位
  let lastProgress = 0;      // 上一次語音推進的時間
  let liftedTop = null;      // 停頓時「把沒讀的內容提上來」

  // ---------- 語音狀態 ----------
  let rec = null, listening = false;
  let heardFinal = [], heardText = '', hearT;
  const QLEN = 16;

  // ================= 渲染 =================
  function el(tag, cls, text) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function render() {
    const key = S.mode + '\u0000' + S.script;
    if (key === renderedKey) return;
    renderedKey = key;

    tokens = []; tokEls = []; tokSrc = []; chapters = [];
    const frag = document.createDocumentFragment();
    let off = 0, prevBlank = true;
    for (const line of S.script.split('\n')) {
      const trimmed = line.trim();
      if (/^#/.test(trimmed)) {
        const title = trimmed.replace(/^#+\s*/, '');
        const d = el('div', 'chapter', title);
        chapters.push({ title, i: tokens.length });
        frag.appendChild(d);
      } else if (!trimmed) {
        // 語音模式：空行自動壓縮；固定速度模式：保留（最多一個）
        if (S.mode === 'fixed' && !prevBlank) frag.appendChild(el('div', 'blank'));
      } else {
        const d = el('div', 'line');
        for (const seg of Tracker.segment(line)) {
          if (seg.norm === null) { d.appendChild(document.createTextNode(seg.text)); continue; }
          const sp = el('span', 'tk', seg.text);
          sp.dataset.i = tokens.length;
          tokens.push(seg.norm);
          tokEls.push(sp);
          tokSrc.push(off + seg.start);
          d.appendChild(sp);
        }
        frag.appendChild(d);
      }
      prevBlank = !trimmed;
      off += line.length + 1;
    }
    track.textContent = '';
    track.appendChild(frag);
    painted = 0;
    cursor = Math.min(cursor, tokens.length);

    const box = $('#chapters');
    box.textContent = '';
    chapters.forEach((c, k) => {
      const b = el('button', null, c.title || `第 ${k + 1} 段`);
      b.onclick = () => jumpTo(c.i);
      c.btn = b;
      box.appendChild(b);
    });
  }

  function relayout() {
    track.style.fontSize = S.fontSize + 'px';
    track.style.lineHeight = S.lineHeight;
    track.style.width = S.width + '%';
    band.style.height = S.bandSize + '%';
    prompter.classList.toggle('mirror', S.mirror);
    lineH = S.fontSize * S.lineHeight;
    tops = tokEls.map(e => e.offsetTop);
    paint();
  }

  function paint() {
    const c = Math.min(cursor, tokEls.length);
    if (c > painted) for (let i = painted; i < c; i++) tokEls[i].classList.add('read');
    else for (let i = c; i < painted; i++) tokEls[i].classList.remove('read');
    painted = c;

    let cur = -1;
    chapters.forEach((ch, k) => { if (ch.i <= cursor) cur = k; });
    chapters.forEach((ch, k) => ch.btn && ch.btn.classList.toggle('on', k === cur));
  }

  // ================= 位置計算 =================
  function anchorPx() {
    const bh = band.clientHeight;
    const normal = Math.min(Math.max(lineH * 0.9, bh * 0.2), bh * 0.45);
    const lifted = lineH * 0.15;
    if (S.mode !== 'voice' || !listening || cursor === 0 || cursor >= tokens.length) { liftedTop = null; return normal; }
    const top = tops[cursor];
    if (liftedTop !== null && liftedTop === top) return lifted;
    liftedTop = null;
    if (performance.now() - lastProgress > 1800) { liftedTop = top; return lifted; }
    return normal;
  }

  function topOf(i) {
    if (!tops.length) return 0;
    if (i >= tops.length) return tops[tops.length - 1] + lineH;
    return tops[Math.max(0, i)];
  }

  // 找到畫面某個高度對應的第一個 token
  function tokenAt(py) {
    let lo = 0, hi = tops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid] + lineH / 2 < py) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function setCursor(i) {
    cursor = Math.max(0, Math.min(tokens.length, i));
    paint();
  }

  // 使用者主動改變位置（點字、章節、方向鍵）
  function jumpTo(i) {
    setCursor(i);
    heardFinal = [];
    lastProgress = performance.now();
    liftedTop = null;
    manualUntil = 0;
    if (S.mode === 'fixed') y = topOf(cursor) - anchorPx();
  }

  function lineStep(dir) {
    const cur = Math.min(cursor, tops.length - 1);
    if (cur < 0) return;
    const t = tops[cur];
    if (dir > 0) {
      let i = cur;
      while (i < tops.length && tops[i] <= t + 2) i++;
      jumpTo(i);
    } else {
      let i = cur - 1;
      while (i >= 0 && tops[i] >= t - 2) i--;
      if (i < 0) return jumpTo(0);
      const pt = tops[i];
      while (i > 0 && tops[i - 1] >= pt - 2) i--;
      jumpTo(i);
    }
  }

  // ================= 動畫迴圈 =================
  function frame(t) {
    const dt = Math.min(0.1, (t - lastT) / 1000 || 0);
    lastT = t;
    if (!prompter.hidden) {
      const anchor = anchorPx();
      const maxY = topOf(tokens.length) - anchor;
      if (S.mode === 'fixed') {
        if (playing && t > manualUntil) {
          y += S.speed * dt;
          if (y >= maxY) { y = maxY; setPlaying(false); }
        }
        const c = tokenAt(y + anchor);
        if (c !== cursor) setCursor(c);
      } else if (t > manualUntil) {
        const target = topOf(cursor) - anchor;
        y += (target - y) * (1 - Math.exp(-dt * 6));
      }
      track.style.transform = `translateY(${-y}px)`;
      marker.style.top = (anchor + lineH / 2 - 10) + 'px';
    }
    requestAnimationFrame(frame);
  }

  // ================= 語音辨識 =================
  function recogLang() {
    return S.lang === 'auto' ? Tracker.detectLang(S.script) : S.lang;
  }

  function setStatus(s, text) {
    statusEl.className = 'status ' + (s || '');
    statusEl.textContent = text != null ? text : ({ listening: '聆聽中', hearing: '聆聽中', error: '錯誤' }[s] || '已暫停');
  }

  // 回傳追蹤結果的說明文字（寫進事件紀錄）
  function onSpeech(q) {
    const r = Tracker.locate(tokens, q, cursor);
    if (!r) return '對不上稿子，等待';                          // 脫稿／雜音 → 安靜等待
    if (r.pos < cursor && r.pos >= cursor - 4) return '小幅倒退，忽略'; // 視為抖動
    const from = cursor;
    if (r.pos !== cursor) {
      setCursor(r.pos);
      manualUntil = 0;
    }
    lastProgress = performance.now();
    if (Math.abs(r.pos - from) > 30) Report.log('track', `跳到第 ${r.pos} 字（原本在第 ${from} 字）`);
    return `位置 ${cursor}/${tokens.length}`;
  }

  // Chrome 的連續辨識會不定時自己斷線，說話說到一半還會「靜默卡住」（不回結果、不報錯、不觸發 onend）。
  // 對策：
  //  1. 自己監聽麥克風音量：聽到你在說話、辨識卻一直沒回應 → 約 2.5 秒內換新連線
  //  2. 看門狗：完全沒有任何事件太久 → 換新連線（音量偵測不可用時的備援）
  //  3. 換連線時等舊的真正關閉再開新的，避免兩條連線互搶麥克風
  //  4. 每次都建立全新的辨識實例；快速失敗時逐步拉長重試間隔
  let recGen = 0;          // 每條連線的編號，舊連線的事件一律忽略
  let lastRecEvent = 0;    // 最後一次收到任何辨識事件的時間
  let lastResult = 0;      // 最後一次收到辨識結果的時間
  let sessionStart = 0;
  let restartDelay = 150;
  let restartT, watchdogT;
  let everStarted = false; // 這次播放中是否成功開始過

  const WATCHDOG_MS = 8000;     // 超過這麼久沒有任何事件 → 視為卡住
  const STALL_SPEECH_MS = 2500; // 偵測到說話這麼久、卻沒有任何辨識結果 → 視為卡住
  const MAX_SESSION_MS = 45000; // 單條連線用太久 → 趁句子結束時換新的
  const MAX_BACKOFF_MS = 2000;

  // ---------- 事件紀錄（寫進問題回報；網址加上 ?debug 會在右上角即時顯示） ----------
  const DEBUG = /[?&]debug\b/.test(location.search);
  function dbg(msg, level) { Report.log('rec', msg, level); }
  if (DEBUG) {
    const box = el('pre', 'dbg');
    box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:20;margin:0;padding:8px 10px;max-width:46vw;background:rgba(0,0,0,.8);color:#9ee6a8;font:12px/1.5 monospace;border-radius:8px;pointer-events:none;white-space:pre-wrap';
    document.body.appendChild(box);
    const draw = () => { box.textContent = Report.recent(18).map(Report.formatEvent).join('\n'); };
    Report.onChange(draw);
    draw();
  }

  // ---------- 麥克風音量偵測 ----------
  // Android 上同時開兩個麥克風來源會讓辨識失效，所以手機上不啟用，只靠看門狗
  const VAD_OK = !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  let vad = null;           // { ctx, stream, analyser, buf }
  let noiseFloor = 0.01;
  let speakingMs = 0;       // 上次有辨識結果之後，累積偵測到的說話時間

  async function startVAD() {
    if (!VAD_OK || vad || !navigator.mediaDevices) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!listening) { stream.getTracks().forEach(t => t.stop()); return; }
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      vad = { ctx, stream, analyser, buf: new Float32Array(analyser.fftSize) };
      dbg('音量偵測啟動');
    } catch (err) {
      dbg('音量偵測無法啟動：' + err.message, 'warn');
    }
  }

  function stopVAD() {
    if (!vad) return;
    vad.stream.getTracks().forEach(t => t.stop());
    try { vad.ctx.close(); } catch {}
    vad = null;
  }

  // 回傳目前是否有人在說話
  function isSpeaking() {
    if (!vad) return false;
    if (vad.ctx.state === 'suspended') vad.ctx.resume();
    vad.analyser.getFloatTimeDomainData(vad.buf);
    let sum = 0;
    for (const v of vad.buf) sum += v * v;
    const rms = Math.sqrt(sum / vad.buf.length);
    // 背景噪音基準：安靜時慢慢跟上，有聲音時幾乎不動
    noiseFloor += (rms - noiseFloor) * (rms < noiseFloor * 2 ? 0.05 : 0.002);
    return rms > Math.max(0.02, noiseFloor * 3);
  }

  function createRec() {
    const gen = ++recGen;
    const r = new SR();
    r.lang = recogLang();
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    const alive = () => gen === recGen && listening;
    const touch = () => { if (alive()) lastRecEvent = performance.now(); };

    r.onaudiostart = r.onsoundstart = r.onspeechstart = touch;
    r.onstart = () => {
      if (!alive()) return;
      touch();
      everStarted = true;
      dbg(`#${gen} 開始`);
      setStatus('listening');
    };

    r.onresult = e => {
      if (!alive()) return;
      touch();
      lastResult = performance.now();
      speakingMs = 0;
      restartDelay = 150;
      let interim = '', finalText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i], txt = res[0].transcript;
        if (res.isFinal) {
          heardFinal.push(...Tracker.tokenize(txt));
          heardText = (heardText + txt).slice(-80);
          finalText += txt;
        } else interim += txt;
      }
      const gotFinal = !!finalText;
      if (heardFinal.length > 80) heardFinal = heardFinal.slice(-QLEN * 2);
      const q = heardFinal.concat(Tracker.tokenize(interim)).slice(-QLEN);
      heardEl.textContent = (heardText + interim).slice(-60) || '…';
      setStatus('hearing');
      clearTimeout(hearT);
      hearT = setTimeout(() => listening && setStatus('listening'), 700);
      const outcome = onSpeech(q);
      // 只記錄完整的句子（中間結果太頻繁）
      if (gotFinal) {
        Report.count('辨識到的句子');
        const shown = finalText.length > 24 ? '…' + finalText.slice(-24) : finalText;
        dbg(`#${gen} 聽到「${shown}」→ ${outcome}`);
      }
      // 連線太久，瀏覽器內部累積的結果會越來越多，趁一句話剛結束時換新連線
      if (gotFinal && !interim && performance.now() - sessionStart > MAX_SESSION_MS) recycle('連線超過 45 秒');
    };

    r.onerror = e => {
      if (!alive()) return;
      touch();
      // no-speech（沒聽到聲音）、aborted（被我們主動中止）是正常現象
      const level = { 'no-speech': 'info', 'aborted': 'info', 'network': 'warn', 'audio-capture': 'warn' }[e.error] || 'error';
      Report.count('辨識錯誤：' + e.error);
      dbg(`#${gen} 錯誤：${e.error}${e.message ? '（' + e.message + '）' : ''}`, level);
      switch (e.error) {
        case 'not-allowed':
        case 'service-not-allowed':
          if (everStarted) {
            // 用到一半被瀏覽器擋下自動重啟（常見於 Safari），需要使用者再點一次
            pauseWith('已中斷，點 ▶ 繼續');
          } else {
            pauseWith('無麥克風權限');
            toast('麥克風權限被拒絕。請點網址列左側的圖示允許麥克風，然後再按一次 ▶。');
          }
          break;
        case 'language-not-supported':
          pauseWith('不支援此語言');
          toast('這個瀏覽器不支援「' + r.lang + '」的語音辨識。');
          break;
        case 'audio-capture':
          setStatus('error', '麥克風被佔用');
          toast('抓不到麥克風。如果開著鏡頭預覽，有些手機無法同時錄影又辨識，可以先關掉 📷 試試。');
          break;
        case 'network':
          setStatus('error', '重新連線中…');
          break;
        // no-speech / aborted：正常現象，onend 會自動重啟
      }
    };

    r.onend = () => {
      if (!alive()) return;
      // 連線很快就結束 → 可能在出錯，拉長重試間隔；正常結束 → 馬上重啟
      const lived = performance.now() - sessionStart;
      restartDelay = lived < 1500 ? Math.min(restartDelay * 2, MAX_BACKOFF_MS) : 150;
      dbg(`#${gen} 結束（${(lived / 1000).toFixed(1)}s），${restartDelay}ms 後重啟`);
      scheduleRestart();
    };

    rec = r;
    sessionStart = lastRecEvent = lastResult = performance.now();
    speakingMs = 0;
    dbg(`#${gen} start()`);
    try { r.start(); }
    catch (err) {
      Report.count('start() 失敗');
      dbg(`#${gen} start() 失敗：${err.message}`, 'warn');
      restartDelay = Math.min(restartDelay * 2, MAX_BACKOFF_MS);
      scheduleRestart();
    }
  }

  function scheduleRestart() {
    clearTimeout(restartT);
    restartT = setTimeout(() => {
      // 分頁在背景時瀏覽器不給辨識，等切回來再由 visibilitychange 重啟
      if (listening && !document.hidden) createRec();
    }, restartDelay);
  }

  // 丟掉目前的連線，等它真正關閉後再開一條新的（最多等 1 秒）
  // 正常的例行換連線；其他原因（卡住）記成警告
  const ROUTINE_RECYCLE = ['連線超過 45 秒', '切回分頁'];
  function recycle(reason) {
    Report.count('換新連線：' + reason);
    dbg('換新連線：' + reason, ROUTINE_RECYCLE.includes(reason) ? 'info' : 'warn');
    const old = rec;
    recGen++;           // 讓舊連線之後的事件全部失效
    rec = null;
    clearTimeout(restartT);
    restartDelay = 50;
    if (!old) return scheduleRestart();
    let done = false;
    const go = () => { if (!done) { done = true; scheduleRestart(); } };
    old.onend = go;
    setTimeout(go, 1000);
    try { old.abort(); } catch { go(); }
  }

  const TICK_MS = 250;
  function watchdogTick() {
    if (!listening || document.hidden || !rec) return;
    const now = performance.now();
    // 聽到你在說話，辨識卻沒有回應 → 卡住了
    if (isSpeaking()) {
      speakingMs += TICK_MS;
      if (speakingMs >= STALL_SPEECH_MS && now - lastResult > STALL_SPEECH_MS && now - sessionStart > 1500) {
        speakingMs = 0;
        return recycle('有說話但辨識沒回應');
      }
    }
    if (now - lastRecEvent > WATCHDOG_MS) recycle('太久沒有任何事件');
  }

  function startListening() {
    if (!SR) { toast('這個瀏覽器不支援語音辨識，請用 Chrome 或 Edge。'); return false; }
    if (!tokens.length) { toast('稿子是空的'); return false; }
    listening = true;
    everStarted = false;
    restartDelay = 150;
    lastProgress = performance.now();
    heardFinal = [];
    heardText = '';
    setStatus('listening', '啟動中…');
    dbg(`開始聆聽（語言 ${recogLang()}，音量偵測${VAD_OK ? '開啟' : '在手機上停用'}）`);
    createRec();
    startVAD();
    clearInterval(watchdogT);
    watchdogT = setInterval(watchdogTick, TICK_MS);
    return true;
  }

  function stopListening() {
    if (listening) dbg('停止聆聽');
    listening = false;
    recGen++;
    clearTimeout(restartT);
    clearInterval(watchdogT);
    if (rec) { try { rec.abort(); } catch {} rec = null; }
    stopVAD();
    setStatus('');
  }

  // 無法自動恢復的情況：停下來並告訴使用者原因
  function pauseWith(msg) {
    dbg('停止：' + msg, 'error');
    setPlaying(false);
    setStatus('error', msg);
  }

  // ================= 播放控制 =================
  function setPlaying(on) {
    if (S.mode === 'voice') {
      if (on) on = startListening(); else stopListening();
      playing = on;
    } else {
      stopListening();
      playing = on;
      setStatus(on ? 'listening' : '', on ? '捲動中' : '已暫停');
    }
    btnPlay.textContent = playing ? '❚❚' : '▶';
    heardEl.hidden = !(S.showHeard && S.mode === 'voice' && playing);
    if (!playing) bar.classList.remove('dim');
    else poke();
  }

  function setMode(m) {
    if (m === S.mode) return;
    const wasPlaying = playing;
    setPlaying(false);
    S.mode = m; save();
    syncSeg();
    const keep = cursor;
    render();
    if (!prompter.hidden) {
      relayout();
      setCursor(keep);
      y = topOf(cursor) - anchorPx();
      if (wasPlaying) setPlaying(true);
    }
    $('#speedCtl').hidden = m !== 'fixed';
  }

  function syncSeg() {
    document.querySelectorAll('#modeSeg button, #modeSeg2 button').forEach(b => b.classList.toggle('on', b.dataset.v === S.mode));
    $('#speedCtl').hidden = S.mode !== 'fixed';
    $('#speedLabel').textContent = S.speed + ' px/s';
  }

  // ================= 鏡頭與錄影 =================
  let camStream = null, recorder = null, chunks = [], recStart = 0, recTimer;

  async function setCamera(on) {
    if (on && !camStream) {
      try {
        camStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: true,
        });
        cam.srcObject = camStream;
      } catch (err) {
        Report.log('cam', `無法開啟鏡頭：${err.name} ${err.message}`, 'error');
        toast('無法開啟鏡頭：' + err.message);
        on = false;
      }
    }
    if (!on && camStream) {
      stopRecording();
      camStream.getTracks().forEach(t => t.stop());
      camStream = null;
      cam.srcObject = null;
    }
    cam.hidden = !on;
    btnRec.hidden = !on;
    prompter.classList.toggle('cam-on', on);
    return on;
  }

  function startRecording() {
    if (!camStream || !window.MediaRecorder) return;
    const type = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) || '';
    recorder = new MediaRecorder(camStream, type ? { mimeType: type, videoBitsPerSecond: 8e6 } : undefined);
    chunks = [];
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
    recorder.onerror = e => Report.log('cam', '錄影錯誤：' + (e.error ? e.error.message : '未知'), 'error');
    Report.log('cam', '開始錄影（' + (type || '瀏覽器預設格式') + '）');
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      const d = new Date(), p = n => String(n).padStart(2, '0');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `提詞錄影_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      toast('錄影已下載');
    };
    recorder.start(1000);
    recStart = Date.now();
    btnRec.classList.add('on');
    recTime.hidden = false;
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      recTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 250);
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    recorder = null;
    clearInterval(recTimer);
    btnRec.classList.remove('on');
    recTime.hidden = true;
    recTime.textContent = '0:00';
  }

  // ================= 切換頁面 =================
  let wakeLock = null;

  async function openPrompter() {
    S.script = ta.value;
    save();
    render();
    if (!tokens.length) { toast('先貼上稿子吧'); return; }

    // 從編輯器游標位置開始
    const pos = ta.selectionStart;
    if (pos > 0 && pos < ta.value.length) {
      let i = tokSrc.findIndex(s => s >= pos);
      cursor = i < 0 ? 0 : i;
    } else cursor = 0;

    Report.log('ui', `開始提詞（${S.mode === 'voice' ? '語音追蹤' : '固定速度'}，${tokens.length} 字，從第 ${cursor} 字開始）`);
    editor.hidden = true;
    prompter.hidden = false;
    relayout();
    paint();
    y = topOf(cursor) - anchorPx();
    syncSeg();
    if (S.camera) await setCamera(true);
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    if (S.mode === 'voice') setPlaying(true);
    else setStatus('', '已暫停');
  }

  function openEditor() {
    Report.log('ui', '回到編輯頁');
    setPlaying(false);
    setCamera(false);
    try { wakeLock?.release(); } catch {}
    wakeLock = null;
    prompter.hidden = true;
    editor.hidden = false;
    const p = cursor < tokSrc.length ? tokSrc[cursor] : ta.value.length;
    ta.focus();
    ta.setSelectionRange(p, p);
    ta.scrollTop = Math.max(0, (p / Math.max(1, ta.value.length)) * ta.scrollHeight - ta.clientHeight / 3);
    updateStats();
  }

  // ================= 互動：拖曳、點字、長按 =================
  let down = null, pressT;

  prompter.addEventListener('pointerdown', e => {
    if (bar.contains(e.target)) return;
    down = { x: e.clientX, y: e.clientY, sy: y, moved: false, long: false, target: e.target };
    clearTimeout(pressT);
    pressT = setTimeout(() => {
      if (down && !down.moved) { down.long = true; openEditor(); }
    }, 650);
  });

  prompter.addEventListener('pointermove', e => {
    poke();
    if (!down) return;
    const dy = e.clientY - down.y;
    if (!down.moved && Math.hypot(e.clientX - down.x, dy) > 8) { down.moved = true; clearTimeout(pressT); }
    if (down.moved) manualScroll(down.sy - dy);
  });

  const endPress = () => {
    clearTimeout(pressT);
    if (down && !down.moved && !down.long) {
      const t = down.target.closest && down.target.closest('.tk');
      if (t) jumpTo(+t.dataset.i);
      else if (S.mode === 'fixed') setPlaying(!playing);
    }
    down = null;
  };
  prompter.addEventListener('pointerup', endPress);
  prompter.addEventListener('pointercancel', () => { clearTimeout(pressT); down = null; });

  prompter.addEventListener('wheel', e => {
    if (bar.contains(e.target)) return;
    e.preventDefault();
    manualScroll(y + e.deltaY);
  }, { passive: false });

  function manualScroll(ny) {
    y = Math.max(-anchorPx(), ny);
    manualUntil = performance.now() + 1200;
    if (S.mode === 'voice') {
      setCursor(tokenAt(y + anchorPx()));
      heardFinal = [];
      lastProgress = performance.now();
    }
  }

  // 播放中控制列自動變淡，避免分心
  let dimT;
  function poke() {
    bar.classList.remove('dim');
    clearTimeout(dimT);
    if (playing) dimT = setTimeout(() => playing && bar.classList.add('dim'), 3000);
  }

  // ================= 鍵盤 =================
  document.addEventListener('keydown', e => {
    if (!reportDlg.hidden) {
      if (e.key === 'Escape') closeReport();
      return; // 回報視窗開著時，不觸發提詞器的快捷鍵
    }
    if (prompter.hidden) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); openPrompter(); }
      return;
    }
    const k = e.key;
    if (k === ' ') { e.preventDefault(); setPlaying(!playing); }
    else if (k === 'Escape') openEditor();
    else if (k === 'ArrowDown' || k === 'PageDown') { e.preventDefault(); lineStep(1); }
    else if (k === 'ArrowUp' || k === 'PageUp') { e.preventDefault(); lineStep(-1); }
    else if (k === 'ArrowRight') changeSpeed(10);
    else if (k === 'ArrowLeft') changeSpeed(-10);
    else if (k === '+' || k === '=') changeFont(4);
    else if (k === '-' || k === '_') changeFont(-4);
    else if (k === 'Home') jumpTo(0);
    else return;
    poke();
  });

  function changeSpeed(d) {
    S.speed = Math.max(10, Math.min(300, S.speed + d));
    save(); syncSeg(); syncInputs();
  }
  function changeFont(d) {
    S.fontSize = Math.max(24, Math.min(120, S.fontSize + d));
    save(); syncInputs();
    relayout();
    y = topOf(cursor) - anchorPx();
  }

  // ================= 控制列 =================
  btnPlay.onclick = () => setPlaying(!playing);
  $('#btnEdit').onclick = openEditor;
  $('#btnCam').onclick = async () => { S.camera = await setCamera(!camStream); save(); syncInputs(); };
  btnRec.onclick = () => (recorder ? stopRecording() : startRecording());
  bar.addEventListener('click', e => {
    const a = e.target.dataset && e.target.dataset.act;
    if (a === 'slower') changeSpeed(-10);
    else if (a === 'faster') changeSpeed(10);
    else if (a === 'smaller') changeFont(-4);
    else if (a === 'bigger') changeFont(4);
  });
  document.querySelectorAll('#modeSeg button, #modeSeg2 button').forEach(b => b.onclick = () => setMode(b.dataset.v));

  // ================= 編輯頁設定 =================
  const ranges = {
    fontSize: v => v + ' px',
    lineHeight: v => (+v).toFixed(1),
    width: v => v + '%',
    bandSize: v => v + '%',
    speed: v => v + ' px/s',
  };

  function syncInputs() {
    for (const [k, fmt] of Object.entries(ranges)) {
      $('#' + k).value = S[k];
      $('#' + k + 'Out').textContent = fmt(S[k]);
    }
    $('#lang').value = S.lang;
    $('#camera').checked = S.camera;
    $('#mirror').checked = S.mirror;
    $('#showHeard').checked = S.showHeard;
  }

  for (const k of Object.keys(ranges)) {
    $('#' + k).addEventListener('input', e => {
      S[k] = +e.target.value;
      $('#' + k + 'Out').textContent = ranges[k](S[k]);
      save();
      syncSeg();
    });
  }
  $('#lang').onchange = e => { S.lang = e.target.value; save(); updateStats(); };
  $('#camera').onchange = e => { S.camera = e.target.checked; save(); };
  $('#mirror').onchange = e => { S.mirror = e.target.checked; save(); };
  $('#showHeard').onchange = e => { S.showHeard = e.target.checked; save(); };
  $('#btnStart').onclick = openPrompter;

  ta.addEventListener('input', () => { S.script = ta.value; save(); updateStats(); });

  // 章節標題不用念，不算進字數
  const stripChapters = text => text.replace(/^\s*#.*$/gm, '');

  function updateStats() {
    const n = Tracker.tokenize(stripChapters(ta.value)).length;
    const lang = S.lang === 'auto' ? Tracker.detectLang(ta.value) : S.lang;
    const perMin = /^(zh|yue|ja|ko|cmn)/.test(lang) ? 240 : 150; // 中文約每分鐘 240 字，英文約 150 詞
    const sec = Math.round(n / perMin * 60);
    const chs = (ta.value.match(/^\s*#/gm) || []).length;
    $('#stats').textContent = `${n} 字・預估 ${Math.floor(sec / 60)} 分 ${sec % 60} 秒・${chs} 個章節・辨識語言 ${lang}`;
  }

  // ================= 問題回報 =================
  const reportDlg = $('#reportDlg'), reportText = $('#reportText'), reportDesc = $('#reportDesc');
  const ISSUE_URL = 'https://github.com/Jack0630/voice-teleprompter/issues/new';
  let lastReport = '';

  function reportEnv() {
    const { script, ...settings } = S;
    return {
      '程式版本': APP_VERSION,
      '畫面': prompter.hidden ? '編輯頁' : '提詞頁',
      '模式': S.mode === 'voice' ? '語音追蹤' : '固定速度',
      '辨識語言': recogLang() + (S.lang === 'auto' ? '（自動偵測）' : ''),
      '瀏覽器支援語音辨識': SR ? '是' : '否',
      '正在聆聽': listening ? '是' : '否',
      '音量偵測': vad ? '運作中' : (VAD_OK ? '未運作' : '手機上停用'),
      '鏡頭': camStream ? '開啟' : '關閉',
      '稿子': `${Tracker.tokenize(stripChapters(script)).length} 字、${(script.match(/^\s*#/gm) || []).length} 個章節`,
      '目前位置': `第 ${cursor} 字 / 共 ${tokens.length} 字`,
      '設定': settings,
    };
  }

  async function refreshReport() {
    lastReport = await Report.build({ description: reportDesc.value, env: reportEnv() });
    reportText.textContent = lastReport;
  }

  function openReport() {
    Report.clearAlerts();
    reportDlg.hidden = false;
    refreshReport();
    reportDesc.focus();
  }
  function closeReport() { reportDlg.hidden = true; }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      // 備援：選取文字後用舊方法複製
      const tmp = el('textarea');
      tmp.value = text;
      tmp.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(tmp);
      tmp.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      tmp.remove();
      return ok;
    }
  }

  function stampName() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // GitHub 網址長度有限：放不下就保留開頭的環境資訊＋最後面的事件
  function fitForUrl(text, limit = 6000) {
    if (encodeURIComponent(text).length <= limit) return text;
    const lines = text.split('\n');
    const head = lines.findIndex(l => l.startsWith('【事件紀錄'));
    const top = lines.slice(0, head + 1);
    const note = '（紀錄太長已截斷，完整報告已複製到剪貼簿，可以貼在這下面）';
    const tail = [];
    for (let i = lines.length - 1; i > head; i--) {
      const next = [...top, note, lines[i], ...tail].join('\n');
      if (encodeURIComponent(next).length > limit) break;
      tail.unshift(lines[i]);
    }
    return [...top, note, ...tail].join('\n');
  }

  document.querySelectorAll('.report-btn').forEach(b => b.onclick = openReport);
  $('#reportClose').onclick = closeReport;
  reportDlg.addEventListener('pointerdown', e => { if (e.target === reportDlg) closeReport(); });
  let descT;
  reportDesc.addEventListener('input', () => { clearTimeout(descT); descT = setTimeout(refreshReport, 300); });

  $('#reportCopy').onclick = async () => {
    await refreshReport();
    toast(await copyText(lastReport) ? '報告已複製，可以直接貼上' : '複製失敗，請手動選取下方文字複製');
  };
  $('#reportDownload').onclick = async () => {
    await refreshReport();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lastReport], { type: 'text/plain;charset=utf-8' }));
    a.download = `提詞器問題回報_${stampName()}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  };
  $('#reportGithub').onclick = async () => {
    await refreshReport();
    await copyText(lastReport);
    const first = reportDesc.value.trim().split('\n')[0].slice(0, 40);
    const title = '問題回報：' + (first || '語音辨識異常');
    const body = '```\n' + fitForUrl(lastReport) + '\n```';
    window.open(`${ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`, '_blank', 'noopener');
  };

  // 有警告或錯誤時，🐞 按鈕亮紅點
  function updateBadges() {
    const n = Report.alertCount;
    document.querySelectorAll('.report-btn .badge').forEach(b => {
      b.hidden = n === 0;
      b.textContent = n > 99 ? '99+' : n;
    });
  }
  Report.onChange(updateBadges);

  // ================= 其他 =================
  let toastT;
  function toast(msg) {
    Report.log('ui', '提示：' + msg, 'info');
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.hidden = true), 3500);
  }

  window.addEventListener('resize', () => {
    if (prompter.hidden) return;
    relayout();
    y = topOf(cursor) - anchorPx();
  });

  document.addEventListener('visibilitychange', async () => {
    Report.log('env', document.hidden ? '分頁切到背景' : '分頁回到前景');
    if (document.hidden || prompter.hidden) return;
    // 切回分頁：瀏覽器在背景時會中斷辨識，換一條新連線
    if (listening) recycle('切回分頁');
    // 螢幕常亮鎖也會被系統釋放，重新取得
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  });

  // 初始化
  ta.value = S.script;
  if (!SR) $('#srWarn').hidden = false;
  syncInputs();
  syncSeg();
  updateStats();
  updateBadges();
  Report.log('env', `程式版本 ${APP_VERSION} 啟動，辨識語言 ${recogLang()}`);
  requestAnimationFrame(frame);
})();
