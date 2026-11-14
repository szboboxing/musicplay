
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  var tvPauseFn = null;                     // 网络电视暂停钩子（播放其它模块时调用）
  function toggleFold(w) {                  // 分组折叠（电台 / 电视共用）
    if (!w) return;
    var closed = w.classList.toggle('closed');
    var h = w.querySelector('h3');
    if (h) h.setAttribute('aria-expanded', closed ? 'false' : 'true');
  }

  /* ---------- 主题（自动 / 明亮 / 昏暗，记忆） ---------- */
  var THEME_KEY = 'gy_theme';
  var themeMode = (function () { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { return 'auto'; } })();
  function resolvedTheme(m) {
    if (m === 'auto') return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    return m;
  }
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', resolvedTheme(themeMode));
    var b = $('themeBtn');
    if (b) b.textContent = themeMode === 'auto' ? '自动' : (themeMode === 'dark' ? '昏暗' : '明亮');
  }
  $('themeBtn').addEventListener('click', function () {
    themeMode = themeMode === 'auto' ? 'light' : (themeMode === 'light' ? 'dark' : 'auto');
    try { localStorage.setItem(THEME_KEY, themeMode); } catch (e) {}
    applyTheme();
  });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onMq = function () { if (themeMode === 'auto') applyTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
  }
  applyTheme();

  /* ---------- 阅读进度条 / 回到顶部 ---------- */
  window.addEventListener('scroll', function () {
    var st = document.documentElement.scrollTop || document.body.scrollTop;
    var h = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    var p = $('progress'); if (p) p.style.width = (h > 0 ? (st / h * 100) : 0) + '%';
    var bt = $('backtop'); if (bt) bt.classList.toggle('show', st > 400);
  }, { passive: true });
  $('backtop').addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

  /* ---------- 云端媒体中心：音频 / 视频播放（缓冲预读 · 进度 · 歌单 · 循环 · 示波图 · 音量） ---------- */
  var FALLBACK_TRACKS = [
    { src: 'assets/music/campfire.mp3', name: 'The Campfire', duration: 464, createdAt: 0 },
    { src: 'assets/music/xiangye.mp3', name: '乡野低频', duration: 181, createdAt: 0 }
  ];
  var TRACKS = FALLBACK_TRACKS.slice();
  var trackIdx = 0, curSrc = '';
  var MODE_KEY = 'mp_mus_mode', VOL_KEY = 'mp_mus_vol';
  var playMode = (function () { try { return localStorage.getItem(MODE_KEY) === 'one' ? 'one' : 'seq'; } catch (e) { return 'seq'; } })();
  var savedVol = (function () {
    var v = 60;
    try { var s = localStorage.getItem(VOL_KEY); if (s != null && isFinite(+s)) v = +s; } catch (e) {}
    return Math.max(0, Math.min(100, v));
  })();
  var lastLoudVol = savedVol > 0 ? savedVol : 60;

  var audio = new Audio();
  audio.preload = 'auto';
  audio.loop = false;
  audio.volume = savedVol / 100;

  var video = $('musVideo');
  var warm = new Audio();              // 静默预取下一首，切歌更快
  warm.preload = 'auto';
  warm.muted = true;
  var warmSrc = '';

  var player = audio;                  // 当前正在使用的媒体元素（音频 / 视频）
  var currentVideo = false, buffering = false;

  var card = $('mediaCard'), musPlay = $('musPlay'), musNow = $('musNow');
  var musSeek = $('musSeek'), musTime = $('musTime'), musDur = $('musDur');
  var musMode = $('musMode'), musList = $('musList'), musCount = $('musCount');
  var musVol = $('musVol'), musVolTxt = $('musVolTxt'), musMute = $('musMute');
  var musBufBar = $('musBufBar'), musPlayedBar = $('musPlayedBar');
  var musPager = $('musPager'), musPageInfo = $('musPageInfo');
  var musPrevPage = $('musPrevPage'), musNextPage = $('musNextPage');
  var PAGE_SIZE = 8, listPage = 0;     // 歌单按上传时间倒序，每页 8 条
  var seeking = false, seekTimer = 0, pendingSeek = null;

  function fmtTime(s) {
    s = Math.floor(Number(s) || 0);
    if (s < 0) s = 0;
    var m = Math.floor(s / 60), ss = s % 60;
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  }
  function isPlaying() { return !player.paused && !player.ended; }
  function newestIndex() {
    var best = -1, bestAt = 0;
    for (var i = 0; i < TRACKS.length; i++) {
      var at = Number(TRACKS[i].createdAt) || 0;
      if (at > bestAt) { bestAt = at; best = i; }
    }
    return best >= 0 ? best : Math.max(0, TRACKS.length - 1);
  }
  function findSrc(src) {
    for (var i = 0; i < TRACKS.length; i++) { if (TRACKS[i].src === src) return i; }
    return -1;
  }
  function sortTracks() {              // 上传时间倒序：最新的排最前（时间相同保持原有顺序）
    TRACKS.sort(function (a, b) { return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0); });
  }
  function pageOfTrack(idx) { return Math.floor(idx / PAGE_SIZE); }
  function trackName() {
    var t = TRACKS[trackIdx];
    return (t && (t.name || '媒体')) || '媒体';
  }
  function bufferedAhead(el) {
    try {
      var b = el.buffered, t = el.currentTime;
      for (var i = 0; i < b.length; i++) { if (t >= b.start(i) && t <= b.end(i)) return b.end(i) - t; }
    } catch (e) {}
    return 0;
  }

  function renderList() {
    if (!musList) return;
    var total = TRACKS.length;
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (listPage > pages - 1) listPage = pages - 1;
    if (listPage < 0) listPage = 0;
    var start = listPage * PAGE_SIZE;
    musList.innerHTML = '';
    musCount.textContent = total ? (total + ' 首') : '无';
    var newest = newestIndex();
    TRACKS.slice(start, start + PAGE_SIZE).forEach(function (t, k) {
      var i = start + k;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mus-item' + (i === trackIdx ? ' on' : '');
      b.setAttribute('data-i', String(i));
      var isNew = Number(t.createdAt) > 0 && i === newest;
      b.innerHTML =
        '<span class="idx">' + (i === trackIdx && isPlaying() ? '♪' : (i + 1)) + '</span>' +
        '<span class="nm">' + escapeHtml(t.name || '媒体') + '</span>' +
        (isNew ? '<span class="tag">新</span>' : '') +
        (t.video ? '<span class="tag">视频</span>' : '') +
        (t.local ? '<span class="tag">本机</span>' : '') +
        '<span class="dur">' + (t.duration ? fmtTime(t.duration) : '') + '</span>';
      b.addEventListener('click', function () { loadTrack(i, true); });
      musList.appendChild(b);
    });
    if (musPageInfo) musPageInfo.textContent = (listPage + 1) + ' / ' + pages;
    if (musPrevPage) musPrevPage.disabled = listPage <= 0;
    if (musNextPage) musNextPage.disabled = listPage >= pages - 1;
    if (musPager) musPager.hidden = total === 0;
  }
  function updateListState() {
    if (!musList) return;
    var items = musList.querySelectorAll('.mus-item');
    for (var k = 0; k < items.length; k++) {
      var el = items[k], i = Number(el.getAttribute('data-i'));
      el.classList.toggle('on', i === trackIdx);
      var idx = el.querySelector('.idx');
      if (idx) idx.textContent = (i === trackIdx && isPlaying()) ? '♪' : (i + 1);
    }
  }

  function setBuffering(on) {
    buffering = !!on;
    card.classList.toggle('buffering', buffering);
    if (buffering) {
      musNow.textContent = '缓冲中… · ' + trackName();
    } else {
      setPlayUI();
    }
  }

  function setPlayUI() {
    var playing = isPlaying();
    card.classList.toggle('playing', playing);
    musPlay.textContent = playing ? '❚❚' : (buffering ? '…' : '▶');
    audio.loop = playMode === 'one';
    if (video) video.loop = playMode === 'one';
    musMode.textContent = playMode === 'one' ? '单曲循环' : '顺序播放';
    musMode.classList.toggle('on', playMode === 'one');
    if (!buffering) {
      var t = TRACKS[trackIdx];
      musNow.textContent = t
        ? ((playing ? (currentVideo ? '视频播放 · ' : '正在播放 · ') : '') + (t.name || '媒体'))
        : '未播放';
    }
    updateListState();
  }

  function paintBars(played, buffered) {
    if (musPlayedBar) musPlayedBar.style.width = (Math.max(0, Math.min(1, played)) * 100).toFixed(2) + '%';
    if (musBufBar) musBufBar.style.width = (Math.max(0, Math.min(1, buffered)) * 100).toFixed(2) + '%';
  }
  function bufferedRatio() {
    var d = player.duration;
    if (!isFinite(d) || d <= 0) return 0;
    try {
      var b = player.buffered, t = player.currentTime, end = t;
      for (var i = 0; i < b.length; i++) { if (t >= b.start(i) && t <= b.end(i)) end = b.end(i); }
      return Math.min(1, end / d);
    } catch (e) { return 0; }
  }
  function updateProgress() {
    var d = player.duration;
    if (!isFinite(d) || d <= 0) d = (TRACKS[trackIdx] && TRACKS[trackIdx].duration) || 0;
    musDur.textContent = fmtTime(d);
    if (seeking) { paintBars(Number(musSeek.value) / 1000, bufferedRatio()); return; }
    var c = player.currentTime || 0;
    musTime.textContent = fmtTime(c);
    musSeek.value = d ? Math.round((c / d) * 1000) : 0;
    paintBars(d ? c / d : 0, bufferedRatio());
  }

  function loadTrack(i, autoplay) {
    if (!TRACKS.length) return;
    radioPause();                              // 电台与媒体中心互斥，一次只响一路
    chartPause();                              // 榜单与媒体中心互斥，一次只响一路
    if (tvPauseFn) tvPauseFn();                // 电视与媒体中心互斥
    trackIdx = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
    var t = TRACKS[trackIdx];
    var el = (t.video && video) ? video : audio;
    if (el !== player) {                        // 音频 / 视频切换时停掉另一个
      try { player.pause(); } catch (e) {}
      var old = player;
      player = el;
      try { old.removeAttribute('src'); old.load(); } catch (e) {}
    }
    currentVideo = !!t.video && !!video;
    if (video) video.hidden = !currentVideo;
    card.classList.toggle('has-video', currentVideo);
    curSrc = t.src;
    // 云端直出（R2 自定义域名）时媒体在别的域名：音频做示波图必须走 CORS，
    // crossOrigin 要在设置 src 之前决定；同源 / 本机 blob 则清掉，避免多余的限制
    var cross = false;
    try { cross = !!t.src && new URL(t.src, location.href).origin !== location.origin; } catch (e) {}
    if (!currentVideo) {
      if (cross) { if (player.crossOrigin !== 'anonymous') player.crossOrigin = 'anonymous'; }
      else if (player.hasAttribute('crossOrigin')) player.removeAttribute('crossOrigin');
    }
    player.src = t.src;
    pendingSeek = null;
    setBufferingPlayer(false);
    musTime.textContent = '0:00';
    musDur.textContent = t.duration ? fmtTime(t.duration) : '0:00';
    musSeek.value = 0;
    paintBars(0, 0);
    setPlayUI();
    if (pageOfTrack(trackIdx) !== listPage) { listPage = pageOfTrack(trackIdx); renderList(); }
    if (!currentVideo) { sizeWave(); startWave(); }
    if (autoplay) startPlay();
  }
  function setBufferingPlayer(on) { buffering = !!on; card.classList.toggle('buffering', buffering); }
  function doPlay() {
    var p = player.play();
    if (p && p.catch) p.catch(function () {
      if (player.ended) return;
      setBufferingPlayer(false);
      musNow.textContent = '播放失败，请再点一次';
      setPlayUI();
    });
  }
  function startPlay() {             // 先垫 3 秒缓冲再播，避免开头卡顿（最多等 5 秒）
    if (!player.src) return;
    radioPause();
    chartPause();
    if (!currentVideo) ensureGraph();
    if (!currentVideo) warmNext();
    if (bufferedAhead(player) >= 3 || player.readyState >= 4) { doPlay(); return; }
    setBuffering(true);
    var started = false, waited = 0;
    var tick = setInterval(function () {
      waited += 200;
      if (bufferedAhead(player) >= 3 || player.readyState >= 4 || waited >= 5000) {
        if (started) return;
        started = true;
        clearInterval(tick);
        setBuffering(false);
        doPlay();
      }
    }, 200);
  }
  function warmNext() {              // 预取下一首（仅云端曲目，不预取本机 blob）
    var nt = TRACKS[trackIdx + 1] || (TRACKS.length > 1 ? TRACKS[0] : null);
    if (!nt || nt.local || nt.video || nt.src === curSrc) return;
    if (warmSrc === nt.src) return;
    warmSrc = nt.src;
    try {
      // 与正式播放同一 CORS 模式，才能命中同一份缓存
      var wcross = false;
      try { wcross = new URL(nt.src, location.href).origin !== location.origin; } catch (e) {}
      if (wcross) warm.crossOrigin = 'anonymous';
      else if (warm.hasAttribute('crossOrigin')) warm.removeAttribute('crossOrigin');
      warm.src = nt.src;
    } catch (e) {}
  }

  /* 音量（音频、视频与榜单同步） */
  function applyVol(v, save) {
    v = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    savedVol = v;
    if (v > 0) lastLoudVol = v;
    audio.volume = v / 100;
    if (video) { try { video.volume = v / 100; } catch (e) {} }
    if (chartAudio) { try { chartAudio.volume = v / 100; } catch (e) {} }
    if (radioAudio) { try { radioAudio.volume = v / 100; } catch (e) {} }
    musVol.value = v;
    musVolTxt.textContent = v + '%';
    musMute.textContent = v === 0 ? '🔇' : (v < 40 ? '🔉' : '🔊');
    if (radioVol) radioVol.value = v;
    if (radioVolTxt) radioVolTxt.textContent = v + '%';
    if (radioMute) radioMute.textContent = v === 0 ? '🔇' : (v < 40 ? '🔉' : '🔊');
    if (save) { try { localStorage.setItem(VOL_KEY, String(v)); } catch (e) {} }
  }
  applyVol(savedVol, false);
  musVol.addEventListener('input', function () { applyVol(musVol.value, true); });
  musMute.addEventListener('click', function () {
    if (savedVol > 0) applyVol(0, true); else applyVol(lastLoudVol, true);
  });

  /* 进度条 */
  musSeek.addEventListener('input', function () {
    var d = player.duration;
    if (!isFinite(d) || d <= 0) d = (TRACKS[trackIdx] && TRACKS[trackIdx].duration) || 0;
    if (!d) return;
    var to = (Number(musSeek.value) / 1000) * d;
    seeking = true;
    if (player.readyState >= 1) { try { player.currentTime = to; } catch (e) { pendingSeek = to; } }
    else pendingSeek = to;               // 元数据未就绪，等 loadedmetadata 再定位
    musTime.textContent = fmtTime(to);
    paintBars(to / d, bufferedRatio());
    clearTimeout(seekTimer);
    seekTimer = setTimeout(function () { seeking = false; updateProgress(); }, 500);
  });

  /* 播放控件 */
  musPlay.addEventListener('click', function () {
    if (!player.src) { if (TRACKS.length) loadTrack(trackIdx, true); return; }
    if (isPlaying()) player.pause(); else startPlay();
  });
  $('musPrev').addEventListener('click', function () {
    if (!TRACKS.length) return;
    loadTrack(player.src && player.currentTime > 3 ? trackIdx : trackIdx - 1, true);
  });
  $('musNext').addEventListener('click', function () { loadTrack(trackIdx + 1, true); });
  if (musPrevPage) musPrevPage.addEventListener('click', function () { listPage--; renderList(); });
  if (musNextPage) musNextPage.addEventListener('click', function () { listPage++; renderList(); });
  musMode.addEventListener('click', function () {
    playMode = playMode === 'one' ? 'seq' : 'one';
    try { localStorage.setItem(MODE_KEY, playMode); } catch (e) {}
    setPlayUI();
    toast(playMode === 'one' ? '已切换：单曲循环' : '已切换：顺序播放');
  });
  if (video) video.addEventListener('click', function () {
    if (isPlaying()) player.pause(); else startPlay();
  });

  /* 媒体事件（音频与视频共用） */
  function bindMedia(el) {
    if (!el) return;
    el.addEventListener('play', function () { if (el === player) { setBuffering(false); setPlayUI(); } });
    el.addEventListener('pause', function () { if (el === player) { setBufferingPlayer(false); setPlayUI(); } });
    el.addEventListener('playing', function () { if (el === player) { setBuffering(false); setPlayUI(); } });
    el.addEventListener('waiting', function () { if (el === player && !el.paused) setBuffering(true); });
    el.addEventListener('timeupdate', function () { if (el === player) updateProgress(); });
    el.addEventListener('durationchange', function () { if (el === player) updateProgress(); });
    el.addEventListener('progress', function () { if (el === player) paintBars(Number(musSeek.value) / 1000, bufferedRatio()); });
    el.addEventListener('loadedmetadata', function () {
      if (el !== player) return;
      var t = TRACKS[trackIdx];
      if (t && t.local && isFinite(el.duration)) { t.duration = el.duration; renderList(); }
      if (pendingSeek != null) { try { el.currentTime = pendingSeek; } catch (e) {} pendingSeek = null; }
      updateProgress();
    });
    el.addEventListener('ended', function () {
      if (el !== player) return;
      if (playMode === 'one') { el.currentTime = 0; doPlay(); return; }
      loadTrack(trackIdx + 1, true);
    });
    el.addEventListener('error', function () {
      if (el !== player || !curSrc) return;
      setBufferingPlayer(false);
      musNow.textContent = currentVideo ? '视频无法播放（格式不支持）' : '媒体加载失败，换一个试试';
      setPlayUI();
    });
  }
  bindMedia(audio);
  bindMedia(video);

  /* 本机上传（音频或视频，仅本机试听，不占云端空间） */
  $('musUpload').addEventListener('click', function () { $('musInput').click(); });
  $('musInput').addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    var added = files.map(function (f, k) {
      var isVideo = /^video\//i.test(f.type) || /\.(mp4|m4v|webm|mov|ogv|mkv|avi)$/i.test(f.name);
      return { src: URL.createObjectURL(f), name: f.name, duration: 0, createdAt: Date.now() + k, local: true, video: isVideo };
    });
    TRACKS = TRACKS.concat(added);
    sortTracks();                       // 本机新加的也按时间排到最前
    var at = findSrc(added[0].src);
    if (at < 0) at = 0;
    listPage = Math.max(0, pageOfTrack(at));
    renderList();
    loadTrack(at, true);
    var hasVideo = added.some(function (t) { return t.video; });
    toast(hasVideo ? '已加入本机视频 · 大窗播放' : (files.length > 1 ? ('已加入 ' + files.length + ' 首本机音乐') : ('已播放：' + files[0].name)));
  });

  /* 示波图（Web Audio 实时波形；无 AudioContext 时用静态波形代替） */
  var waveCanvas = $('musWave');
  var wave2d = waveCanvas ? waveCanvas.getContext('2d') : null;
  var audioCtx = null, analyser = null, waveData = null;
  var waveRunning = false, waveCol = { main: '#17A398' }, waveColAt = 0;

  function ensureGraph() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended' && audioCtx.resume) { try { audioCtx.resume(); } catch (e) {} }
      return;
    }
    // 跨域音频如果没有 CORS 标记，接上分析器会让它变静音：这里直接跳过，示波图回落静态中线
    var cross = false;
    try { cross = !!audio.src && new URL(audio.src, location.href).origin !== location.origin; } catch (e) {}
    if (cross && audio.crossOrigin !== 'anonymous') return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      audioCtx = new AC();
      var node = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;
      node.connect(analyser);
      analyser.connect(audioCtx.destination);
      waveData = new Uint8Array(analyser.fftSize);
    } catch (e) { audioCtx = null; analyser = null; }
  }
  function sizeWave() {
    if (!waveCanvas) return;
    var r = waveCanvas.getBoundingClientRect();
    if (!r.width) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    waveCanvas.width = Math.round(r.width * dpr);
    waveCanvas.height = Math.round(r.height * dpr);
  }
  function refreshWaveCol(now) {
    if (now - waveColAt < 900) return;
    waveColAt = now;
    try {
      var cs = getComputedStyle(document.documentElement);
      var c = cs.getPropertyValue('--accent-2').trim();
      if (c) waveCol.main = c;
    } catch (e) {}
  }
  function drawWave(now) {
    if (!wave2d || currentVideo) return;    // 视频用大窗播放，不画画布
    if (!waveCanvas.width) sizeWave();
    var w = waveCanvas.width, h = waveCanvas.height;
    if (!w || !h) return;
    refreshWaveCol(now || 0);
    wave2d.clearRect(0, 0, w, h);

    var mid = h / 2, i, x, y, v;
    wave2d.lineWidth = Math.max(1.5, h / 34);
    wave2d.strokeStyle = waveCol.main;
    wave2d.beginPath();

    if (analyser && isPlaying()) {
      analyser.getByteTimeDomainData(waveData);
      var n = waveData.length;
      for (x = 0; x < w; x++) {
        i = Math.floor((x / (w - 1)) * (n - 1));
        v = (waveData[i] - 128) / 128;
        y = mid - v * (h * 0.44);
        if (x === 0) wave2d.moveTo(x, y); else wave2d.lineTo(x, y);
      }
    } else {   // 暂停/不支持时画一条静态波形，不做无谓动画
      var amp = h * 0.13, phase = 0;
      for (x = 0; x < w; x++) {
        y = mid - Math.sin((x / w) * Math.PI * 5 + phase) * amp;
        if (x === 0) wave2d.moveTo(x, y); else wave2d.lineTo(x, y);
      }
    }
    wave2d.stroke();

    wave2d.globalAlpha = 0.35;
    wave2d.beginPath();
    wave2d.moveTo(0, mid); wave2d.lineTo(w, mid);
    wave2d.stroke();
    wave2d.globalAlpha = 1;
  }
  function startWave() {
    if (waveRunning || !wave2d) return;
    waveRunning = true;
    var loop = function (ts) {
      if (document.hidden) { waveRunning = false; return; }
      drawWave(ts);
      // 播放中逐帧刷新；暂停时降到约 2.5 帧/秒，手机不空转
      if (isPlaying()) { requestAnimationFrame(loop); }
      else { setTimeout(function () { requestAnimationFrame(loop); }, 400); }
    };
    requestAnimationFrame(loop);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) startWave(); });
  window.addEventListener('resize', function () { sizeWave(); });

  renderList();
  setPlayUI();
  updateProgress();
  sizeWave();
  startWave();

  /* 曲库从后台同步（云端媒体中心可增删/排序/停用音频与视频）；默认选中最近上传的一个 */
  fetch('/api/music', { cache: 'no-store' }).then(function (r) {
    return r.ok ? r.json() : null;
  }).then(function (list) {
    if (!Array.isArray(list) || !list.length) return;
    var remote = list.filter(function (t) { return t.src; }).map(function (t) {
      var tp = String(t.type || '').toLowerCase();
      return {
        src: t.src,
        name: t.name || '媒体',
        duration: Number(t.duration) || 0,
        createdAt: Number(t.createdAt) || 0,
        video: !!t.video || /^video\//.test(tp)
      };
    });
    if (!remote.length) return;
    var locals = TRACKS.filter(function (t) { return t.local; });
    TRACKS = remote.concat(locals);
    sortTracks();                       // 上传时间倒序：最新在最前
    var keep = curSrc ? findSrc(curSrc) : -1;
    trackIdx = keep >= 0 ? keep : newestIndex();
    listPage = Math.max(0, pageOfTrack(trackIdx));
    renderList();
    setPlayUI();
    updateProgress();
  }).catch(function () {});

  /* ---------- 热播榜单：抓网络最新热播歌（华语 / 飙升 / 原创 / AI），点歌名在线播放 ---------- */
  var CHART_KEY = 'mp_chart_board';
  var chartAudio = new Audio();
  chartAudio.preload = 'auto';
  chartAudio.crossOrigin = 'anonymous';   // 取实时频谱需要 CORS
  var chartTabs = $('chartTabs'), chartList = $('chartList'), chartSub = $('chartSub');
  var chartNow = $('chartNow'), chartNowName = $('chartNowName'), chartPlay = $('chartPlay');
  var chartPrev = $('chartPrev'), chartNext = $('chartNext'), chartMode = $('chartMode');
  var chartWave = $('chartWave');
  var chartSeek = $('chartSeek'), chartTime = $('chartTime'), chartDur = $('chartDur'), chartPlayed = $('chartPlayed');
  var chartsData = null;
  var chartBoard = (function () { try { return localStorage.getItem(CHART_KEY) || 'cn'; } catch (e) { return 'cn'; } })();
  var chartIdx = -1, chartSeeking = false, chartSeekTimer = 0, chartLoadToken = 0;
  var chartLoop = (function () { try { return localStorage.getItem('mp_chart_loop') === '1'; } catch (e) { return false; } })();
  var chartWaveCtx = chartWave ? chartWave.getContext('2d') : null;
  var chartWaveW = 0, chartWaveH = 0, chartWavePhase = 0, chartWaveRaf = 0, chartWaveColors = null;
  var chartWaveBars = 0, chartWaveLv = [], chartWavePk = [], chartWaveRaw = [], chartWaveGain = 0;
  var chartActx = null, chartAnalyser = null, chartBins = null, chartAnalyserFailed = false;

  function chartPlaying() { return !!chartAudio && !chartAudio.paused && !chartAudio.ended; }
  function chartItems() {
    var b = (chartsData && chartsData.boards) ? chartsData.boards[chartBoard] : null;
    return (b && b.items) || [];
  }
  function chartLabel(i) {
    var t = chartItems()[i];
    if (!t) return '—';
    return t.title + (t.artist ? ' · ' + t.artist : '');
  }
  function chartUpdateUI() {
    var playing = chartPlaying();
    if (chartPlay) chartPlay.textContent = playing ? '❚❚' : '▶';
    if (chartNowName && chartIdx >= 0) {
      chartNowName.textContent = chartLabel(chartIdx);
      chartNowName.setAttribute('title', chartLabel(chartIdx));
    }
    if (!chartList) return;
    var rows = chartList.querySelectorAll('.chart-item');
    for (var k = 0; k < rows.length; k++) {
      var el = rows[k], i = Number(el.getAttribute('data-i'));
      el.classList.toggle('on', i === chartIdx);
      var no = el.querySelector('.no');
      if (no) no.textContent = (i === chartIdx && playing) ? '♪' : (i + 1);
    }
  }
  function chartPaint() {
    var t = chartItems()[chartIdx] || {};
    var d = chartAudio.duration;
    if (!isFinite(d) || d <= 0) d = Number(t.duration) || 0;
    if (chartSeeking) {
      if (chartPlayed && d) chartPlayed.style.width = (Math.max(0, Math.min(1, Number(chartSeek.value) / 1000)) * 100).toFixed(2) + '%';
      return;
    }
    var c = chartAudio.currentTime || 0;
    if (chartTime) chartTime.textContent = fmtTime(c);
    if (chartDur) chartDur.textContent = fmtTime(d);
    if (chartSeek) chartSeek.value = d ? Math.round((c / d) * 1000) : 0;
    if (chartPlayed) chartPlayed.style.width = (d ? Math.max(0, Math.min(1, c / d)) : 0) * 100 + '%';
  }
  function chartPause() {          // 媒体中心开始播放时，先停掉榜单，避免两路声音叠在一起
    if (chartAudio && !chartAudio.paused) { try { chartAudio.pause(); } catch (e) {} }
    chartWaveStop();
    chartUpdateUI();
  }

  /* ---------- 频谱波形图（Web Audio 实时分析；取不到频谱时用模拟律动兜底） ---------- */
  function chartWavePalette() {
    var cs = getComputedStyle(document.documentElement);
    return {
      a: (cs.getPropertyValue('--accent') || '#D2703F').trim(),
      b: (cs.getPropertyValue('--accent-2') || '#17A398').trim()
    };
  }
  function chartAudioReady() {
    if (chartActx) {
      if (chartActx.state === 'suspended') { try { chartActx.resume(); } catch (e) {} }
      return true;
    }
    if (chartAnalyserFailed) return false;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { chartAnalyserFailed = true; return false; }
    try { chartActx = new AC(); return true; }
    catch (e) { chartAnalyserFailed = true; return false; }
  }
  function chartAudioInit() {
    if (chartAnalyser) return true;
    if (chartAnalyserFailed || !chartActx) return false;
    try {
      var src = chartActx.createMediaElementSource(chartAudio);
      chartAnalyser = chartActx.createAnalyser();
      chartAnalyser.fftSize = 512;
      chartAnalyser.smoothingTimeConstant = 0.55;
      chartAnalyser.minDecibels = -88;
      chartAnalyser.maxDecibels = -18;
      src.connect(chartAnalyser);
      chartAnalyser.connect(chartActx.destination);
      chartBins = new Uint8Array(chartAnalyser.frequencyBinCount);
      return true;
    } catch (e) {
      chartAnalyser = null;
      chartAnalyserFailed = true;
      return false;
    }
  }
  function chartWaveLayout() {
    var n = Math.max(24, Math.min(64, Math.floor((chartWaveW || 320) / 8)));
    if (n === chartWaveBars) return;
    chartWaveBars = n;
    chartWaveLv = [];
    chartWavePk = [];
    chartWaveRaw = [];
    for (var i = 0; i < n; i++) { chartWaveLv[i] = 0; chartWavePk[i] = 0; chartWaveRaw[i] = 0; }
  }
  function chartWaveResize() {
    if (!chartWave || !chartWaveCtx) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.round(chartWave.clientWidth || 0);
    var h = Math.round(chartWave.clientHeight || 0);
    if (!w || !h) { w = chartWaveW || 320; h = chartWaveH || 58; }
    if (w === chartWaveW && h === chartWaveH) { chartWavePaint(); return; }
    chartWaveW = w;
    chartWaveH = h;
    chartWave.width = Math.round(w * dpr);
    chartWave.height = Math.round(h * dpr);
    chartWaveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    chartWaveColors = null;
    chartWaveLayout();
    chartWavePaint();
  }
  function chartWaveBar(x, y, bw, bh, r) {
    var ctx = chartWaveCtx;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, [r, r, 0, 0]);
      ctx.fill();
      return;
    }
    ctx.fillRect(x, y, bw, bh);
  }
  function chartWavePaint() {
    if (!chartWaveCtx || !chartWaveW) return;
    var ctx = chartWaveCtx, w = chartWaveW, h = chartWaveH;
    if (!chartWaveColors) chartWaveColors = chartWavePalette();
    ctx.clearRect(0, 0, w, h);
    if (!chartWaveBars) chartWaveLayout();
    var n = chartWaveBars;
    var gap = w < 380 ? 2 : 3;
    var bw = Math.max(2, (w - gap * (n - 1)) / n);
    var base = h - 3;
    var maxH = h - 13;
    var playing = chartPlaying();

    var rmax = 0, specOk = false, maxBin = 0;
    if (playing && chartAnalyser && chartBins) {
      try {
        chartAnalyser.getByteFrequencyData(chartBins);
        maxBin = Math.min(chartBins.length, 128);
        specOk = true;
        for (var q = 0; q < n; q++) {
          var t0 = Math.pow(q / n, 1.6), t1 = Math.pow((q + 1) / n, 1.6);
          var b0 = Math.floor(t0 * maxBin);
          var b1 = Math.max(b0 + 1, Math.floor(t1 * maxBin + 1));
          var mx = 0;
          for (var b = b0; b < b1 && b < maxBin; b++) { if (chartBins[b] > mx) mx = chartBins[b]; }
          var val = mx / 255;
          val = Math.pow(val, 0.62) * (0.8 + 1.2 * Math.pow(q / n, 1.1));
          chartWaveRaw[q] = val;
          if (val > rmax) rmax = val;
        }
      } catch (e) { specOk = false; }
    }
    if (specOk) {
      chartWaveGain = chartWaveGain > 0 ? Math.max(rmax, chartWaveGain * 0.93) : rmax;
    } else {
      chartWaveGain *= 0.9;
    }

    for (var i = 0; i < n; i++) {
      var v;
      if (specOk) {
        v = Math.min(1, (chartWaveRaw[i] / (chartWaveGain || 1)) * 0.9);
      } else if (playing) {
        v = 0.12 + 0.62 * Math.abs(Math.sin(i * 0.62 + chartWavePhase * 2.2) * Math.cos(i * 0.27 - chartWavePhase * 1.5));
        v *= 0.5 + 0.5 * Math.sin(Math.PI * i / (n - 1));
      } else {
        v = 0.05;
      }
      var lv = chartWaveLv[i];
      chartWaveLv[i] = v > lv ? v : lv * 0.8 + v * 0.2;
      var pk = chartWavePk[i] - 0.022;
      chartWavePk[i] = Math.max(chartWaveLv[i], pk > 0 ? pk : 0);
    }

    ctx.globalAlpha = playing ? 0.4 : 0.2;
    ctx.fillStyle = chartWaveColors.a;
    ctx.fillRect(0, base, w, 1);

    var grad = ctx.createLinearGradient(0, base - maxH, 0, base);
    grad.addColorStop(0, chartWaveColors.b);
    grad.addColorStop(1, chartWaveColors.a);
    ctx.fillStyle = grad;
    for (var j = 0; j < n; j++) {
      var lv2 = chartWaveLv[j];
      var bh = Math.max(3, lv2 * maxH);
      ctx.globalAlpha = playing ? 0.45 + 0.55 * lv2 : 0.32;
      chartWaveBar(j * (bw + gap), base - bh, bw, bh, Math.min(bw / 2, 3));
    }

    ctx.fillStyle = chartWaveColors.b;
    for (var k = 0; k < n; k++) {
      var pk2 = chartWavePk[k];
      if (pk2 <= 0.08 || pk2 - chartWaveLv[k] < 0.04) continue;
      ctx.globalAlpha = playing ? 0.55 : 0.25;
      ctx.fillRect(k * (bw + gap), base - Math.max(3, pk2 * maxH) - 4, bw, 2);
    }
    ctx.globalAlpha = 1;
  }
  function chartWaveTick() {
    chartWaveRaf = 0;
    if (!chartPlaying()) { chartWavePaint(); return; }
    chartWavePhase += 0.05;
    chartWavePaint();
    chartWaveRaf = requestAnimationFrame(chartWaveTick);
  }
  function chartWaveStart() {
    if (!chartWaveCtx) return;
    if (!chartWaveW) chartWaveResize();
    if (chartPlaying()) chartAudioReady();
    if (chartWaveRaf) return;
    chartWaveRaf = requestAnimationFrame(chartWaveTick);
  }
  function chartWaveStop() {
    if (chartWaveRaf) { cancelAnimationFrame(chartWaveRaf); chartWaveRaf = 0; }
    chartWavePaint();
  }

  /* ---------- 上一首 / 下一首 / 播放模式（默认顺序播放） ---------- */
  function chartModeUI() {
    if (!chartMode) return;
    chartMode.textContent = chartLoop ? '循环' : '顺序';
    chartMode.setAttribute('title', chartLoop ? '当前：单曲循环，点击改为顺序播放' : '当前：顺序播放，点击改为单曲循环');
    chartMode.classList.toggle('loop', !!chartLoop);
  }
  function chartStep(delta) {
    var items = chartItems();
    if (!items.length) return;
    var n = items.length;
    var from = chartIdx < 0 ? (delta > 0 ? -1 : 0) : chartIdx;
    chartPlayIndex(((from + delta) % n + n) % n);
  }
  function pauseMediaPanel() {
    if (player && !player.paused) { try { player.pause(); } catch (e) {} }
  }
  function chartPlayIndex(i) {
    var t = chartItems()[i];
    if (!t) return;
    chartIdx = i;
    var token = ++chartLoadToken;
    chartAudioReady();                       // 在这里创建 / 恢复 AudioContext（点歌时仍在用户手势内）
    try { chartAudio.pause(); } catch (e) {}
    pauseMediaPanel();                       // 与媒体中心互斥
    radioPause();                            // 与网络电台互斥
    if (tvPauseFn) tvPauseFn();              // 与网络电视互斥
    if (chartNow) chartNow.hidden = false;
    chartWaveResize();
    if (chartNowName) chartNowName.textContent = '正在加载 · ' + chartLabel(i);
    if (chartTime) chartTime.textContent = '0:00';
    if (chartDur) chartDur.textContent = t.duration ? fmtTime(t.duration) : '0:00';
    if (chartSeek) chartSeek.value = 0;
    if (chartPlayed) chartPlayed.style.width = '0%';
    chartUpdateUI();
    chartResolveUrl(t).then(function (url) {
      if (token !== chartLoadToken) return;
      chartAudio.src = url;
      chartAudio.volume = Math.max(0, Math.min(100, savedVol)) / 100;
      if (chartDur) chartDur.textContent = t.duration ? fmtTime(t.duration) : '0:00';
      var p = chartAudio.play();
      if (p && p.catch) p.catch(function () {
        if (token !== chartLoadToken) return;
        if (chartNowName) chartNowName.textContent = '点播放键继续 · ' + chartLabel(chartIdx);
        chartUpdateUI();
      });
    }).catch(function () {
      if (token !== chartLoadToken) return;
      if (chartNowName) chartNowName.textContent = '这首暂时没有试听，换一首试试';
      chartUpdateUI();
    });
  }
  function chartResolveUrl(t) {
    if (t.url) return Promise.resolve(t.url);
    return Promise.reject(new Error('no url'));
  }

  if (chartAudio) {
    chartAudio.addEventListener('play', function () { chartWaveStart(); chartUpdateUI(); });
    chartAudio.addEventListener('pause', function () { chartWaveStop(); chartUpdateUI(); });
    chartAudio.addEventListener('playing', function () {
      if (chartNowName) chartNowName.textContent = chartLabel(chartIdx);
      if (!chartAnalyser && !chartAnalyserFailed && chartAudio.crossOrigin === 'anonymous') chartAudioInit();
      chartWaveStart();
      chartUpdateUI();
    });
    chartAudio.addEventListener('timeupdate', chartPaint);
    chartAudio.addEventListener('durationchange', chartPaint);
    chartAudio.addEventListener('loadedmetadata', chartPaint);
    chartAudio.addEventListener('error', function () {
      if (chartIdx < 0) return;
      if (chartAudio.crossOrigin === 'anonymous' && !chartAnalyser && chartAudio.src) {
        var retrySrc = chartAudio.src;
        chartAudio.crossOrigin = null;
        chartAudio.src = retrySrc;
        var retryPlay = chartAudio.play();
        if (retryPlay && retryPlay.catch) retryPlay.catch(function () {});
        return;
      }
      chartWaveStop();
      if (chartNowName) chartNowName.textContent = '这首暂时播不了，换一首试试';
      chartUpdateUI();
    });
    chartAudio.addEventListener('ended', function () {
      chartWaveStop();
      var items = chartItems();
      if (chartLoop && chartIdx >= 0) {
        try { chartAudio.currentTime = 0; } catch (e) {}
        var lp = chartAudio.play();
        if (lp && lp.catch) lp.catch(function () {});
        chartPaint();
        return;
      }
      if (chartIdx + 1 < items.length) { chartPlayIndex(chartIdx + 1); return; }
      chartPaint();
      chartUpdateUI();
      if (chartNowName) chartNowName.textContent = '本榜单已播完 · ' + chartLabel(chartIdx);
    });
  }
  if (chartPrev) chartPrev.addEventListener('click', function () { chartStep(-1); });
  if (chartNext) chartNext.addEventListener('click', function () { chartStep(1); });
  if (chartMode) chartMode.addEventListener('click', function () {
    chartLoop = !chartLoop;
    try { localStorage.setItem('mp_chart_loop', chartLoop ? '1' : '0'); } catch (e) {}
    chartModeUI();
  });
  window.addEventListener('resize', function () { chartWaveResize(); }, { passive: true });
  chartModeUI();
  if (chartSeek) chartSeek.addEventListener('input', function () {
    var t = chartItems()[chartIdx] || {};
    var d = chartAudio.duration;
    if (!isFinite(d) || d <= 0) d = Number(t.duration) || 0;
    if (!d) return;
    var to = (Number(chartSeek.value) / 1000) * d;
    chartSeeking = true;
    try { chartAudio.currentTime = to; } catch (e) {}
    if (chartTime) chartTime.textContent = fmtTime(to);
    if (chartPlayed) chartPlayed.style.width = ((to / d) * 100).toFixed(2) + '%';
    clearTimeout(chartSeekTimer);
    chartSeekTimer = setTimeout(function () { chartSeeking = false; chartPaint(); }, 400);
  });
  if (chartPlay) chartPlay.addEventListener('click', function () {
    if (chartIdx < 0 || !chartAudio.src) {
      if (chartItems().length) chartPlayIndex(0);
      return;
    }
    if (chartPlaying()) { chartAudio.pause(); return; }
    pauseMediaPanel();
    radioPause();
    chartAudioReady();
    var p = chartAudio.play();
    if (p && p.catch) p.catch(function () {});
  });
  if (chartTabs) chartTabs.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('button[data-board]') : null;
    if (!btn) return;
    var key = btn.getAttribute('data-board');
    if (!key || key === chartBoard) return;
    chartBoard = key;
    try { localStorage.setItem(CHART_KEY, key); } catch (e) {}
    chartIdx = -1; chartSeeking = false;
    try { chartAudio.pause(); } catch (e) {}
    if (chartNow) chartNow.hidden = true;
    chartRender();
  });

  function chartRender() {
    if (!chartList) return;
    var board = (chartsData && chartsData.boards && chartsData.boards[chartBoard]) || {};
    if (chartSub) chartSub.textContent = (board.sub || '网上最新最热的歌') + ' · 点歌名即可在线播放';
    var tabs = chartTabs ? chartTabs.querySelectorAll('button[data-board]') : [];
    for (var k = 0; k < tabs.length; k++) tabs[k].classList.toggle('on', tabs[k].getAttribute('data-board') === chartBoard);
    var items = board.items || [];
    if (!items.length) {
      var msg = (chartsData && chartsData.error) ? '榜单暂时抓取失败，稍后再试'
        : '这个榜单暂时没有数据，稍后再试';
      chartList.innerHTML = '<p class="hint chart-loading">' + escapeHtml(msg) + '</p>';
      chartUpdateUI();
      return;
    }
    chartList.innerHTML = '';
    items.forEach(function (t, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chart-item' + (i === chartIdx ? ' on' : '');
      b.setAttribute('data-i', String(i));
      b.innerHTML =
        '<span class="no">' + (i + 1) + '</span>' +
        (t.cover
          ? '<img class="cov" src="' + escapeHtml(t.cover) + '" alt="" loading="lazy">'
          : '<span class="cov-ph">♪</span>') +
        '<span class="info"><span class="t">' + escapeHtml(t.title || '未命名') + '</span>' +
        '<span class="a">' + escapeHtml(t.artist || '未知作者') + (t.genre ? ' · ' + escapeHtml(t.genre) : '') + '</span></span>' +
        (t.full ? '<span class="cb">完整</span>' : '<span class="cb cb-prev">试听</span>') +
        '<span class="dur">' + (t.duration ? fmtTime(t.duration) : '') + '</span>';
      b.addEventListener('click', function () { chartPlayIndex(i); });
      chartList.appendChild(b);
    });
    var imgs = chartList.querySelectorAll('img.cov');
    for (var m = 0; m < imgs.length; m++) {
      imgs[m].addEventListener('error', function () { this.style.visibility = 'hidden'; });
    }
    chartUpdateUI();
    chartWaveResize();
  }

  /* 榜单数据（服务端抓取 + 缓存） */
  function loadCharts() {
    fetch('/api/charts', { cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return { enabled: true, boards: {}, error: 'HTTP ' + r.status }; });
    }).then(function (data) {
      if (!data || data.enabled === false) {
        chartList.innerHTML = '<p class="hint chart-loading">榜单暂时关闭，稍后再来</p>';
        return;
      }
      chartsData = data;
      if (data.boards && !data.boards[chartBoard]) chartBoard = 'cn';
      chartRender();
    }).catch(function () {
      chartList.innerHTML = '<p class="hint chart-loading">榜单暂时抓取失败，稍后再试</p>';
    });
  }

  /* ---------- 第三部分：网络电台（分组 · 收藏 · 定时关闭 · 断线重连 · 健康灯） ---------- */
  var STATIONS = [
    /* 深圳 */
    { n: '深圳音乐广播 飞扬971', u: 'https://lhttp.qingting.fm/live/1271/64k.mp3', g: '深圳' },
    { n: '深圳新闻广播 FM89.8', u: 'https://lhttp.qingting.fm/live/1270/64k.mp3', g: '深圳' },
    { n: '深圳交通广播 FM106.2', u: 'https://lhttp.qingting.fm/live/1286/64k.mp3', g: '深圳' },
    { n: '深圳私家车广播 FM94.2', u: 'https://lhttp.qingting.fm/live/1273/64k.mp3', g: '深圳' },
    { n: '深圳龙岗星光991', u: 'https://lhttp.qingting.fm/live/20160/64k.mp3', g: '深圳' },
    { n: '深圳交通广播（备用）', u: 'https://lhttp.qingting.fm/live/1272/64k.mp3', g: '深圳' },
    /* 香港：粤语本土电台 */
    { n: '大屿山广播电台', u: 'https://radio.dripfeed.net/listen/radiolantau/radio.mp3', g: '香港' },
    { n: '讲台 Talkonly', u: 'https://live.talkonly.net:8443/talkonly.mp3', g: '香港' },
    { n: 'D100 电台', u: 'https://das-edge93-live365-dal05.cdnstream.com/a91285', g: '香港' },
    { n: '台山电台（粤语）', u: 'https://lhttp.qingting.fm/live/5022062/64k.mp3', g: '香港' },
    { n: '良友电台 同行频道', u: 'https://c23.radioboss.fm/stream/194', g: '香港' },
    { n: '良友电台 友音乐频道', u: 'https://c25.radioboss.fm:8334/stream', g: '香港' },
    /* 广州 */
    { n: '广东音乐之声', u: 'https://lhttp.qingting.fm/live/1260/64k.mp3', g: '广州' },
    { n: '广东珠江经济台', u: 'https://lhttp.qingting.fm/live/1259/64k.mp3', g: '广州' },
    { n: '广东交通之声', u: 'https://lhttp.qingting.fm/live/1262/64k.mp3', g: '广州' },
    { n: '广东新闻广播', u: 'https://lhttp.qingting.fm/live/1254/64k.mp3', g: '广州' },
    { n: '广东城市之声', u: 'https://lhttp.qingting.fm/live/469/64k.mp3', g: '广州' },
    { n: '广东文体广播', u: 'https://lhttp.qingting.fm/live/471/64k.mp3', g: '广州' },
    /* 上海 */
    { n: '上海动感101 FM101.7', u: 'https://lhttp.qingting.fm/live/274/64k.mp3', g: '上海' },
    { n: '经典947 FM94.7', u: 'https://lhttp.qingting.fm/live/267/64k.mp3', g: '上海' },
    { n: '第一财经 FM90.9', u: 'https://lhttp.qingting.fm/live/276/64k.mp3', g: '上海' },
    { n: '上海新闻广播 FM93.4', u: 'https://lhttp.qingting.fm/live/270/64k.mp3', g: '上海' },
    { n: '上海交通广播 FM105.7', u: 'https://lhttp.qingting.fm/live/266/64k.mp3', g: '上海' },
    { n: '上海经典金曲 FM103.7', u: 'https://lhttp.qingting.fm/live/273/64k.mp3', g: '上海' },
    /* 杭州 */
    { n: '浙江之声', u: 'https://lhttp.qingting.fm/live/4518/64k.mp3', g: '杭州' },
    { n: '杭州交通经济广播', u: 'https://lhttp.qingting.fm/live/1133/64k.mp3', g: '杭州' },
    { n: '杭州西湖之声', u: 'https://lhttp.qingting.fm/live/1163/64k.mp3', g: '杭州' },
    { n: '杭州城市资讯广播 FM90.7', u: 'https://lhttp.qingting.fm/live/15318146/64k.mp3', g: '杭州' },
    { n: '杭州华语之声', u: 'https://lhttp.qingting.fm/live/20505/64k.mp3', g: '杭州' },
    { n: '宁波综合广播', u: 'https://lhttp.qingting.fm/live/1138/64k.mp3', g: '杭州' },
    /* 成都 */
    { n: '四川新闻广播 FM106.1', u: 'https://lhttp.qingting.fm/live/4906/64k.mp3', g: '成都' },
    { n: '四川交通广播 FM101.7', u: 'https://lhttp.qingting.fm/live/4886/64k.mp3', g: '成都' },
    { n: '成都年代音乐怀旧好声音', u: 'https://lhttp.qingting.fm/live/20211686/64k.mp3', g: '成都' },
    { n: '年代音乐1022', u: 'https://lhttp.qingting.fm/live/20500066/64k.mp3', g: '成都' },
    { n: '成都电台 FM94.6', u: 'https://lhttp.qingting.fm/live/4892/64k.mp3', g: '成都' },
    { n: '成都交通文艺广播', u: 'https://lhttp.qingting.fm/live/4891/64k.mp3', g: '成都' },
    /* 国际 */
    { n: 'BBC 世界台', u: 'https://stream.live.vc.bbcmedia.co.uk/bbc_world_service', g: '国际' },
    { n: 'HIT FM', u: 'https://lhttp.qingting.fm/live/15318703/64k.mp3', g: '国际' },
    { n: '环球资讯广播', u: 'https://lhttp.qingting.fm/live/20500172/64k.mp3', g: '国际' },
    { n: '澳大利亚 SBS 1台', u: 'https://sbs-ice.streamguys1.com/sbs1-sbs-web', g: '国际' },
    { n: '澳大利亚 SBS 2台', u: 'https://sbs-ice.streamguys1.com/sbs2-sbs-web', g: '国际' },
    { n: '台北 ICRT', u: 'https://n27a-eu.rcs.revma.com/nkdfurztxp3vv', g: '国际' },
    /* 儿童 */
    { n: '苏州儿童广播', u: 'https://lhttp.qingting.fm/live/2807/64k.mp3', g: '儿童' },
    { n: '大连少儿广播 FM106.7', u: 'https://lhttp.qingting.fm/live/1084/64k.mp3', g: '儿童' },
    { n: '江苏故事广播', u: 'https://lhttp.qingting.fm/live/20012/64k.mp3', g: '儿童' },
    { n: '河南少儿广播', u: 'https://lhttp.qingting.fm/live/20500038/64k.mp3', g: '儿童' },
    { n: '黑龙江老年·少儿广播', u: 'https://lhttp.qingting.fm/live/4972/64k.mp3', g: '儿童' },
    { n: '长春少儿与老年生活广播', u: 'https://lhttp.qingting.fm/live/4984/64k.mp3', g: '儿童' },
    /* 其他 */
    { n: '北京音乐广播', u: 'https://lhttp.qingting.fm/live/332/64k.mp3', g: '其他' },
    { n: '北京新闻广播', u: 'https://lhttp.qingting.fm/live/339/64k.mp3', g: '其他' },
    { n: '北京交通广播 FM103.9', u: 'https://lhttp.qingting.fm/live/336/64k.mp3', g: '其他' },
    { n: '清晨音乐台', u: 'https://lhttp.qingting.fm/live/4915/64k.mp3', g: '其他' },
    { n: '江苏新闻广播', u: 'https://lhttp.qingting.fm/live/4944/64k.mp3', g: '其他' },
    { n: 'AsiaFM 亚洲', u: 'https://lhttp.qingting.fm/live/4581/64k.mp3', g: '其他' }
  ];
  var RADIO_GROUP_COLORS = {
    '深圳': '#3E9C76', '香港': '#3FA88F', '广州': '#57B79C', '上海': '#4FA6A0',
    '杭州': '#7FBE74', '成都': '#5FBFA0', '国际': '#6E9E88', '儿童': '#8FC9A8', '其他': '#9AAFA4'
  };
  var RADIO_FALLBACK_COLORS = ['#3E9C76', '#5FBFA0', '#7FBE74', '#4FA6A0', '#6E9E88', '#8FC9A8'];
  var RADIO_FAV_KEY = 'mp_radio_fav', RADIO_HEALTH_KEY = 'mp_radio_health', RADIO_RC_KEY = 'mp_radio_rc';

  var radioAudio = new Audio();
  radioAudio.preload = 'none';
  radioAudio.volume = savedVol / 100;

  var radioCard = document.querySelector('.radio-card');
  var radioName = $('radioName'), radioChipEl = $('radioChip'), radioBuf = $('radioBuf');
  var radioPlayBtn = $('radioPlay'), radioFavBtn = $('radioFav'), radioListEl = $('radioList');
  var radioSearch = $('radioSearch'), radioCheckBtn = $('radioCheck'), radioSleepBox = $('radioSleep');
  var radioSleepLeft = $('radioSleepLeft'), radioReconnectBtn = $('radioReconnect');
  var radioVol = $('radioVol'), radioVolTxt = $('radioVolTxt'), radioMute = $('radioMute');

  var radioCur = -1, radioLive = false;
  var radioRetryN = 0, radioRetryTmr = null, RADIO_MAX_RETRY = 3;
  var radioReconnectOn = (function () { try { return localStorage.getItem(RADIO_RC_KEY) !== '0'; } catch (e) { return true; } })();
  var radioSleepTmr = null, radioSleepEnd = 0, radioSleepMin = 0;
  var radioFavs = [], radioHealth = {}, radioChecking = false;

  (function () {
    try { var a = JSON.parse(localStorage.getItem(RADIO_FAV_KEY) || '[]'); if (Array.isArray(a)) radioFavs = a; } catch (e) {}
    try { var h = JSON.parse(localStorage.getItem(RADIO_HEALTH_KEY) || '{}'); if (h && typeof h === 'object') radioHealth = h; } catch (e) {}
  })();

  function radioSaveFav() { try { localStorage.setItem(RADIO_FAV_KEY, JSON.stringify(radioFavs)); } catch (e) {} }
  function radioSaveHealth() { try { localStorage.setItem(RADIO_HEALTH_KEY, JSON.stringify(radioHealth)); } catch (e) {} }
  function radioIsFav(n) { return radioFavs.indexOf(n) >= 0; }
  function radioChip(text, cls) {
    if (!radioChipEl) return;
    radioChipEl.textContent = text;
    radioChipEl.className = 'rchip' + (cls ? ' ' + cls : '');
  }
  function radioPlayUI() {
    var playing = radioLive && !radioAudio.paused;
    if (radioPlayBtn) radioPlayBtn.textContent = playing ? '❚❚' : '▶';
    if (radioCard) radioCard.classList.toggle('live', playing);
  }
  function radioPause() {                      // 供媒体中心 / 榜单互斥调用
    if (!radioAudio || radioAudio.paused) return;
    try { radioAudio.pause(); } catch (e) {}
    radioLive = false;
    radioChip('已暂停', '');
    radioPlayUI();
  }
  function radioSetCurrent(i) {
    radioCur = i;
    var fav = i >= 0 && radioIsFav(STATIONS[i].n);
    if (radioNameElem()) radioName.textContent = i < 0 ? '未播放' : STATIONS[i].n;
    if (radioFavBtn) {
      radioFavBtn.textContent = fav ? '★' : '☆';
      radioFavBtn.classList.toggle('on', fav);
    }
    if (radioListEl) {
      var btns = radioListEl.querySelectorAll('button[data-i]');
      for (var k = 0; k < btns.length; k++) btns[k].classList.toggle('on', Number(btns[k].getAttribute('data-i')) === i);
    }
    radioPlayUI();
  }
  function radioNameElem() { return radioName; }

  function radioAttach(i, bust) {
    var st = STATIONS[i];
    if (!st) return;
    var url = st.u + (bust ? (st.u.indexOf('?') < 0 ? '?' : '&') + 'r=' + Date.now() : '');
    try { radioAudio.src = url; } catch (e) {}
  }
  function radioPlayErr(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError') { radioChip('点一下播放以出声', 'warn'); }
    else if (n === 'AbortError') { /* 自己切台触发，正常 */ }
    else { radioChip('播放失败', 'err'); radioMarkHealth('err'); radioTryReconnect(); }
  }
  function radioPlay(i) {
    if (i < 0 || i >= STATIONS.length) return;
    chartPause();
    pauseMediaPanel();
    if (tvPauseFn) tvPauseFn();                // 电视与电台互斥
    radioClearRetry();
    radioSetCurrent(i);
    radioOpenGroup(i);
    radioLive = true;
    radioChip('缓冲中…', 'warn');
    radioAttach(i, false);
    radioPlayUI();
    try { localStorage.setItem('mp_radio_last', String(i)); } catch (e) {}
    var p = radioAudio.play();
    if (p && p.catch) p.catch(radioPlayErr);
  }
  function radioToggle() {
    if (radioCur < 0) { radioPlay(0); return; }
    if (!radioLive || radioAudio.paused) { radioPlay(radioCur); return; }
    radioAudio.pause();
    radioChip('已暂停', '');
    radioPlayUI();
  }
  function radioStopAll() {
    radioLive = false;
    radioClearRetry();
    try { radioAudio.pause(); radioAudio.removeAttribute('src'); radioAudio.load(); } catch (e) {}
    radioSleep(0);
    radioSetCurrent(-1);
    radioChip('已停止', '');
  }
  function radioNext() { radioPlay(radioCur < 0 ? 0 : (radioCur + 1) % STATIONS.length); }
  function radioPrev() { radioPlay(radioCur < 0 ? 0 : (radioCur + STATIONS.length - 1) % STATIONS.length); }

  function radioTryReconnect() {
    if (!radioReconnectOn || !radioLive || radioCur < 0) return;
    if (radioRetryN >= RADIO_MAX_RETRY) { radioChip('重连失败，请手动播放', 'err'); return; }
    radioRetryN++;
    radioChip('断线重连中（' + radioRetryN + '/' + RADIO_MAX_RETRY + '）…', 'warn');
    if (radioRetryTmr) clearTimeout(radioRetryTmr);
    radioRetryTmr = setTimeout(function () {
      if (!radioLive || radioCur < 0) return;
      radioAttach(radioCur, true);
      var p = radioAudio.play();
      if (p && p.catch) p.catch(radioPlayErr);
    }, radioRetryN * 3000);
  }
  function radioClearRetry() {
    radioRetryN = 0;
    if (radioRetryTmr) { clearTimeout(radioRetryTmr); radioRetryTmr = null; }
  }
  function radioMarkHealth(v) {
    if (radioCur < 0) return;
    radioHealth[STATIONS[radioCur].n] = v;
    radioSaveHealth();
    radioRender();
  }
  radioAudio.addEventListener('playing', function () {
    if (!radioLive) return;
    radioClearRetry(); radioChip('播放中', 'ok'); radioMarkHealth('ok'); radioPlayUI();
  });
  radioAudio.addEventListener('error', function () {
    if (!radioLive) return;
    radioChip('连接断开', 'err'); radioMarkHealth('err'); radioTryReconnect(); radioPlayUI();
  });
  radioAudio.addEventListener('stalled', function () {
    if (radioLive && !radioAudio.paused) radioChip('缓冲中…', 'warn');
  });
  radioAudio.addEventListener('pause', function () { radioPlayUI(); });

  /* 定时关闭 */
  var RADIO_SLEEP_OPTS = [0, 15, 30, 45, 60];
  function radioSleepUI() {
    if (!radioSleepBox) return;
    radioSleepBox.innerHTML = RADIO_SLEEP_OPTS.map(function (m) {
      return '<button type="button" data-m="' + m + '" class="' + (m === radioSleepMin ? 'on' : '') + '">'
        + (m === 0 ? '关' : m + "'") + '</button>';
    }).join('');
  }
  function radioSleep(m) {
    radioSleepMin = m;
    if (radioSleepTmr) { clearTimeout(radioSleepTmr); radioSleepTmr = null; }
    if (m > 0) {
      radioSleepEnd = Date.now() + m * 60000;
      radioSleepTmr = setTimeout(function () {
        radioStopAll();
        radioChip('定时关闭已到点', 'warn');
        toast('定时关闭已到点，电台已停止');
      }, m * 60000);
    } else {
      radioSleepEnd = 0;
    }
    radioSleepUI();
    radioSleepTick();
  }
  function radioSleepTick() {
    if (!radioSleepLeft) return;
    if (!radioSleepEnd) { radioSleepLeft.hidden = true; return; }
    var s = Math.max(0, Math.round((radioSleepEnd - Date.now()) / 1000));
    radioSleepLeft.hidden = false;
    radioSleepLeft.textContent = '⏱ ' + Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2) + ' 后停止';
  }

  /* 电台列表（按分组渲染，收藏置顶） */
  function radioOpenGroup(i) {              // 播放时自动展开所在分组
    if (!radioListEl) return;
    var b = radioListEl.querySelector('button[data-i="' + i + '"]');
    if (!b) return;
    var w = b.parentNode;
    while (w && w !== radioListEl && !w.classList.contains('rgroup')) w = w.parentNode;
    if (w && w.classList.contains('rgroup') && w.classList.contains('closed')) toggleFold(w);
  }
  function radioRender() {
    if (!radioListEl) return;
    var q = (radioSearch && radioSearch.value || '').trim().toLowerCase();
    var groups = [], gmap = {};
    if (!q && radioFavs.length) {
      groups.push({ name: '★ 我的收藏', color: '#2F8F6B', items: STATIONS.filter(function (s) { return radioIsFav(s.n); }) });
    }
    STATIONS.forEach(function (s) {
      if (q && s.n.toLowerCase().indexOf(q) < 0) return;
      if (!gmap[s.g]) { gmap[s.g] = { name: s.g, items: [] }; groups.push(gmap[s.g]); }
      gmap[s.g].items.push(s);
    });
    var shown = 0, gi = 0;
    radioListEl.innerHTML = '';
    groups.forEach(function (g) {
      if (!g.items.length) return;
      shown += g.items.length;
      var color = g.color || RADIO_GROUP_COLORS[g.name] || RADIO_FALLBACK_COLORS[gi % RADIO_FALLBACK_COLORS.length];
      gi++;
      var w = document.createElement('div');
      w.className = 'rgroup' + (q || g.items.some(function (s) { return STATIONS.indexOf(s) === radioCur; }) ? '' : ' closed');
      w.style.setProperty('--rgc', color);
      var h = document.createElement('h3');
      h.innerHTML = '<span>' + escapeHtml(g.name) + '</span><span class="cnt">' + g.items.length + ' 台</span><i class="car">▾</i>';
      h.setAttribute('role', 'button');
      h.setAttribute('tabindex', '0');
      h.setAttribute('aria-expanded', w.classList.contains('closed') ? 'false' : 'true');
      h.addEventListener('click', function () { toggleFold(w); });
      h.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFold(w); }
      });
      w.appendChild(h);
      var grid = document.createElement('div');
      grid.className = 'rgrid';
      g.items.forEach(function (s) {
        var idx = STATIONS.indexOf(s);
        var lv = radioHealth[s.n];
        var led = lv === 'ok' ? 'h-ok' : (lv === 'err' ? 'h-err' : 'h-new');
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-i', String(idx));
        b.title = s.n;
        b.innerHTML = '<span class="nm">' + escapeHtml(s.n) + '</span>'
          + '<span class="hlrow"><i class="rled ' + led + '"></i><em>' + (radioIsFav(s.n) ? '★' : '') + '</em></span>';
        if (idx === radioCur) b.classList.add('on');
        b.addEventListener('click', function () { radioPlay(idx); });
        grid.appendChild(b);
      });
      w.appendChild(grid);
      radioListEl.appendChild(w);
    });
    if (!shown) radioListEl.innerHTML = '<div class="radio-empty">没有匹配的电台</div>';
    var sub = $('radioSub');
    if (sub) sub.textContent = '实时广播 ' + STATIONS.length + ' 台 · 分组收听，点台名即播';
  }

  /* 可播放性检查（静音探测，不占收听音量；失败重试一次，避免瞬时网络抖动误报） */
  function radioProbe(url, cb) {
    var tries = 0;
    function attempt() {
      var done = false, a = new Audio();
      var fin = function (ok) {
        if (done) return;
        done = true;
        try { a.removeAttribute('src'); a.load(); } catch (e) {}
        if (!ok && tries < 1) { tries++; setTimeout(attempt, 400); return; }
        cb(ok);
      };
      a.muted = true;
      a.preload = 'auto';
      setTimeout(function () { fin(false); }, 6000);
      a.oncanplay = function () { fin(true); };
      a.onerror = function () { fin(false); };
      try { a.src = url; } catch (e) { fin(false); }
    }
    attempt();
  }
  function radioCheckAll() {
    if (radioChecking || !STATIONS.length) return;
    radioChecking = true;
    var total = STATIONS.length, next = 0, doneN = 0;
    var POOL = 6;                              // 并发体检，54 台也能较快跑完
    if (radioCheckBtn) radioCheckBtn.classList.add('busy');
    function finish() {
      radioChecking = false;
      if (radioCheckBtn) { radioCheckBtn.classList.remove('busy'); radioCheckBtn.textContent = '▶ 检查可播'; }
      radioRender();
    }
    function worker() {
      if (next >= total) return;
      var idx = next++;
      radioProbe(STATIONS[idx].u, function (ok) {
        radioHealth[STATIONS[idx].n] = ok ? 'ok' : 'err';
        radioSaveHealth();
        doneN++;
        if (radioCheckBtn) radioCheckBtn.textContent = '检查中 ' + doneN + '/' + total + '…';
        if (doneN % POOL === 0) radioRender();   // 分批刷新，避免 54 台逐条重绘卡顿
        if (doneN >= total) finish(); else worker();
      });
    }
    for (var k = 0; k < POOL && k < total; k++) worker();
  }

  if (radioPlayBtn) radioPlayBtn.addEventListener('click', radioToggle);
  if ($('radioPrev')) $('radioPrev').addEventListener('click', radioPrev);
  if ($('radioNext')) $('radioNext').addEventListener('click', radioNext);
  if ($('radioStop')) $('radioStop').addEventListener('click', radioStopAll);
  if (radioFavBtn) radioFavBtn.addEventListener('click', function () {
    if (radioCur < 0) { toast('先选一台电台'); return; }
    var n = STATIONS[radioCur].n, at = radioFavs.indexOf(n);
    if (at < 0) radioFavs.push(n); else radioFavs.splice(at, 1);
    radioSaveFav();
    radioRender();
    radioSetCurrent(radioCur);
  });
  if (radioSearch) radioSearch.addEventListener('input', radioRender);
  if (radioCheckBtn) radioCheckBtn.addEventListener('click', radioCheckAll);
  if (radioSleepBox) radioSleepBox.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (b) radioSleep(Number(b.getAttribute('data-m')) || 0);
  });
  if (radioReconnectBtn) radioReconnectBtn.addEventListener('click', function () {
    radioReconnectOn = !radioReconnectOn;
    try { localStorage.setItem(RADIO_RC_KEY, radioReconnectOn ? '1' : '0'); } catch (e) {}
    radioReconnectBtn.textContent = radioReconnectOn ? '重连 开' : '重连 关';
    radioReconnectBtn.classList.toggle('on', radioReconnectOn);
    if (!radioReconnectOn) radioClearRetry();
  });
  if (radioVol) radioVol.addEventListener('input', function () { applyVol(radioVol.value, true); });
  if (radioMute) radioMute.addEventListener('click', function () {
    if (savedVol > 0) applyVol(0, true); else applyVol(lastLoudVol, true);
  });

  if (radioReconnectBtn) {
    radioReconnectBtn.textContent = radioReconnectOn ? '重连 开' : '重连 关';
    radioReconnectBtn.classList.toggle('on', radioReconnectOn);
  }
  if (radioVol) radioVol.value = savedVol;
  if (radioVolTxt) radioVolTxt.textContent = savedVol + '%';
  if (radioMute) radioMute.textContent = savedVol === 0 ? '🔇' : (savedVol < 40 ? '🔉' : '🔊');
  radioSleepUI();
  radioRender();
  radioChip('就绪', 'ok');
  setInterval(function () {
    var n = 0;
    try {
      var bd = radioAudio.buffered;
      n = bd.length ? Math.max(0, Math.round((bd.end(bd.length - 1) - radioAudio.currentTime) * 10) / 10) : 0;
    } catch (e) {}
    if (radioBuf) radioBuf.textContent = '本机缓冲 ' + (radioLive ? n + 's' : '—');
    radioPlayUI();
    radioSleepTick();
  }, 2000);
  // 电台体检只在滚动到电台区时自动跑一次：首屏不必为 22 条直播流买单
  (function () {
    var sec = $('sec-radio');
    if (!sec || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          io.disconnect();
          var body = $('radioBody');
          // 栏目折叠时不自动体检，省流量
          if (!document.hidden && !(body && body.classList.contains('folded'))) radioCheckAll();
          return;
        }
      }
    }, { rootMargin: '400px 0px' });
    io.observe(sec);
  })();

  /* ---------- Toast ---------- */
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  window.toast = toast;

  // 榜单放到首屏完全加载后的空闲时段再拉，避免和首屏抢带宽
  function afterFirstPaint(fn) {
    if ('requestIdleCallback' in window) { requestIdleCallback(fn, { timeout: 2500 }); }
    else { setTimeout(fn, 1500); }
  }
  if (document.readyState === 'complete') { afterFirstPaint(loadCharts); }
  else { window.addEventListener('load', function () { afterFirstPaint(loadCharts); }); }

  /* ---------- 界面版本切换：保留两版，选择会记住 ---------- */
  (function () {
    var SKIN_KEY = 'mp_skin';
    var META = {
      v131: { v: 'V1.3.1', d: '暖纸经典' },
      v133: { v: 'V1.3.3', d: '青岚玻璃' }
    };
    var root = document.documentElement;
    var btn = $('verBtn'), modal = $('verModal'), closeBtn = $('verClose');
    var label = $('verLabel'), dateEl = $('verDate'), foot = $('footVer');
    var opts = modal ? Array.prototype.slice.call(modal.querySelectorAll('.ver-opt')) : [];

    function cur() {
      var s = root.getAttribute('data-skin');
      return META[s] ? s : 'v133';
    }
    function paint() {
      var k = cur();
      if (label) label.textContent = META[k].v;
      if (dateEl) dateEl.textContent = '2026-11-09 · ' + META[k].d;
      if (foot) foot.textContent = META[k].v;
      opts.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-skin') === k); });
    }
    function open(on) {
      if (!modal) return;
      modal.classList.toggle('show', on);
      if (btn) btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
    function apply(k) {
      if (!META[k]) k = 'v133';
      root.setAttribute('data-skin', k);
      try { localStorage.setItem(SKIN_KEY, k); } catch (e) {}
      paint();
    }
    if (btn) btn.addEventListener('click', function () { open(!modal.classList.contains('show')); });
    if (closeBtn) closeBtn.addEventListener('click', function () { open(false); });
    if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) open(false); });
    opts.forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-skin');
        apply(k);
        open(false);
        toast('已切换到 ' + META[k].v + ' · ' + META[k].d);
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') open(false);
    });
    paint();
  })();

  /* ---------- 网络电台栏目折叠：状态本地记忆 ---------- */
  (function () {
    var KEY = 'mp_radio_folded';
    var card = $('radioBody'), btn = $('radioFold');
    if (!card || !btn) return;
    function paint(folded) {
      card.classList.toggle('folded', folded);
      btn.textContent = folded ? '展开' : '收起';
      btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
    }
    var folded = false;
    try { folded = localStorage.getItem(KEY) === '1'; } catch (e) {}
    paint(folded);
    btn.addEventListener('click', function () {
      folded = !card.classList.contains('folded');
      paint(folded);
      try { localStorage.setItem(KEY, folded ? '1' : '0'); } catch (e) {}
      if (!folded) {
        var sec = $('sec-radio');
        if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  })();

  /* ---------- 网络电视：HLS 直播（hls.js 首次点播才加载） ---------- */
  /* u = HLS 流地址；p = 走本站 /tv/s 代理（解 http 混合内容 / 防盗链 / 跨域）；r = 代理附带的 Referer
     f = 官方网页直播（无公开 HLS 时用内嵌播放器） */
  (function () {
    var TV = [
      /* 央视 */
      { n: 'CCTV-3 综艺', g: '央视', f: 'https://tv.cctv.com/live/cctv3/' },
      { n: 'CCTV-5 体育', g: '央视', f: 'https://tv.cctv.com/live/cctv5/' },
      { n: 'CCTV-5+ 体育赛事', g: '央视', f: 'https://tv.cctv.com/live/cctv5plus/' },
      { n: 'CCTV-10 科教', g: '央视', u: 'https://cdn4.skygo.mn/live/disk1/CCTV-10/HLSv3-FTA/CCTV-10.m3u8' },
      { n: 'CCTV-13 新闻', g: '央视', f: 'https://tv.cctv.com/live/cctv13/' },
      { n: 'CCTV-16 奥林匹克', g: '央视', u: 'https://168.sryze.cc/163189/cctv16', p: 1 },
      { n: 'CCTV-9 纪录', g: '央视', u: 'https://xykt-fix.github.io/Y77.m3u8' },
      { n: 'CCTV+ 1', g: '央视', u: 'https://cd-live-stream.news.cctvplus.com/live/smil:CHANNEL1.smil/playlist.m3u8' },
      { n: 'CCTV+ 2', g: '央视', u: 'https://cd-live-stream.news.cctvplus.com/live/smil:CHANNEL2.smil/playlist.m3u8' },
      /* 深圳（广电官方网页播放器，媒体 CDN 拒绝云机房 IP，只能内嵌） */
      { n: '深圳卫视', g: '深圳', f: 'https://www.sztv.com.cn/pindao/index.html?liveId=AxeFRth' },
      { n: '深圳都市', g: '深圳', f: 'https://www.sztv.com.cn/pindao/index.html?liveId=ZwxzUXr' },
      { n: '深圳电视剧', g: '深圳', f: 'https://www.sztv.com.cn/pindao/index.html?liveId=4azbkoY' },
      { n: '深圳财经生活', g: '深圳', f: 'https://www.sztv.com.cn/pindao/index.html?liveId=R77mK1v' },
      { n: '深圳少儿', g: '深圳', f: 'https://www.sztv.com.cn/pindao/index.html?liveId=1SIQj6s' },
      { n: '深圳移动电视', g: '深圳', f: 'https://www.sztv.com.cn/pindao/index.html?liveId=wDF6KJ3' },
      /* 香港 */
      { n: '翡翠台', g: '香港', u: 'https://cdn6.cc.cd/163189/fct', p: 1 },
      { n: '明珠台', g: '香港', u: 'https://cdn6.cc.cd/163189/mzt', p: 1 },
      { n: '无线新闻', g: '香港', u: 'https://cdn6.cc.cd/163189/wxxw', p: 1 },
      { n: 'HOY TV', g: '香港', u: 'https://cdn6.cc.cd/163189/hoy', p: 1 },
      { n: '凤凰中文', g: '香港', u: 'https://cdn6.cc.cd/163189/fhzw', p: 1 },
      { n: '凤凰资讯', g: '香港', u: 'https://cdn6.cc.cd/163189/fhzx', p: 1 },
      /* 卫视 */
      { n: '浙江卫视', g: '卫视', u: 'https://ali-m-l.cztv.com/channels/lantian/channel01/1080p.m3u8' },
      { n: '浙江国际', g: '卫视', u: 'https://ali-m-l.cztv.com/channels/lantian/channel10/1080p.m3u8' },
      { n: '安徽卫视', g: '卫视', u: 'https://restream.pdtvhd.com/memfs/c1cd2ed0-3b2b-4c25-af98-a7fb0b1eb130.m3u8' },
      { n: '河北卫视', g: '卫视', u: 'https://event.pull.hebtv.com/live/live101.m3u8' },
      { n: '广州综合', g: '卫视', u: 'https://tencentplaybusiness.gztv.com/live/zonghes.m3u8' },
      /* 城市 */
      { n: '哈尔滨影视', g: '城市', u: 'https://stream.hrbtv.net/yspd/playlist.m3u8' },
      { n: '兰州新闻综合', g: '城市', u: 'https://liveplus.lzr.com.cn/xwzh/HD/live.m3u8' },
      { n: '兰州文旅', g: '城市', u: 'https://liveplus.lzr.com.cn/wlpd/HD/live.m3u8' },
      { n: '宜昌三峡综合', g: '城市', u: 'https://liveplay.ycrmt.cn/sxgd/zhpd.m3u8' },
      { n: '西藏卫视 中文', g: '城市', u: 'https://pili-live-hls-zdzz-tv.zzxwcm.cn/zdzz-tv/nqzh.m3u8' },
      /* 国际 */
      { n: 'TV BRICS 中文', g: '国际', u: 'https://chibrics.mediacdn.ru/cdn/brics/chinese/playlist.m3u8' },
      { n: 'ABN China', g: '国际', u: 'https://mediaserver.abnvideos.com/streams/abnchina.m3u8' }
    ];
    var COLORS = {
      '央视': '#3E9C76', '深圳': '#3B8DBF', '香港': '#B07A3C',
      '卫视': '#3FA88F', '城市': '#4FA6A0', '国际': '#7FBE74'
    };

    var stage = $('tvStage'), video = $('tvVideo'), cover = $('tvCover'), liveEl = $('tvLive');
    var chipEl = $('tvChip'), nameEl = $('tvName'), listEl = $('tvList');
    var playBtn = $('tvPlay'), foldBtn = $('tvFold'), body = $('tvBody'), subEl = $('tvSub');
    if (!video || !listEl) return;

    var cur = -1, hls = null, hlsLoading = false, hlsQ = [], frame = null;

    function px(u, r) {
      return '/tv/s?u=' + encodeURIComponent(u) + (r ? '&r=' + encodeURIComponent(r) : '');
    }
    function stopFrame() {
      if (frame) { try { frame.parentNode.removeChild(frame); } catch (e) {} frame = null; }
    }

    function chip(t, cls) {
      if (!chipEl) return;
      chipEl.textContent = t;
      chipEl.className = 'rchip' + (cls ? ' ' + cls : '');
    }
    function mark() {
      var btns = listEl.querySelectorAll('button[data-i]');
      for (var k = 0; k < btns.length; k++) {
        btns[k].classList.toggle('on', Number(btns[k].getAttribute('data-i')) === cur);
      }
    }
    function paintList() {
      var order = [], map = {};
      TV.forEach(function (s) { if (!map[s.g]) { map[s.g] = []; order.push(s.g); } map[s.g].push(s); });
      listEl.innerHTML = '';
      order.forEach(function (g) {
        var wrap = document.createElement('div');
        var hasCur = g === (TV[cur] && TV[cur].g);
        wrap.className = 'tvg' + (hasCur ? '' : ' closed');
        wrap.style.setProperty('--tvg-c', COLORS[g] || 'var(--accent)');
        var h = document.createElement('h3');
        h.innerHTML = '<span>' + escapeHtml(g) + '</span><span class="cnt">' + map[g].length + ' 个频道</span><i class="car">▾</i>';
        h.setAttribute('role', 'button');
        h.setAttribute('tabindex', '0');
        h.setAttribute('aria-expanded', hasCur ? 'true' : 'false');
        h.addEventListener('click', function () { toggleFold(wrap); });
        h.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFold(wrap); }
        });
        wrap.appendChild(h);
        var grid = document.createElement('div');
        grid.className = 'tvgrid';
        map[g].forEach(function (s) {
          var i = TV.indexOf(s);
          var b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('data-i', String(i));
          b.innerHTML = '<span class="nm">' + escapeHtml(s.n) + '</span>';
          b.addEventListener('click', function () { play(i); });
          grid.appendChild(b);
        });
        wrap.appendChild(grid);
        listEl.appendChild(wrap);
      });
      if (subEl) subEl.textContent = '直播频道 ' + TV.length + ' 个 · 点台即看';
      mark();
    }

    function openGroup(i) {                 // 播放时自动展开所在分组
      if (!listEl) return;
      var b = listEl.querySelector('button[data-i="' + i + '"]');
      if (!b) return;
      var w = b.parentNode;
      while (w && w !== listEl && !w.classList.contains('tvg')) w = w.parentNode;
      if (w && w.classList.contains('tvg') && w.classList.contains('closed')) toggleFold(w);
    }
    function loadHls(cb) {
      if (window.Hls) { cb(window.Hls); return; }
      hlsQ.push(cb);
      if (hlsLoading) return;
      hlsLoading = true;
      var s = document.createElement('script');
      s.src = 'assets/hls.min.js';
      s.onload = function () {
        hlsLoading = false;
        var q = hlsQ.slice(); hlsQ.length = 0;
        q.forEach(function (f) { f(window.Hls || null); });
      };
      s.onerror = function () {
        hlsLoading = false;
        var q = hlsQ.slice(); hlsQ.length = 0;
        q.forEach(function (f) { f(null); });
      };
      document.head.appendChild(s);
    }
    function stopHls() { if (hls) { try { hls.destroy(); } catch (e) {} hls = null; } }

    function play(i) {
      if (i < 0 || i >= TV.length) return;
      chartPause();
      radioPause();
      pauseMediaPanel();
      cur = i;
      var c = TV[i];
      if (nameEl) nameEl.textContent = c.n;
      if (cover) cover.hidden = true;
      if (liveEl) liveEl.hidden = false;
      chip('加载中…', 'warn');
      mark();
      openGroup(i);
      stopHls();
      stopFrame();
      try { video.pause(); } catch (e) {}

      if (c.f) {                                                        // 官方网页直播：内嵌播放器
        video.hidden = true;
        if (liveEl) liveEl.hidden = true;
        frame = document.createElement('iframe');
        frame.className = 'tv-frame';
        frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
        frame.setAttribute('allowfullscreen', '');
        frame.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
        frame.setAttribute('scrolling', 'no');
        frame.src = c.f;
        stage.insertBefore(frame, cover);
        chip('官方网页直播', 'ok');
        if (playBtn) playBtn.textContent = '▶';
        try { localStorage.setItem('mp_tv_last', String(i)); } catch (e) {}
        return;
      }

      video.hidden = false;
      var url = c.p ? px(c.u, c.r) : c.u;
      if (video.canPlayType('application/vnd.apple.mpegurl')) {          // Safari 原生 HLS
        video.src = url;
        var p1 = video.play();
        if (p1 && p1.catch) p1.catch(function () { chip('点播放键开始', 'warn'); });
      } else {
        loadHls(function (Hls) {
          if (!Hls) { chip('浏览器不支持 HLS', 'err'); return; }
          hls = new Hls({
            maxBufferLength: 24,
            backBufferLength: 30,
            manifestLoadingTimeOut: 15000,
            fragLoadingTimeOut: 25000
          });
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, function () {
            var p2 = video.play();
            if (p2 && p2.catch) p2.catch(function () { chip('点播放键开始', 'warn'); });
          });
          hls.on(Hls.Events.ERROR, function (evt, data) {
            if (data && data.fatal) chip('信号中断', 'err');
          });
        });
      }
      try { localStorage.setItem('mp_tv_last', String(i)); } catch (e) {}
    }

    function toggle() {
      if (cur < 0) { play(0); return; }
      if (TV[cur].f) return;                                            // 官方内嵌台由播放器自身控制
      if (video.paused) {
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        video.pause();
      }
    }

    video.addEventListener('playing', function () { chip('直播中', 'ok'); if (playBtn) playBtn.textContent = '❚❚'; });
    video.addEventListener('pause', function () {
      if (cur < 0 || TV[cur].f) return;
      chip('已暂停', '');
      if (playBtn) playBtn.textContent = '▶';
    });
    video.addEventListener('waiting', function () { if (cur >= 0 && !TV[cur].f) chip('缓冲中…', 'warn'); });
    video.addEventListener('error', function () { if (cur >= 0 && !TV[cur].f && !hls) chip('播放失败', 'err'); });

    if (playBtn) playBtn.addEventListener('click', toggle);
    var prevBtn = $('tvPrev'), nextBtn = $('tvNext');
    if (prevBtn) prevBtn.addEventListener('click', function () { play(cur < 0 ? 0 : (cur + TV.length - 1) % TV.length); });
    if (nextBtn) nextBtn.addEventListener('click', function () { play(cur < 0 ? 0 : (cur + 1) % TV.length); });
    var fullBtn = $('tvFull');
    if (fullBtn) fullBtn.addEventListener('click', function () {
      if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); return; }
      if (stage && stage.requestFullscreen) stage.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    });

    tvPauseFn = function () {
      if (video && !video.paused) { try { video.pause(); } catch (e) {} }
      stopFrame();                                                      // 内嵌台直接卸载，避免与其它模块同时出声
    };

    /* 栏目折叠（状态本地记忆，收起时暂停画面） */
    var KEY = 'mp_tv_folded';
    function paintFold(f) {
      if (!body || !foldBtn) return;
      body.classList.toggle('folded', f);
      foldBtn.textContent = f ? '展开' : '收起';
      foldBtn.setAttribute('aria-expanded', f ? 'false' : 'true');
      if (f) tvPauseFn();
    }
    var folded = false;
    try { folded = localStorage.getItem(KEY) === '1'; } catch (e) {}
    paintFold(folded);
    if (foldBtn) foldBtn.addEventListener('click', function () {
      folded = !body.classList.contains('folded');
      paintFold(folded);
      try { localStorage.setItem(KEY, folded ? '1' : '0'); } catch (e) {}
      if (!folded) {
        var sec = $('sec-tv');
        if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    paintList();
  })();
})();
